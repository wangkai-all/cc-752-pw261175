'use strict';

/**
 * Tolerance / assembly-yield workbench — HTTP server (no external deps).
 *
 * Static app in public/. JSON API in /api/*.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { normalizeScenario } = require('../core/schema');
const { attachDatasetMeans, materializeVersion, versionCost, versionFeasibility, fmt } = require('../core/params');
const { buildSampleSet, applyVersion } = require('../core/sampling');
const {
  evaluateYield,
  yieldInterval,
  stabilityCheck,
  shuffledDiagnostic,
  permutedMatrix,
  sectionData,
  failureReasons,
  pct,
} = require('../core/yield');
const { optimize, evaluateCandidate, emptyVersion, cloneVersion } = require('../core/optimize');
const { verify } = require('../core/verify');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const SCENARIO_DIR = path.join(ROOT, 'data', 'scenarios');
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 40 * 1024 * 1024) {
        reject(new Error('请求体过大（上限 40 MB）'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error(`JSON 解析失败：${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function text(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function error(res, status, message, detail) {
  json(res, status, { ok: false, error: message, detail: detail || null });
}

function prepare(scenarioInput) {
  const scenario = normalizeScenario(scenarioInput);
  attachDatasetMeans(scenario);
  return scenario;
}

function simOptions(body, scenario) {
  const o = body.options || {};
  const method = o.method || scenario.simulation.method;
  return {
    method: method === 'parametric' ? 'parametric' : 'empirical',
    draws: clampInt(o.draws, 100, 60000, scenario.simulation.drawsPerPart),
    seed: Number.isFinite(Number(o.seed)) ? Number(o.seed) : scenario.simulation.seed,
    tailMode: o.tailMode || 'normal',
    correlationShrinkage:
      o.correlationShrinkage === undefined ? scenario.simulation.correlationShrinkage : Number(o.correlationShrinkage),
    nuTail: o.nuTail ? Number(o.nuTail) : 5,
  };
}

function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function runVersion(scenario, version, options, extra = {}) {
  const sampleSet = buildSampleSet(scenario, {
    n: options.draws,
    seed: options.seed,
    method: options.method,
    tailMode: options.tailMode,
    correlationShrinkage: options.correlationShrinkage,
    nuTail: options.nuTail,
  });
  const material = materializeVersion(scenario, version || emptyVersion());
  const matrix = applyVersion(sampleSet, material.params);
  const evalRes = evaluateYield(scenario, sampleSet, matrix, { includeValues: Boolean(extra.includeValues) });
  const interval = yieldInterval(evalRes.yield, evalRes.n);
  const stability = stabilityCheck(evalRes.jointMask, evalRes.n, 10);
  const cost = versionCost(scenario, version || emptyVersion());
  const feasibility = versionFeasibility(scenario, version || emptyVersion(), scenario.budget.total);
  return {
    sampleSet,
    matrix,
    evalRes,
    interval,
    stability,
    cost,
    feasibility,
    material,
    fingerprint: material.fingerprint,
    options,
  };
}

function summarizeRun(scenario, run, version) {
  const { evalRes, interval, stability, cost, feasibility } = run;
  return {
    scenarioName: scenario.name,
    version: version || emptyVersion(),
    fingerprint: run.fingerprint,
    method: run.options.method,
    seed: run.options.seed,
    draws: evalRes.n,
    yield: evalRes.yield,
    interval,
    passed: evalRes.passed,
    failed: evalRes.failed,
    marginalProduct: evalRes.marginalProduct,
    correlationPenalty: evalRes.correlationPenalty,
    weakestConstraint: evalRes.weakestConstraint,
    failureSignatures: evalRes.failureSignatures.slice(0, 8),
    constraints: evalRes.constraints.map((c) => ({
      id: c.id,
      label: c.label,
      lower: c.lower,
      upper: c.upper,
      marginal: c.marginal,
      failCount: c.failCount,
      failLow: c.failLow,
      failHigh: c.failHigh,
      mean: c.mean,
      sd: c.sd,
      p01: c.p01,
      p50: c.p50,
      p99: c.p99,
      coverage: c.coverage,
    })),
    extrapolated: evalRes.extrapolated,
    partialCoverage: evalRes.partialCoverage,
    cost: cost.total,
    currency: cost.currency,
    costItems: cost.items,
    feasible: feasibility.feasible,
    violations: feasibility.violations,
    stability,
    warnings: run.sampleSet.warnings,
  };
}

/** Tail sensitivity: same sample size, different tail assumptions. */
function tailSensitivity(scenario, version, options) {
  const configs = [
    { key: 'empirical', label: '经验重采样（仅观测范围）', method: 'empirical', tailMode: 'normal', note: '只在已测到的零件行中重抽，不会越过观测极值。' },
    { key: 'normal', label: '参数正态', method: 'parametric', tailMode: 'normal', note: '按拟合正态分布抽样，尾部可越过观测极值。' },
    { key: 't-marginals', label: '参数 t 边际（重尾）', method: 'parametric', tailMode: 't-marginals', note: '边际换为重尾 t 分布，尾概率更高。' },
    { key: 't-copula', label: '参数 t Copula（尾相关）', method: 'parametric', tailMode: 't-copula', note: '尾部共同波动，极端零件更容易同时出现。' },
    { key: 'independent', label: '错误对照：独立重排', method: 'empirical', tailMode: 'normal', note: '把每个尺寸分别打乱，破坏零件内相关，仅供对照。' },
  ];
  const out = [];
  for (const cfg of configs) {
    if (cfg.key === 'independent') {
      const run = runVersion(scenario, version, { ...options, method: 'empirical' });
      const sh = shuffledDiagnostic(scenario, run.sampleSet, run.matrix);
      out.push({
        key: cfg.key,
        label: cfg.label,
        note: cfg.note,
        yield: sh.yield,
        interval: yieldInterval(sh.yield, run.evalRes.n),
        invalid: true,
        constraints: run.evalRes.constraints.map((c) => ({ id: c.id, marginal: c.marginal })),
      });
      continue;
    }
    const run = runVersion(scenario, version, { ...options, method: cfg.method, tailMode: cfg.tailMode });
    const sorted = [];
    for (const c of run.evalRes.constraints) {
      sorted.push({
        id: c.id,
        marginal: c.marginal,
        p01: c.p01,
        p99: c.p99,
        p01ref: c.coverage.range,
      });
    }
    out.push({
      key: cfg.key,
      label: cfg.label,
      note: cfg.note,
      yield: run.evalRes.yield,
      interval: run.interval,
      constraints: sorted,
      warnings: run.sampleSet.warnings,
    });
  }
  return out;
}

