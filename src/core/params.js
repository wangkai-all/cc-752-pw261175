'use strict';

/**
 * Manufacturing parameter versions.
 *
 * A version is a set of *adjustments* to the current process parameters:
 *   { shifts: { "part.var": mm }, sigmas: { "part.var": multiplier } }
 *
 * effective = scenario base + adjustment.
 *
 * Every simulation, cost calculation and feasibility check goes through
 * materializeVersion(), the single source of truth. Nothing prices one version
 * and simulates another. The returned fingerprint identifies the exact parameter
 * set and is echoed on every run for audit.
 */

function allKeys(scenario) {
  const keys = [];
  for (const part of scenario.parts) for (const v of part.variables) keys.push(`${part.id}.${v.id}`);
  return keys;
}

function splitKey(key) {
  const idx = key.indexOf('.');
  return [key.slice(0, idx), key.slice(idx + 1)];
}

function variableOf(scenario, key) {
  const idx = key.indexOf('.');
  const partId = key.slice(0, idx);
  const variableId = key.slice(idx + 1);
  const part = scenario.parts.find((p) => p.id === partId);
  if (!part) return null;
  const variable = part.variables.find((v) => v.id === variableId);
  if (!variable) return null;
  return { part, variable };
}

function scenarioFingerprint(scenario) {
  const parts = scenario.parts.map((p) => ({
    id: p.id,
    vars: p.variables.map((v) => [v.id, v.assumed ? ['assumed', v.assumed.mean, v.assumed.sd, v.assumed.dist] : null, v.centerShift, v.sigmaScale, v.cost]),
  }));
  return require('./rng').hashString(
    JSON.stringify({
      name: scenario.name,
      parts,
      constraints: scenario.constraints,
      rows: scenario.parts.map((p) => scenario.datasets[p.id].rows.map((r) => r.join(','))),
    }),
  );
}

function round9(x) {
  return Math.round(x * 1e9) / 1e9;
}

function materializeVersion(scenario, version) {
  const v = version || {};
  const shifts = v.shifts || {};
  const sigmas = v.sigmas || {};
  const params = {};
  const keys = allKeys(scenario);
  for (const part of scenario.parts) {
    for (const variable of part.variables) {
      const key = `${part.id}.${variable.id}`;
      const adjShift = Number(shifts[key] || 0);
      const adjSigma = sigmas[key] === undefined ? 1 : Number(sigmas[key]);
      const centerShift = variable.centerShift + adjShift;
      const sigmaScale = (variable.sigmaScale ?? 1) * adjSigma;
      const baseMean = variable.assumed ? variable.assumed.mean : variable.datasetMean;
      const baseSd = variable.assumed ? variable.assumed.sd : variable.datasetSd;
      params[key] = {
        key,
        partId: part.id,
        variableId: variable.id,
        mean: baseMean,
        sd: baseSd,
        centerShift,
        sigmaScale,
        adjShift,
        adjSigma,
        maxShift: variable.cost.maxShift,
        minSigmaScale: variable.cost.minSigmaScale,
        extrapolated: Boolean(variable.assumed),
      };
    }
  }
  const fingerprint = require('./rng').hashString(
    JSON.stringify({
      scenario: scenarioFingerprint(scenario),
      params: keys.map((k) => [k, round9(params[k].centerShift), round9(params[k].sigmaScale)]),
    }),
  );
  return { params, keys, fingerprint };
}

function fmt(x) {
  if (!Number.isFinite(x)) return String(x);
  const abs = Math.abs(x);
  if (abs !== 0 && abs < 0.001) return x.toExponential(2);
  return String(Math.round(x * 1e6) / 1e6);
}

/** Cost of a version relative to the current (base) process. */
function versionCost(scenario, version) {
  const { params } = materializeVersion(scenario, version);
  let total = 0;
  const items = [];
  for (const key of Object.keys(params)) {
    const p = params[key];
    const ref = variableOf(scenario, key);
    const variable = ref.variable;
    const shiftCost = variable.cost.perShift * Math.abs(p.adjShift);
    const sigmaReduction = Math.max(0, (variable.sigmaScale ?? 1) - p.sigmaScale);
    const sigmaCost = variable.cost.perSigma * sigmaReduction;
    const cost = shiftCost + sigmaCost;
    total += cost;
    if (cost > 1e-9) {
      items.push({
        key,
        part: ref.part.id,
        variable: variable.id,
        label: `${ref.part.label} · ${variable.label}`,
        shift: p.adjShift,
        sigmaScale: p.sigmaScale,
        sigmaReduction,
        shiftCost,
        sigmaCost,
        cost,
      });
    }
  }
  return { total, items, currency: scenario.budget.currency };
}

/** Feasibility of a version against per-variable adjustment limits and budget. */
function versionFeasibility(scenario, version, budgetTotal) {
  const { params } = materializeVersion(scenario, version);
  const violations = [];
  for (const key of Object.keys(params)) {
    const p = params[key];
    const ref = variableOf(scenario, key);
    const variable = ref.variable;
    if (Math.abs(p.centerShift) > variable.cost.maxShift + 1e-12) {
      violations.push(`${key}: 中心偏移 ${fmt(p.centerShift)} 超出加工可调范围 ±${fmt(variable.cost.maxShift)} mm`);
    }
    if (p.sigmaScale < variable.cost.minSigmaScale - 1e-12) {
      violations.push(`${key}: 标准差倍率 ${fmt(p.sigmaScale)} 低于工艺可达下限 ${fmt(variable.cost.minSigmaScale)}`);
    }
    if (p.sigmaScale > (variable.sigmaScale ?? 1) + 1e-12) {
      violations.push(`${key}: 标准差倍率 ${fmt(p.sigmaScale)} 超出当前水平（本工具只考虑收紧，不允许放大）`);
    }
  }
  const cost = versionCost(scenario, version);
  if (budgetTotal !== undefined && cost.total > budgetTotal + 1e-9) {
    violations.push(`调整成本 ${fmt(cost.total)} 超出预算 ${fmt(budgetTotal)} ${scenario.budget.currency}`);
  }
  return { feasible: violations.length === 0, violations, cost: cost.total };
}

/** Attach measurement means/sds to variables (mutates the normalized clone). */
function attachDatasetMeans(scenario) {
  for (const part of scenario.parts) {
    const ds = scenario.datasets[part.id];
    for (const variable of part.variables) {
      if (variable.assumed) {
        variable.datasetMean = variable.assumed.mean;
        variable.datasetSd = variable.assumed.sd;
        variable.extrapolated = true;
        continue;
      }
      const idx = ds.columns.indexOf(variable.id);
      let s = 0;
      for (const row of ds.rows) s += row[idx];
      variable.datasetMean = s / ds.rows.length;
      let q = 0;
      for (const row of ds.rows) q += (row[idx] - variable.datasetMean) ** 2;
      variable.datasetSd = Math.sqrt(q / Math.max(1, ds.rows.length - 1));
      variable.extrapolated = false;
    }
  }
  return scenario;
}

module.exports = {
  allKeys,
  splitKey,
  variableOf,
  materializeVersion,
  versionCost,
  versionFeasibility,
  attachDatasetMeans,
  scenarioFingerprint,
  fmt,
  round9,
};
