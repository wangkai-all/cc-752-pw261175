'use strict';

/**
 * Verification / cross-checks.
 *
 *  - Exact enumeration (empirical model): when the joint support is small,
 *    enumerate every combination of measured rows and compute yield exactly.
 *    This is the ground truth for the empirical bootstrap, free of MC error.
 *  - Deterministic 2-D quadrature: when constraints involve at most two
 *    dimensions and all marginals are normal (fitted normal or assumed), the
 *    joint yield is a 2-D integral of a Gaussian density; evaluate on a fine
 *    grid with correlation included.
 *  - Stability: across seeds and across sample sizes.
 *
 * The cross-checks are diagnostic. They never replace the reported simulation;
 * they tell you whether to trust it.
 */

const { buildSampleSet, applyVersion } = require('./sampling');
const { materializeVersion, variableOf } = require('./params');
const { evaluateYield } = require('./yield');
const { chi2Cdf } = require('./stats');

function runOnce(scenario, version, options = {}) {
  const method = options.method || scenario.simulation.method;
  const draws = options.draws || scenario.simulation.drawsPerPart;
  const seed = options.seed === undefined ? scenario.simulation.seed : options.seed;
  const sampleSet = buildSampleSet(scenario, {
    n: draws,
    seed,
    method,
    tailMode: options.tailMode || 'normal',
    correlationShrinkage:
      options.correlationShrinkage === undefined ? scenario.simulation.correlationShrinkage : options.correlationShrinkage,
    nuTail: options.nuTail || 5,
  });
  const material = materializeVersion(scenario, version);
  const matrix = applyVersion(sampleSet, material.params);
  const evalRes = evaluateYield(scenario, sampleSet, matrix);
  return { sampleSet, matrix, evalRes, fingerprint: material.fingerprint, warnings: sampleSet.warnings };
}

function involvedKeys(scenario) {
  const keys = new Set();
  for (const c of scenario.constraints) for (const t of c.terms) keys.add(`${t.part}.${t.variable}`);
  return Array.from(keys);
}

function isAssumed(scenario, key) {
  const ref = variableOf(scenario, key);
  return Boolean(ref && ref.variable.assumed);
}

function rowMean(scenario, partId, variableId) {
  const ds = scenario.datasets[partId];
  const idx = ds.columns.indexOf(variableId);
  if (idx < 0) return null;
  let s = 0;
  for (const r of ds.rows) s += r[idx];
  return s / ds.rows.length;
}

/** Exact enumeration over measured rows of the parts referenced by constraints. */
function enumerateEmpirical(scenario, version, limit = 1500000) {
  const keys = involvedKeys(scenario);
  const assumed = keys.filter((k) => isAssumed(scenario, k));
  if (assumed.length) {
    return {
      applicable: false,
      reason: `涉及未测量（外推）尺寸 ${assumed.join('、')}，经验模型没有可穷举的离散支撑集。`,
    };
  }
  const partsUsed = scenario.parts.filter((p) =>
    p.variables.some((v) => keys.includes(`${p.id}.${v.id}`)),
  );
  let combos = 1;
  for (const p of partsUsed) {
    combos *= scenario.datasets[p.id].rows.length;
    if (combos > limit) {
      return {
        applicable: false,
        reason: `组合数 ${combos.toLocaleString()} 超过穷举上限 ${limit.toLocaleString()}；请用数值积分或蒙特卡洛稳定性对照。`,
      };
    }
  }

  const material = materializeVersion(scenario, version);
  const allKeys = require('./params').allKeys(scenario);
  const width = allKeys.length;
  const matrix = new Float64Array(combos * width);
  // fill baseline values: measured mean for all, or assumed mean
  for (let j = 0; j < width; j++) {
    const ref = variableOf(scenario, allKeys[j]);
    const val = ref.variable.assumed ? ref.variable.assumed.mean : ref.variable.datasetMean;
    for (let i = 0; i < combos; i++) matrix[i * width + j] = val;
  }
  // enumerate combinations only over partsUsed
  const perPart = partsUsed.map((p) => {
    const ds = scenario.datasets[p.id];
    return {
      partId: p.id,
      ds,
      vars: p.variables.filter((v) => !v.assumed && keys.includes(`${p.id}.${v.id}`)),
    };
  });
  const counters = new Array(perPart.length).fill(0);
  for (let i = 0; i < combos; i++) {
    let rem = i;
    const off = i * width;
    for (let k = perPart.length - 1; k >= 0; k--) {
      const pp = perPart[k];
      const nRows = pp.ds.rows.length;
      const r = rem % nRows;
      rem = Math.floor(rem / nRows);
      const row = pp.ds.rows[r];
      for (const v of pp.vars) {
        const ci = pp.ds.columns.indexOf(v.id);
        matrix[off + allKeys.indexOf(`${pp.partId}.${v.id}`)] = row[ci];
      }
    }
  }
  const transformed = applyVersion(
    { n: combos, width, keys: allKeys, base: matrix },
    material.params,
  );
  const { buildSupports } = require('./sampling');
  const res = evaluateYield(scenario, { n: combos, width, keys: allKeys, supports: buildSupports(scenario) }, transformed);
  return {
    applicable: true,
    combinations: combos,
    yield: res.yield,
    constraints: res.constraints.map((c) => ({ id: c.id, marginal: c.marginal })),
    fingerprint: material.fingerprint,
  };
}