// ---------------- API handlers ----------------

function handleScenarios(req, res) {
  const files = fs.readdirSync(SCENARIO_DIR).filter((f) => f.endsWith('.json')).sort();
  const list = files.map((f) => {
    const raw = JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, f), 'utf8'));
    return {
      file: f,
      name: raw.name,
      description: raw.description || '',
      tags: (raw.meta && raw.meta.tags) || [],
      parts: raw.parts.map((p) => ({ id: p.id, label: p.label, variables: p.variables.length })),
      constraints: raw.constraints.length,
      budget: raw.budget ? raw.budget.total : 0,
    };
  });
  json(res, 200, { ok: true, scenarios: list });
}

function handleScenarioFile(req, res, file) {
  const safe = path.basename(file);
  const full = path.join(SCENARIO_DIR, safe);
  if (!full.startsWith(SCENARIO_DIR) || !fs.existsSync(full)) return error(res, 404, '方案不存在');
  const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
  json(res, 200, { ok: true, scenario: raw });
}

async function handleAnalyze(req, res) {
  const body = await readBody(req);
  const scenario = prepare(body.scenario);
  const options = simOptions(body, scenario);
  const baseVersion = body.version || emptyVersion();
  const run = runVersion(scenario, baseVersion, options);
  const summary = summarizeRun(scenario, run, baseVersion);
  const tails = scenario.simulation.tailSensitivity ? tailSensitivity(scenario, baseVersion, options) : null;

  const partSummaries = scenario.parts.map((part) => {
    const ds = scenario.datasets[part.id];
    return {
      id: part.id,
      label: part.label,
      rows: ds.rows.length,
      columns: ds.columns,
      noMeasurements: Boolean(ds.noMeasurements),
      variables: part.variables.map((v) => {
        if (v.assumed) {
          return {
            id: v.id,
            label: v.label,
            assumed: true,
            mean: v.assumed.mean,
            sd: v.assumed.sd,
            dist: v.assumed.dist,
            spec: v.spec,
            locked: v.locked,
            extrapolated: true,
          };
        }
        const ci = ds.columns.indexOf(v.id);
        const vals = ds.rows.map((r) => r[ci]).sort((a, b) => a - b);
        const q = (p) => vals[Math.floor(p * (vals.length - 1))];
        const inSpec = vals.filter(
          (x) => (v.spec?.lower === undefined || x >= v.spec.lower) && (v.spec?.upper === undefined || x <= v.spec.upper),
        ).length;
        return {
          id: v.id,
          label: v.label,
          assumed: false,
          mean: v.datasetMean,
          sd: v.datasetSd,
          min: vals[0],
          max: vals[vals.length - 1],
          p05: q(0.05),
          p50: q(0.5),
          p95: q(0.95),
          dist: v.dist,
          spec: v.spec,
          specYield: inSpec / vals.length,
          cost: v.cost,
          locked: v.locked,
          extrapolated: false,
        };
      }),
      correlations: ds.correlations || [],
    };
  });

  const involved = new Set();
  for (const c of scenario.constraints) for (const t of c.terms) involved.add(`${t.part}.${t.variable}`);
  const sectionCandidates = scenario.parts
    .flatMap((p) => p.variables.map((v) => ({ key: `${p.id}.${v.id}`, label: `${p.label} · ${v.label}`, involved: involved.has(`${p.id}.${v.id}`) })))
    .sort((a, b) => Number(b.involved) - Number(a.involved));
  const singleTermConstraints = scenario.constraints.filter((c) => c.terms.length === 1).map((c) => c.id);

  json(res, 200, {
    ok: true,
    scenario: {
      name: scenario.name,
      description: scenario.description || (body.scenario && body.scenario.description) || '',
      story: (body.scenario && body.scenario.story) || '',
      budget: scenario.budget,
      simulation: scenario.simulation,
      parts: scenario.parts.map((p) => ({ id: p.id, label: p.label })),
      constraints: scenario.constraints,
    },
    options,
    baseline: summary,
    tails,
    parts: partSummaries,
    sectionCandidates,
    singleTermConstraints,
  });
}

