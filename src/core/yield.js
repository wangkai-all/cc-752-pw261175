'use strict';

/**
 * Constraint evaluation, yield estimation, coverage and stability.
 *
 * Each assembly constraint is a linear stack-up: value = sum(coef * x_var).
 * Every draw gets every constraint evaluated. Assembly success requires ALL
 * constraints to pass simultaneously — the joint yield. We explicitly compare
 * it to the product of marginal yields to expose the correlation trap: several
 * dimensions can each look fine while the assembled product fails.
 */

const { mean, sd, quantile } = require('./stats');
const { splitKey } = require('./params');

/** Evaluate one linear constraint over all draws. */
function constraintValues(constraint, sampleSet, matrix) {
  const { keys, width, n } = sampleSet;
  const terms = [];
  for (const term of constraint.terms) {
    const key = `${term.part}.${term.variable}`;
    const idx = keys.indexOf(key);
    if (idx < 0) throw new Error(`constraint ${constraint.id} references unknown variable ${key}`);
    terms.push({ idx, coef: term.coef });
  }
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const off = i * width;
    let acc = 0;
    for (const { idx, coef } of terms) acc += coef * matrix[off + idx];
    values[i] = acc;
  }
  return { values, terms };
}

function classify(value, constraint) {
  if (constraint.lower !== undefined && value < constraint.lower) return 'low';
  if (constraint.upper !== undefined && value > constraint.upper) return 'high';
  return 'ok';
}

/**
 * Coverage of a constraint by the training data.
 * - If any participating variable is assumed (no measurements), the constraint
 *   is extrapolated by definition. No amount of simulation fixes that.
 * - Otherwise count draws that leave the observed per-variable min/max range.
 *   Parametric models produce tails beyond observed data; we report the share.
 */
function constraintCoverage(constraint, sampleSet, matrix) {
  const { keys, width, n, supports } = sampleSet;
  const assumed = [];
  const outsideByVar = {};
  const terms = constraint.terms.map((t) => {
    const key = `${t.part}.${t.variable}`;
    const idx = keys.indexOf(key);
    const sup = supports[key];
    if (sup && sup.assumed) assumed.push(key);
    outsideByVar[key] = 0;
    return { key, idx, sup };
  });
  let outside = 0;
  for (let i = 0; i < n; i++) {
    const off = i * width;
    let any = false;
    for (const t of terms) {
      if (!t.sup || t.sup.assumed) continue;
      const x = matrix[off + t.idx];
      if (x < t.sup.lo || x > t.sup.hi) {
        outsideByVar[t.key]++;
        any = true;
      }
    }
    if (any) outside++;
  }
  const outsideFraction = n ? outside / n : 0;
  let status = 'covered';
  let reason = '';
  if (assumed.length) {
    status = 'extrapolated';
    reason = `含无测量数据的尺寸：${assumed.join('、')}；按声明分布外推，结果缺少数据支撑。`;
  } else if (outsideFraction > 0.02) {
    status = 'partial';
    reason = `${(outsideFraction * 100).toFixed(1)}% 的抽样超出测量范围（参数模型尾部）；结论在尾部属于外推。`;
  }
  return {
    status,
    reason,
    assumedVariables: assumed,
    outsideFraction,
    outsideByVariable: outsideByVar,
    range: terms
      .filter((t) => t.sup && !t.sup.assumed)
      .map((t) => ({ key: t.key, lo: t.sup.lo, hi: t.sup.hi })),
  };
}

/**
 * Main evaluation.
 * options.includeValues keeps per-constraint value arrays (needed for CSV export).
 */