function marginalForQuad(scenario, key, params) {
  const ref = variableOf(scenario, key);
  const v = ref.variable;
  const p = params[key];
  let kind = 'normal';
  if (v.assumed) {
    kind = v.assumed.dist;
  } else if (v.dist && v.dist !== 'auto' && v.dist !== 'normal') {
    kind = v.dist;
  }
  return { key, kind, mean: p.mean + p.centerShift, sd: p.sd * p.sigmaScale };
}

function pairCorrelation(scenario, k1, k2) {
  const ref1 = variableOf(scenario, k1);
  const ref2 = variableOf(scenario, k2);
  if (!ref1 || !ref2 || ref1.part.id !== ref2.part.id) return 0;
  if (ref1.variable.assumed || ref2.variable.assumed) return 0;
  const ds = scenario.datasets[ref1.part.id];
  const c1 = ds.columns.indexOf(ref1.variable.id);
  const c2 = ds.columns.indexOf(ref2.variable.id);
  let s1 = 0;
  let s2 = 0;
  for (const r of ds.rows) {
    s1 += r[c1];
    s2 += r[c2];
  }
  const m1 = s1 / ds.rows.length;
  const m2 = s2 / ds.rows.length;
  let cov = 0;
  let q1 = 0;
  let q2 = 0;
  for (const r of ds.rows) {
    cov += (r[c1] - m1) * (r[c2] - m2);
    q1 += (r[c1] - m1) ** 2;
    q2 += (r[c2] - m2) ** 2;
  }
  return q1 > 0 && q2 > 0 ? cov / Math.sqrt(q1 * q2) : 0;
}

function inBounds(v, c) {
  if (c.lower !== undefined && v < c.lower) return false;
  if (c.upper !== undefined && v > c.upper) return false;
  return true;
}

/**
 * Deterministic quadrature over the involved dimensions.
 * Applies when ≤ 2 involved dims and all marginals normal (or assumed normal).
 * For >2 dims we report "not applicable" rather than pretending.
 */