async function handleSimulate(req, res) {
  const body = await readBody(req);
  const scenario = prepare(body.scenario);
  const options = simOptions(body, scenario);
  const version = body.version || emptyVersion();
  const run = runVersion(scenario, version, options);
  const summary = summarizeRun(scenario, run, version);
  const failures = failureReasons(run.evalRes, run.sampleSet, run.matrix, 8);
  json(res, 200, { ok: true, result: summary, failureSample: failures.sample, versionInfo: { fingerprint: run.fingerprint } });
}

async function handleCompare(req, res) {
  const body = await readBody(req);
  const scenario = prepare(body.scenario);
  const options = simOptions(body, scenario);
  const baseVersion = body.baseVersion || emptyVersion();
  const candidateVersion = body.candidateVersion || emptyVersion();
  // Common random numbers: one sample set, both versions transformed from it.
  const sampleSet = buildSampleSet(scenario, {
    n: options.draws,
    seed: options.seed,
    method: options.method,
    tailMode: options.tailMode,
    correlationShrinkage: options.correlationShrinkage,
    nuTail: options.nuTail,
  });
  const runOf = (version) => {
    const material = materializeVersion(scenario, version);
    const matrix = applyVersion(sampleSet, material.params);
    const evalRes = evaluateYield(scenario, sampleSet, matrix);
    const cost = versionCost(scenario, version);
    const feas = versionFeasibility(scenario, version, scenario.budget.total);
    return { material, matrix, evalRes, cost, feas };
  };
  const base = runOf(baseVersion);
  const cand = runOf(candidateVersion);

  // Paired difference (per-draw pass indicator), normal CI on the mean difference.
  let sum = 0;
  let sumSq = 0;
  let bothPass = 0;
  let onlyBase = 0;
  let onlyCand = 0;
  let neither = 0;
  for (let i = 0; i < sampleSet.n; i++) {
    const b = base.evalRes.jointMask[i];
    const c = cand.evalRes.jointMask[i];
    const d = c - b;
    sum += d;
    sumSq += d * d;
    if (b && c) bothPass++;
    else if (b) onlyBase++;
    else if (c) onlyCand++;
    else neither++;
  }
  const n = sampleSet.n;
  const meanDiff = sum / n;
  const varD = Math.max(0, (sumSq - (sum * sum) / n) / (n - 1));
  const seD = Math.sqrt(varD / n);
  const z = 1.959963984540054;

  const constraints = scenario.constraints.map((c, k) => ({
    id: c.id,
    label: c.label,
    base: base.evalRes.constraints[k].marginal,
    candidate: cand.evalRes.constraints[k].marginal,
    delta: cand.evalRes.constraints[k].marginal - base.evalRes.constraints[k].marginal,
    coverage: cand.evalRes.constraints[k].coverage.status,
  }));

  json(res, 200, {
    ok: true,
    n,
    base: {
      yield: base.evalRes.yield,
      interval: yieldInterval(base.evalRes.yield, n),
      cost: base.cost.total,
      feasible: base.feas.feasible,
      violations: base.feas.violations,
      fingerprint: base.material.fingerprint,
      version: baseVersion,
      adjustments: buildAdjustments(scenario, base.material),
    },
    candidate: {
      yield: cand.evalRes.yield,
      interval: yieldInterval(cand.evalRes.yield, n),
      cost: cand.cost.total,
      feasible: cand.feas.feasible,
      violations: cand.feas.violations,
      fingerprint: cand.material.fingerprint,
      version: candidateVersion,
      adjustments: buildAdjustments(scenario, cand.material),
    },
    delta: {
      mean: meanDiff,
      se: seD,
      lo: meanDiff - z * seD,
      hi: meanDiff + z * seD,
      paired: { bothPass, onlyBase, onlyCand, neither },
    },
    constraints,
    currency: scenario.budget.currency,
    method: options.method,
    draws: options.draws,
    seed: options.seed,
  });
}