function evaluateYield(scenario, sampleSet, matrix, options = {}) {
  const { n } = sampleSet;
  const evaluated = [];
  for (const c of scenario.constraints) {
    const { values } = constraintValues(c, sampleSet, matrix);
    const pass = new Uint8Array(n);
    let p = 0;
    let low = 0;
    let high = 0;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      const cls = classify(v, c);
      if (cls === 'ok') p++;
      else if (cls === 'low') low++;
      else high++;
      pass[i] = cls === 'ok' ? 1 : 0;
    }
    evaluated.push({ constraint: c, values, pass, marginal: p / n, failLow: low, failHigh: high });
  }

  const jointMask = new Uint8Array(n);
  let passed = 0;
  for (let i = 0; i < n; i++) {
    let ok = 1;
    for (const e of evaluated) ok &= e.pass[i];
    jointMask[i] = ok;
    if (ok) passed++;
  }
  const jointYield = passed / n;
  const marginalProduct = evaluated.reduce((s, e) => s * e.marginal, 1);
  const weakest = evaluated.reduce((a, b) => (a.marginal <= b.marginal ? a : b), evaluated[0]);

  // unique failure signatures: which combination of constraints failed
  const signatureCounts = new Map();
  for (let i = 0; i < n; i++) {
    if (jointMask[i]) continue;
    let sig = '';
    for (let k = 0; k < evaluated.length; k++) if (!evaluated[k].pass[i]) sig += `${k},`;
    signatureCounts.set(sig, (signatureCounts.get(sig) || 0) + 1);
  }
  const failureSignatures = Array.from(signatureCounts.entries())
    .map(([sig, count]) => ({
      constraints: sig
        .split(',')
        .filter(Boolean)
        .map((k) => evaluated[Number(k)].constraint.id),
      count,
      share: count / Math.max(1, n - passed),
    }))
    .sort((a, b) => b.count - a.count);

  const coverageAll = evaluated.map((e) => constraintCoverage(e.constraint, sampleSet, matrix));
  const extrapolated = coverageAll.some((c) => c.status === 'extrapolated');
  const partial = coverageAll.some((c) => c.status === 'partial');

  return {
    n,
    yield: jointYield,
    passed,
    failed: n - passed,
    jointMask,
    marginalProduct,
    correlationPenalty: marginalProduct - jointYield,
    weakestConstraint: weakest.constraint.id,
    failureSignatures,
    extrapolated,
    partialCoverage: partial,
    coverage: extrapolated ? 0 : 1,
    constraints: evaluated.map((e, k) => {
      const arr = options.includeValues ? e.values : null;
      return {
        id: e.constraint.id,
        label: e.constraint.label,
        lower: e.constraint.lower,
        upper: e.constraint.upper,
        marginal: e.marginal,
        failCount: n - Math.round(e.marginal * n),
        failLow: e.failLow,
        failHigh: e.failHigh,
        mean: mean(e.values),
        sd: sd(e.values),
        p01: quantile(e.values, 0.01),
        p50: quantile(e.values, 0.5),
        p99: quantile(e.values, 0.99),
        coverage: coverageAll[k],
        pass: e.pass,
        values: arr,
      };
    }),
  };
}

/** Yield confidence interval for a proportion (Wilson score). */
function yieldInterval(p, n, z = 1.959963984540054) {
  if (!n) return { lo: NaN, hi: NaN, se: NaN };
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return {
    lo: Math.max(0, center - half),
    hi: Math.min(1, center + half),
    se: Math.sqrt((p * (1 - p)) / n),
  };
}

/** Batch-means stability: split draws into chunks, compare spread to binomial. */
function stabilityCheck(jointMask, n, chunks = 10) {
  const size = Math.floor(n / chunks);
  const rates = [];
  for (let c = 0; c < chunks; c++) {
    const start = c * size;
    const end = c === chunks - 1 ? n : (c + 1) * size;
    let p = 0;
    for (let i = start; i < end; i++) p += jointMask[i];
    if (end > start) rates.push(p / (end - start));
  }
  const m = mean(rates);
  const s = sd(rates);
  const binomSe = Math.sqrt(Math.max(0, (m * (1 - m)) / Math.max(1, size)));
  const ratio = binomSe > 0 ? s / binomSe : 1;
  return {
    chunkSize: size,
    rates,
    mean: m,
    sd: s,
    binomialSe: binomSe,
    ratio,
    stable: binomSe > 0 ? ratio < 2.5 : true,
  };
}