function quadrature(scenario, version, grid = 321) {
  const keys = involvedKeys(scenario);
  if (keys.length === 0) return { applicable: false, reason: '没有约束项。' };
  if (keys.length > 2) {
    return {
      applicable: false,
      reason: `约束共涉及 ${keys.length} 个尺寸，二维数值积分不适用；本工具的解析对照只覆盖 ≤2 维。`,
    };
  }
  const material = materializeVersion(scenario, version);
  const marg = keys.map((k) => marginalForQuad(scenario, k, material.params));
  const nonNormal = marg.filter((m) => m.kind !== 'normal' && m.kind !== 'lognormal');
  if (nonNormal.length) {
    return {
      applicable: false,
      reason: `边际分布为 ${nonNormal.map((m) => `${m.key}:${m.kind}`).join('、')}，不是正态族；请用穷举（经验模型）或稳定性对照。`,
    };
  }
  if (marg.some((m) => !(m.sd > 0))) {
    return { applicable: false, reason: '存在标准差为 0 的尺寸，积分退化。' };
  }
  if (marg.some((m) => m.kind === 'lognormal')) {
    // lognormal: integrate over its own density via the latent normal (copula)
    // handled below by transforming each quadrature node through exp().
  }

  const rho = keys.length === 2 ? pairCorrelation(scenario, keys[0], keys[1]) : 0;

  function toValue(m, z) {
    if (m.kind === 'lognormal') {
      // treat fitted lognormal through its normal latent: mean/sd given, use
      // moment-matched lognormal parameters
      const cv2 = (m.sd / m.mean) ** 2;
      if (!(cv2 < 1)) return NaN;
      const mu = Math.log(m.mean) - 0.5 * Math.log(1 + cv2);
      const sig = Math.sqrt(Math.log(1 + cv2));
      return Math.exp(mu + sig * z);
    }
    return m.mean + m.sd * z;
  }

  let passed = 0;
  let total = 0;
  const Z_MAX = 5.5;
  if (keys.length === 1) {
    const m = marg[0];
    for (let i = 0; i < grid; i++) {
      const z = -Z_MAX + (2 * Z_MAX * i) / (grid - 1);
      const w = Math.exp(-0.5 * z * z);
      total += w;
      const x = toValue(m, z);
      let ok = true;
      for (const c of scenario.constraints) {
        let acc = 0;
        for (const t of c.terms) acc += t.coef * x;
        if (!inBounds(acc, c)) {
          ok = false;
          break;
        }
      }
      if (ok) passed += w;
    }
    return { applicable: true, dimensions: 1, yield: passed / total, rho, grid, marginals: marg };
  }

  const m1 = marg[0];
  const m2 = marg[1];
  const det = 1 - rho * rho;
  if (!(det > 1e-10)) {
    return { applicable: false, reason: '两尺寸相关系数接近 ±1，二维积分退化；请使用蒙特卡洛。' };
  }
  const dz = (2 * Z_MAX) / (grid - 1);
  for (let i = 0; i < grid; i++) {
    const z1 = -Z_MAX + i * dz;
    const x = toValue(m1, z1);
    for (let j = 0; j < grid; j++) {
      const z2 = -Z_MAX + j * dz;
      const w = Math.exp(-(z1 * z1 - 2 * rho * z1 * z2 + z2 * z2) / (2 * det));
      total += w;
      const y = toValue(m2, z2);
      let ok = true;
      for (const c of scenario.constraints) {
        let acc = 0;
        for (const t of c.terms) {
          const key = `${t.part}.${t.variable}`;
          const val = key === keys[0] ? x : key === keys[1] ? y : 0;
          acc += t.coef * val;
        }
        if (!inBounds(acc, c)) {
          ok = false;
          break;
        }
      }
      if (ok) passed += w;
    }
  }
  // only constraints over the two keys are supported in this branch
  const otherKeys = new Set();
  for (const c of scenario.constraints)
    for (const t of c.terms) {
      const key = `${t.part}.${t.variable}`;
      if (key !== keys[0] && key !== keys[1]) otherKeys.add(key);
    }
  if (otherKeys.size) {
    return { applicable: false, reason: '约束包含额外尺寸，二维积分不适用。' };
  }
  return { applicable: true, dimensions: 2, yield: passed / total, rho, grid, marginals: marg };
}