function buildAdjustments(scenario, material) {
  const out = [];
  for (const part of scenario.parts) {
    for (const v of part.variables) {
      const key = `${part.id}.${v.id}`;
      const p = material.params[key];
      if (Math.abs(p.adjShift) > 1e-9 || Math.abs(p.sigmaScale - (v.sigmaScale ?? 1)) > 1e-9) {
        out.push({
          key,
          label: `${part.label} · ${v.label}`,
          adjShift: p.adjShift,
          sigmaScale: p.sigmaScale,
          centerShift: p.centerShift,
          extrapolated: Boolean(v.assumed),
        });
      }
    }
  }
  return out;
}

async function handleVerify(req, res) {
  const body = await readBody(req);
  const scenario = prepare(body.scenario);
  const options = simOptions(body, scenario);
  const version = body.version || emptyVersion();
  const t = Date.now();
  const v = verify(scenario, version, {
    draws: options.draws,
    method: options.method,
    seed: options.seed,
    tailMode: options.tailMode,
    seeds: Number(body.seeds) || 8,
  });
  const run = runVersion(scenario, version, options);
  const shuffle = shuffledDiagnostic(scenario, run.sampleSet, run.matrix);
  v.shuffle = { yield: shuffle.yield, note: shuffle.note, valid: false };
  v.ms = Date.now() - t;
  v.draws = options.draws;
  json(res, 200, { ok: true, verification: v });
}

