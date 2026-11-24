'use strict';

/**
 * Scenario schema, validation and generation utilities.
 *
 * Model:
 *  - A scenario defines parts. Each part has measured variables (columns in a
 *    grouped measurement table: each row is ONE part, columns are its features).
 *    Rows must be kept as rows: within-part correlation is structural.
 *  - Manufacturing parameters (means shifts and sigma multipliers) are the only
 *    knobs adjustments may use. They transform measured data, never filter it.
 *  - Assembly constraints are declared bounds on derived quantities (linear
 *    stack-ups over part variables), each with a lower/upper limit.
 *  - Cost: each parameter has an adjustment cost model (cost per unit shift,
 *    cost per fractional sigma reduction). Budget is a hard cap.
 */

const { mean, sd, quantile, skewness, kurtosisExcess, pearson } = require('./stats');

const DIST_TYPES = ['empirical', 'normal', 't', 'lognormal'];

function err(msg, path) {
  const e = new Error(path ? `${path}: ${msg}` : msg);
  e.code = 'SCHEMA';
  throw e;
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function num(v, path, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return undefined;
    err('required numeric value missing', path);
  }
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
  if (!isNum(v)) err(`expected a finite number, got ${JSON.stringify(v)}`, path);
  if (v < min) err(`must be >= ${min}`, path);
  if (v > max) err(`must be <= ${max}`, path);
  return v;
}
function nonEmptyStr(v, path) {
  if (typeof v !== 'string' || !v.trim()) err('expected a non-empty string', path);
  return v.trim();
}
function uniqueIds(items, path) {
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.id)) err(`duplicate id "${it.id}"`, path);
    seen.add(it.id);
  }
  return seen;
}

/**
 * Validate and normalise a scenario. Throws Error with code SCHEMA on problems.
 * Returns a deep-normalised clone; never mutates input.
 */