/** Compare MC to the analytic references and classify agreement. */
function verify(scenario, version, options = {}) {
  const draws = options.draws || scenario.simulation.drawsPerPart;
  const method = options.method || scenario.simulation.method;
  const run = runOnce(scenario, version, { ...options, draws });
  const mcYield = run.evalRes.yield;
  const se = Math.sqrt((mcYield * (1 - mcYield)) / draws);
  const enumRes = enumerateEmpirical(scenario, version, options.enumLimit || 1500000);
  const quadRes = quadrature(scenario, version, options.grid || 321);

  if (enumRes.applicable) {
    enumRes.comparison = {
      mcYield,
      diff: mcYield - enumRes.yield,
      tolerance: 4 * se + 0.0005,
      agree: Math.abs(mcYield - enumRes.yield) <= 4 * se + 0.0005,
    };
  }
  if (quadRes.applicable) {
    quadRes.comparison = {
      mcYield,
      diff: mcYield - quadRes.yield,
      tolerance: 4 * se + 0.001,
      agree: Math.abs(mcYield - quadRes.yield) <= 4 * se + 0.001,
    };
  }

  const seedStability = stabilityAcrossSeeds(scenario, version, {
    seeds: options.seeds || 8,
    draws,
    method,
    seed: options.seed,
    tailMode: options.tailMode,
  });
  const convergence = convergenceBySize(scenario, version, {
    sizes: options.sizes || [250, 500, 1000, 2000, 4000, 8000],
    method,
    seed: options.seed,
    tailMode: options.tailMode,
    maxDraws: options.maxDraws || 20000,
  });

  const notes = [];
  if (enumRes.applicable) {
    notes.push(
      `穷举（经验模型精确解）：${fmtPct(enumRes.yield)}；本次抽样：${fmtPct(mcYield)}；差 ${fmtDiff(enumRes.comparison.diff)}。${
        enumRes.comparison.agree ? '在抽样误差内一致。' : '超出抽样误差，需增加抽样数或检查代码。'
      }`,
    );
  } else {
    notes.push(`穷举对照不适用：${enumRes.reason}`);
  }
  if (quadRes.applicable) {
    notes.push(
      `${quadRes.dimensions} 维数值积分（正态族，含相关系数 ${quadRes.rho.toFixed(3)}）：${fmtPct(quadRes.yield)}；本次抽样：${fmtPct(mcYield)}；差 ${fmtDiff(quadRes.comparison.diff)}。${
        quadRes.comparison.agree ? '在抽样误差内一致。' : '差异偏大，请检查分布假设或抽样数。'
      }`,
    );
  } else {
    notes.push(`数值积分对照不适用：${quadRes.reason}`);
  }
  notes.push(
    `${seedStability.seeds} 个随机种子合格率范围 ${fmtPct(seedStability.min)} – ${fmtPct(seedStability.max)}，${
      seedStability.consistent ? '波动与二项抽样误差相符。' : '波动偏大，当前抽样数不足，结论不稳。'
    }`,
  );

  return {
    mc: {
      yield: mcYield,
      n: draws,
      method,
      se,
      interval: [Math.max(0, mcYield - 1.96 * se), Math.min(1, mcYield + 1.96 * se)],
      constraints: run.evalRes.constraints.map((c) => ({ id: c.id, marginal: c.marginal })),
      warnings: run.warnings,
    },
    enumeration: enumRes,
    quadrature: quadRes,
    seedStability,
    convergence,
    notes,
  };
}

function stabilityAcrossSeeds(scenario, version, options = {}) {
  const seeds = options.seeds || 8;
  const draws = options.draws || scenario.simulation.drawsPerPart;
  const method = options.method || scenario.simulation.method;
  const baseSeed = options.seed === undefined ? scenario.simulation.seed : options.seed;
  const yields = [];
  for (let s = 0; s < seeds; s++) {
    const run = runOnce(scenario, version, { ...options, seed: baseSeed + s * 7919, draws, method });
    yields.push(run.evalRes.yield);
  }
  const m = yields.reduce((a, b) => a + b, 0) / yields.length;
  const variance = yields.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, yields.length - 1);
  const se = Math.sqrt(Math.max(0, (m * (1 - m)) / draws));
  const spread = Math.max(...yields) - Math.min(...yields);
  return {
    seeds,
    draws,
    yields,
    mean: m,
    sd: Math.sqrt(variance),
    min: Math.min(...yields),
    max: Math.max(...yields),
    spread,
    se,
    consistent: spread <= Math.max(4.5 * se, 0.005),
  };
}

function convergenceBySize(scenario, version, options = {}) {
  const sizes = options.sizes || [250, 500, 1000, 2000, 4000, 8000];
  const method = options.method || scenario.simulation.method;
  const seed = options.seed === undefined ? scenario.simulation.seed : options.seed;
  const out = [];
  for (const draws of sizes) {
    if (draws > (options.maxDraws || 20000)) continue;
    const run = runOnce(scenario, version, { ...options, seed, draws, method });
    const y = run.evalRes.yield;
    out.push({ draws, yield: y, se: Math.sqrt(Math.max(0, (y * (1 - y)) / draws)) });
  }
  return out;
}

function fmtPct(x) {
  return `${(x * 100).toFixed(2)}%`;
}
function fmtDiff(x) {
  const v = x * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(3)} 个百分点`;
}

module.exports = {
  runOnce,
  verify,
  enumerateEmpirical,
  quadrature,
  stabilityAcrossSeeds,
  convergenceBySize,
  involvedKeys,
};