async function handleOptimize(req, res) {
  const body = await readBody(req);
  const scenario = prepare(body.scenario);
  const options = simOptions(body, scenario);
  const budget = body.budget === undefined ? scenario.budget.total : Number(body.budget);
  if (!Number.isFinite(budget) || budget < 0) return error(res, 400, '预算必须是非负数');
  const sampleSet = buildSampleSet(scenario, {
    n: options.draws,
    seed: options.seed,
    method: options.method,
    tailMode: options.tailMode,
    correlationShrinkage: options.correlationShrinkage,
    nuTail: options.nuTail,
  });
  const t = Date.now();
  const result = optimize(scenario, sampleSet, {
    budget,
    lockedKeys: body.lockedKeys || [],
    maxEvaluations: clampInt(body.maxEvaluations, 50, 4000, 1200),
    minGain: body.minGain,
  });
  result.ms = Date.now() - t;
  result.method = options.method;
  result.draws = options.draws;
  result.seed = options.seed;
  // Confirm the recommendation's price and simulation share the same version.
  const recMaterial = materializeVersion(scenario, result.recommended.version);
  const recCost = versionCost(scenario, result.recommended.version);
  result.costItems = recCost.items;
  result.consistency = {
    fingerprintMatches: recMaterial.fingerprint === result.recommended.fingerprint,
    cost: recCost.total,
    costMatches: Math.abs(recCost.total - result.recommended.cost) < 1e-9,
  };
  json(res, 200, { ok: true, optimization: result });
}

async function handleDistributions(req, res) {
  const body = await readBody(req);
  const scenario = prepare(body.scenario);
  const options = simOptions(body, scenario);
  const version = body.version || emptyVersion();
  const constraintId = body.constraintId;
  const constraint = scenario.constraints.find((c) => c.id === constraintId);
  if (!constraint) return error(res, 400, '未知约束');
  const maxPoints = clampInt(body.maxPoints, 100, 20000, 3000);

  const configs = body.series
    ? body.series.map((s) => ({
        key: s.key,
        label: s.label || s.key,
        method: s.method === 'parametric' ? 'parametric' : 'empirical',
        tailMode: s.tailMode || 'normal',
        invalid: Boolean(s.invalid),
      }))
    : [
        {
          key: 'current',
          label: options.method === 'empirical' ? '当前：经验重采样' : '当前：参数分布',
          method: options.method,
          tailMode: options.tailMode,
          invalid: false,
        },
        {
          key: 'normal',
          label: '参数正态',
          method: 'parametric',
          tailMode: 'normal',
          invalid: false,
        },
        {
          key: 't-copula',
          label: '参数 t Copula',
          method: 'parametric',
          tailMode: 't-copula',
          invalid: false,
        },
        {
          key: 'independent',
          label: '错误对照：独立重排',
          method: 'empirical',
          tailMode: 'normal',
          invalid: true,
        },
      ];

  const series = configs.map((cfg) => {
    const sampleSet = buildSampleSet(scenario, {
      n: options.draws,
      seed: options.seed,
      method: cfg.method,
      tailMode: cfg.tailMode,
      correlationShrinkage: options.correlationShrinkage,
      nuTail: options.nuTail,
    });
    const material = materializeVersion(scenario, version);
    let matrix = applyVersion(sampleSet, material.params);
    if (cfg.key === 'independent') matrix = permutedMatrix(sampleSet, matrix);
    const ev = evaluateYield(scenario, sampleSet, matrix, { includeValues: true });
    const k = ev.constraints.findIndex((c) => c.id === constraintId);
    const values = Array.from(ev.constraints[k].values);
    const stride = Math.max(1, Math.ceil(values.length / maxPoints));
    const sampled = [];
    for (let i = 0; i < values.length; i += stride) sampled.push(Number(values[i].toFixed(6)));
    return {
      key: cfg.key,
      label: cfg.label,
      invalid: cfg.invalid,
      method: cfg.method,
      yield: ev.yield,
      marginal: ev.constraints[k].marginal,
      values: sampled,
      n: values.length,
    };
  });

  const primaryEval = series.find((s) => !s.invalid) || series[0];
  json(res, 200, {
    ok: true,
    constraint: { id: constraint.id, label: constraint.label, lower: constraint.lower, upper: constraint.upper },
    series,
    primary: series[0] ? series[0].key : null,
    marginal: primaryEval ? primaryEval.marginal : null,
    fingerprint: materializeVersion(scenario, version).fingerprint,
  });
}