function normalizeScenario(input) {
  if (!input || typeof input !== 'object') err('scenario must be an object');
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : '未命名方案';
  if (!Array.isArray(input.parts) || input.parts.length === 0) err('scenario.parts must be a non-empty array');
  const parts = input.parts.map((p, pi) => {
    const path = `parts[${pi}]`;
    const id = nonEmptyStr(p.id, `${path}.id`);
    const label = typeof p.label === 'string' && p.label.trim() ? p.label.trim() : id;
    if (!Array.isArray(p.variables) || p.variables.length === 0) err('variables must be a non-empty array', path);
    const variables = p.variables.map((v, vi) => {
      const vp = `${path}.variables[${vi}]`;
      const vid = nonEmptyStr(v.id, `${vp}.id`);
      const vlabel = typeof v.label === 'string' && v.label.trim() ? v.label.trim() : vid;
      const unit = typeof v.unit === 'string' ? v.unit : 'mm';
      const dist = v.dist === undefined ? 'auto' : String(v.dist);
      if (![...DIST_TYPES, 'auto'].includes(dist)) err(`dist must be one of ${[...DIST_TYPES, 'auto'].join(', ')}`, vp);
      let assumed = null;
      if (v.assumed && typeof v.assumed === 'object') {
        const ap = `${vp}.assumed`;
        const amean = num(v.assumed.mean, `${ap}.mean`);
        const asd = num(v.assumed.sd, `${ap}.sd`, { min: 0 });
        const adist = v.assumed.dist === undefined ? 'normal' : String(v.assumed.dist);
        if (!['normal', 't', 'lognormal'].includes(adist)) err('assumed.dist must be normal, t or lognormal', ap);
        const anu = num(v.assumed.nu, `${ap}.nu`, { min: 3, optional: true }) ?? 5;
        assumed = { mean: amean, sd: asd, dist: adist, nu: anu };
      }
      // Parameter defaults (manufacturing knobs)
      const centerShift = num(v.centerShift, `${vp}.centerShift`, { optional: true }) || 0;
      const sigmaScale = v.sigmaScale === undefined ? 1 : num(v.sigmaScale, `${vp}.sigmaScale`, { min: 0.05, max: 2 });
      const cost = v.cost && typeof v.cost === 'object' ? v.cost : {};
      let spec = null;
      if (v.spec && typeof v.spec === 'object') {
        const sp = `${vp}.spec`;
        const slo = num(v.spec.lower, `${sp}.lower`, { optional: true });
        const shi = num(v.spec.upper, `${sp}.upper`, { optional: true });
        if (slo !== undefined || shi !== undefined) {
          if (slo !== undefined && shi !== undefined && slo > shi) err('spec.lower must be <= spec.upper', sp);
          spec = { lower: slo, upper: shi };
        }
      }
      const costPerShift = num(cost.perShift, `${vp}.cost.perShift`, { min: 0, optional: true }) || 0;
      const costPerSigma = num(cost.perSigma, `${vp}.cost.perSigma`, { min: 0, optional: true }) || 0;
      const maxShift = num(cost.maxShift, `${vp}.cost.maxShift`, { min: 0, optional: true }) ?? 0.5;
      const minSigmaScale = num(cost.minSigmaScale, `${vp}.cost.minSigmaScale`, { min: 0.05, max: 1, optional: true }) ?? 0.5;
      return {
        id: vid,
        label: vlabel,
        unit,
        dist,
        assumed,
        spec,
        centerShift,
        sigmaScale,
        cost: { perShift: costPerShift, perSigma: costPerSigma, maxShift, minSigmaScale },
        locked: Boolean(v.locked),
      };
    });
    uniqueIds(variables, path);
    return { id, label, variables };
  });
  uniqueIds(parts, 'parts');

  const varIndex = new Map();
  for (const part of parts) for (const v of part.variables) varIndex.set(`${part.id}.${v.id}`, v);

  if (!Array.isArray(input.constraints) || input.constraints.length === 0) err('scenario.constraints must be a non-empty array');
  const constraints = input.constraints.map((c, ci) => {
    const path = `constraints[${ci}]`;
    const id = nonEmptyStr(c.id, `${path}.id`);
    const label = typeof c.label === 'string' && c.label.trim() ? c.label.trim() : id;
    if (!Array.isArray(c.terms) || c.terms.length === 0) err('terms must be a non-empty array', path);
    const terms = c.terms.map((t, ti) => {
      const tp = `${path}.terms[${ti}]`;
      const partId = nonEmptyStr(t.part, `${tp}.part`);
      const variableId = nonEmptyStr(t.variable, `${tp}.variable`);
      const key = `${partId}.${variableId}`;
      if (!varIndex.has(key)) err(`unknown variable reference "${key}"`, tp);
      const coef = num(t.coef === undefined ? 1 : t.coef, `${tp}.coef`);
      return { part: partId, variable: variableId, coef };
    });
    const lower = num(c.lower, `${path}.lower`, { optional: true });
    const upper = num(c.upper, `${path}.upper`, { optional: true });
    if (lower === undefined && upper === undefined) err('constraint needs lower and/or upper limit', path);
    if (lower !== undefined && upper !== undefined && lower > upper) err('lower must be <= upper', path);
    return { id, label, kind: c.kind ? String(c.kind) : 'assembly', terms, lower, upper };
  });
  uniqueIds(constraints, 'constraints');

  // Datasets: one measurement table per part.
  if (!input.datasets || typeof input.datasets !== 'object') err('scenario.datasets is required');
  const datasets = {};
  for (const part of parts) {
    const ds = input.datasets[part.id];
    const path = `datasets.${part.id}`;
    const measuredVars = part.variables.filter((v) => !v.assumed);
    if (measuredVars.length === 0) {
      // Every variable in this part is declared, not measured. The part carries
      // no table; all of its constraints will be flagged as extrapolated.
      datasets[part.id] = { columns: [], rows: [], correlations: [], noMeasurements: true };
      continue;
    }
    if (!ds) err('missing measurement data for part', path);
    if (!Array.isArray(ds.rows) || ds.rows.length < 3) err('need at least 3 measured rows (one row = one part)', path);
    const columns = ds.columns && Array.isArray(ds.columns) ? ds.columns.map((c, i) => nonEmptyStr(c, `${path}.columns[${i}]`)) : measuredVars.map((v) => v.id);
    for (const v of measuredVars) {
      if (!columns.includes(v.id)) err(`measurement columns missing variable "${v.id}"`, path);
    }
    const rows = ds.rows.map((r, ri) => {
      if (!Array.isArray(r) || r.length !== columns.length) err(`row ${ri} must have ${columns.length} values`, path);
      return r.map((val, ci) => num(val, `${path}.rows[${ri}][${ci}]`));
    });
    datasets[part.id] = { columns, rows };
    datasets[part.id].correlations = correlationSummary(columns, rows);
  }

  const sim = input.simulation && typeof input.simulation === 'object' ? input.simulation : {};
  const simulation = {
    seed: num(sim.seed, 'simulation.seed', { optional: true }) ?? 20261124,
    drawsPerPart: Math.round(num(sim.drawsPerPart, 'simulation.drawsPerPart', { min: 100, max: 200000, optional: true }) ?? 4000),
    method: ['empirical', 'parametric'].includes(sim.method) ? sim.method : 'empirical',
    correlationShrinkage: num(sim.correlationShrinkage, 'simulation.correlationShrinkage', { min: 0, max: 1, optional: true }) ?? 0.15,
    tailSensitivity: sim.tailSensitivity !== false,
  };

  const budget = input.budget && typeof input.budget === 'object' ? input.budget : {};
  const budgetNorm = {
    total: num(budget.total, 'budget.total', { min: 0, optional: true }) ?? 0,
    currency: typeof budget.currency === 'string' && budget.currency.trim() ? budget.currency.trim() : '元',
  };

  return { name, parts, constraints, datasets, simulation, budget: budgetNorm, meta: { ...(input.meta || {}) } };
}

/** Descriptive summary used in the UI and report. */
function describeColumn(values, requestedDist) {
  const n = values.length;
  const m = mean(values);
  const s = sd(values);
  const skew = skewness(values);
  const kurt = kurtosisExcess(values);
  let dist = requestedDist && requestedDist !== 'auto' ? requestedDist : 'normal';
  if (!requestedDist || requestedDist === 'auto') {
    if (n >= 8 && Math.abs(skew) > 1.0) dist = 't';
    if (values.some((v) => v <= 0)) dist = 'normal';
  }
  if (dist === 'lognormal' && values.some((v) => v <= 0)) dist = 'normal';
  return {
    n,
    mean: m,
    sd: s,
    min: quantile(values, 0),
    p05: quantile(values, 0.05),
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    max: quantile(values, 1),
    skewness: skew,
    kurtosis: kurt,
    dist,
    unit: 'mm',
  };
}

/** Pairwise Pearson correlation summary for one part's columns. */
function correlationSummary(columns, rows) {
  const p = columns.length;
  const out = [];
  for (let i = 0; i < p; i++) {
    for (let j = i + 1; j < p; j++) {
      out.push({ a: columns[i], b: columns[j], r: pearson(rows.map((r) => r[i]), rows.map((r) => r[j])) });
    }
  }
  return out;
}

module.exports = { normalizeScenario, describeColumn, correlationSummary, DIST_TYPES };