/**
 * Deliberately wrong comparison: independently permute each dimension, then
 * re-evaluate. Shows how much joint yield changes when within-part correlation
 * is destroyed. This is a diagnostic, never a valid model.
 */
function permutedMatrix(sampleSet, matrix, seed = 12345) {
  const { n, width } = sampleSet;
  const { mulberry32 } = require('./rng');
  const shuffled = new Float64Array(n * width);
  for (let j = 0; j < width; j++) {
    // Independent permutation per column: this is exactly the error we warn
    // about. Different RNG stream per column so correlations are destroyed.
    const rand = mulberry32((seed + j * 7919) >>> 0);
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const k = Math.floor(rand() * (i + 1));
      [idx[i], idx[k]] = [idx[k], idx[i]];
    }
    for (let i = 0; i < n; i++) shuffled[i * width + j] = matrix[idx[i] * width + j];
  }
  return shuffled;
}

function shuffledDiagnostic(scenario, sampleSet, matrix, seed = 12345) {
  const shuffled = permutedMatrix(sampleSet, matrix, seed);
  const res = evaluateYield(scenario, sampleSet, shuffled);
  return {
    yield: res.yield,
    valid: false,
    note: '把同一零件的各维独立重排后再算合格率，破坏了零件内相关结构，只能作为错误对照。',
  };
}

/** Downsampled 2-D section data for plotting, with outcome and reason codes. */
function sectionData(sampleSet, matrix, evalRes, xKey, yKey, maxPoints = 1500) {
  const xi = sampleSet.keys.indexOf(xKey);
  const yi = sampleSet.keys.indexOf(yKey);
  if (xi < 0 || yi < 0) throw new Error('截面轴不在样本列中');
  const n = sampleSet.n;
  const stride = Math.max(1, Math.ceil(n / maxPoints));
  const points = [];
  const reasonsByPoint = [];
  for (let i = 0; i < n; i += stride) {
    let sig = '';
    for (const c of evalRes.constraints) {
      const cls = classify(c.values[i], { lower: c.lower, upper: c.upper });
      if (cls !== 'ok') sig += `${c.id}:${cls};`;
    }
    points.push([matrix[i * sampleSet.width + xi], matrix[i * sampleSet.width + yi]]);
    reasonsByPoint.push(sig);
  }
  return { xKey, yKey, points, reasons: reasonsByPoint, totalDraws: n, shown: points.length, stride };
}

/** Failure attribution for the CSV export and the UI explanation. */
function failureReasons(evalRes, sampleSet, matrix, limit) {
  const { n, keys, width } = sampleSet;
  const rows = [];
  const perConstraint = evalRes.constraints.map((c) => ({ id: c.id, low: c.failLow, high: c.failHigh }));
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (evalRes.jointMask[i]) continue;
    const reasons = [];
    evalRes.constraints.forEach((c, k) => {
      const cls = classify(evalRes.constraints[k].values[i], { lower: c.lower, upper: c.upper });
      if (cls !== 'ok') reasons.push(`${c.id}:${cls === 'low' ? '低于下界' : '高于上界'}`);
    });
    if (limit && count < limit) {
      const values = {};
      for (const key of keys) values[key] = matrix[i * width + keys.indexOf(key)];
      rows.push({ draw: i, reasons, values });
    }
    count++;
  }
  return { totalFailures: count, perConstraint, sample: rows };
}

function pct(x, digits = 2) {
  return `${(x * 100).toFixed(digits)}%`;
}

module.exports = {
  constraintValues,
  classify,
  constraintCoverage,
  evaluateYield,
  yieldInterval,
  stabilityCheck,
  shuffledDiagnostic,
  permutedMatrix,
  sectionData,
  failureReasons,
  pct,
};