async function handleSection(req, res) {
  const body = await readBody(req);
  const scenario = prepare(body.scenario);
  const options = simOptions(body, scenario);
  const version = body.version || emptyVersion();
  const run = runVersion(scenario, version, options, { includeValues: true });
  const xKey = body.xKey;
  const yKey = body.yKey;
  const { keys } = run.sampleSet;
  if (!xKey || !yKey || keys.indexOf(xKey) < 0 || keys.indexOf(yKey) < 0) {
    return error(res, 400, '请选择两个有效的尺寸作为截面坐标轴');
  }
  if (xKey === yKey) return error(res, 400, '两个坐标轴不能是同一尺寸');
  let matrix = run.matrix;
  let fixed = null;
  if (body.fixKey) {
    const fi = keys.indexOf(body.fixKey);
    if (fi < 0) return error(res, 400, '锁定的工艺参数无效');
    const fv = Number(body.fixValue);
    if (!Number.isFinite(fv)) return error(res, 400, '锁定的工艺参数需要一个数值');
    matrix = new Float64Array(run.matrix.length);
    matrix.set(run.matrix);
    for (let i = 0; i < run.sampleSet.n; i++) matrix[i * run.sampleSet.width + fi] = fv;
    fixed = { key: body.fixKey, value: fv };
  }
  const evalRes = fixed ? evaluateYield(scenario, run.sampleSet, matrix, { includeValues: true }) : run.evalRes;
  const sec = sectionData(run.sampleSet, matrix, evalRes, xKey, yKey, Number(body.maxPoints) || 1400);
  const involved = new Set();
  for (const c of scenario.constraints) for (const t of c.terms) involved.add(`${t.part}.${t.variable}`);
  const relevant = scenario.constraints
    .filter((c) => c.terms.some((t) => `${t.part}.${t.variable}` === xKey || `${t.part}.${t.variable}` === yKey))
    .map((c) => ({ id: c.id, label: c.label, lower: c.lower, upper: c.upper, terms: c.terms }));
  json(res, 200, {
    ok: true,
    section: {
      ...sec,
      fixed,
      yield: evalRes.yield,
      constraints: evalRes.constraints.map((c) => ({ id: c.id, label: c.label, marginal: c.marginal, lower: c.lower, upper: c.upper })),
      relevantConstraints: relevant,
      axisLabels: {
        x: labelFor(scenario, xKey),
        y: labelFor(scenario, yKey),
        fix: body.fixKey ? labelFor(scenario, body.fixKey) : null,
      },
      fingerprint: run.fingerprint,
      method: options.method,
      draws: options.draws,
    },
  });
}

function labelFor(scenario, key) {
  const idx = key.indexOf('.');
  const partId = key.slice(0, idx);
  const varId = key.slice(idx + 1);
  const part = scenario.parts.find((p) => p.id === partId);
  const v = part && part.variables.find((x) => x.id === varId);
  return part && v ? `${part.label} · ${v.label}` : key;
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function handleExport(req, res) {
  const body = await readBody(req);
  const scenario = prepare(body.scenario);
  const options = simOptions(body, scenario);
  const version = body.version || emptyVersion();
  const run = runVersion(scenario, version, options, { includeValues: true });
  const limit = clampInt(body.limit, 10, 20000, 5000);

  const involved = new Set();
  for (const c of scenario.constraints) for (const t of c.terms) involved.add(`${t.part}.${t.variable}`);
  const valueKeys = Array.from(involved);
  const header = [
    'draw',
    'joint_pass',
    ...scenario.constraints.flatMap((c) => [`${c.id}_value`, `${c.id}_pass`, `${c.id}_reason`]),
    ...valueKeys,
  ];
  const lines = [header.join(',')];
  const { keys, width } = run.sampleSet;
  let written = 0;
  for (let i = 0; i < run.evalRes.n; i++) {
    if (body.onlyFailures && run.evalRes.jointMask[i]) continue;
    if (written >= limit) break;
    const row = [i, run.evalRes.jointMask[i] ? 1 : 0];
    for (let k = 0; k < run.evalRes.constraints.length; k++) {
      const c = run.evalRes.constraints[k];
      const v = c.values[i];
      let reason = '通过';
      if (c.lower !== undefined && v < c.lower) reason = `低于下界 ${c.lower}`;
      else if (c.upper !== undefined && v > c.upper) reason = `高于上界 ${c.upper}`;
      row.push(Number(v.toFixed(6)), run.evalRes.constraints[k].pass[i], reason);
    }
    for (const key of valueKeys) {
      row.push(Number(run.matrix[i * width + keys.indexOf(key)].toFixed(6)));
    }
    lines.push(row.map(csvEscape).join(','));
    written++;
  }
  const csv = '﻿' + lines.join('\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="yield-draws-${run.fingerprint}.csv"`,
    'Content-Length': Buffer.byteLength(csv),
    'Cache-Control': 'no-store',
  });
  res.end(csv);
}

async function handleRunReport(req, res) {
  const body = await readBody(req);
  const scenario = prepare(body.scenario);
  const options = simOptions(body, scenario);
  const version = body.version || emptyVersion();
  const run = runVersion(scenario, version, options);
  const summary = summarizeRun(scenario, run, version);
  const v = verify(scenario, version, { ...options, seeds: 8 });
  json(res, 200, {
    ok: true,
    report: {
      generatedAt: new Date().toISOString(),
      scenario: { name: scenario.name, parts: scenario.parts, constraints: scenario.constraints, budget: scenario.budget },
      options,
      version,
      fingerprint: run.fingerprint,
      summary,
      verification: v,
      warnings: run.sampleSet.warnings,
    },
  });
}

// ---------------- static ----------------

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = decodeURIComponent(rel);
  const full = path.join(PUBLIC, rel);
  if (!full.startsWith(PUBLIC)) return text(res, 403, 'Forbidden');
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return text(res, 404, 'Not found');
  const ext = path.extname(full).toLowerCase();
  const data = fs.readFileSync(full);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  try {
    if (pathname === '/api/health') return json(res, 200, { ok: true, now: Date.now() });
    if (pathname === '/api/scenarios' && req.method === 'GET') return handleScenarios(req, res);
    if (pathname.startsWith('/api/scenarios/') && req.method === 'GET') {
      return handleScenarioFile(req, res, pathname.slice('/api/scenarios/'.length));
    }
    if (pathname === '/api/analyze' && req.method === 'POST') return await handleAnalyze(req, res);
    if (pathname === '/api/simulate' && req.method === 'POST') return await handleSimulate(req, res);
    if (pathname === '/api/compare' && req.method === 'POST') return await handleCompare(req, res);
    if (pathname === '/api/verify' && req.method === 'POST') return await handleVerify(req, res);
    if (pathname === '/api/optimize' && req.method === 'POST') return await handleOptimize(req, res);
    if (pathname === '/api/section' && req.method === 'POST') return await handleSection(req, res);
    if (pathname === '/api/distributions' && req.method === 'POST') return await handleDistributions(req, res);
    if (pathname === '/api/export/failures' && req.method === 'POST') return await handleExport(req, res);
    if (pathname === '/api/report' && req.method === 'POST') return await handleRunReport(req, res);
    if (pathname.startsWith('/api/')) return error(res, 404, '未知接口');
    return serveStatic(req, res, pathname);
  } catch (e) {
    if (e && e.code === 'SCHEMA') return error(res, 400, `方案校验失败：${e.message}`);
    console.error(e);
    return error(res, 500, e.message || '服务器内部错误');
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`公差分析工作台: http://localhost:${PORT}`);
  });
}

module.exports = { server };
