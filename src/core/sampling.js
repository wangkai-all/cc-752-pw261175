'use strict';

/**
 * Sampling engines.
 *
 * Modeling rule: one measured row = one physical part. Row-level resampling
 * keeps each part's dimensions together, so within-part correlation is
 * preserved by construction. Parametric sampling fits per-part correlation
 * matrices and draws one joint vector per assembly, so it also keeps
 * within-part correlation.
 *
 * Variables flagged `assumed` have no training rows (a new supplier dimension,
 * a fixture not yet measured). They are sampled from the assumed marginal and
 * marked as extrapolated everywhere. Two assumed variables in the same part are
 * drawn independently, which is stated explicitly in the UI.
 *
 * A sample set is built once from a seed and can then be transformed by any
 * number of parameter versions. That is what makes common-random-number
 * comparisons (base vs candidate) paired and fair.
 */

const { makeNormal, mulberry32 } = require('./rng');
const {
  mean,
  sd,
  quantile,
  skewness,
  kurtosisExcess,
  covarianceMatrix,
  correlationFromCov,
  cholesky,
  shrinkCorrelation,
  symEigen,
} = require('./stats');

function fitMarginal(values, requestedDist) {
  const n = values.length;
  const m = mean(values);
  const s = sd(values);
  const sk = skewness(values);
  const exKurt = kurtosisExcess(values);
  let dist = requestedDist && requestedDist !== 'auto' ? requestedDist : 'normal';
  const hasNonPositive = values.some((v) => v <= 0);
  if (!requestedDist || requestedDist === 'auto') {
    if (!hasNonPositive && n >= 8 && Math.abs(sk) > 1.0) dist = 't';
  }
  if (dist === 'lognormal' && hasNonPositive) dist = 'normal';
  const base = {
    n,
    mean: m,
    sd: s,
    support: [Math.min(...values), Math.max(...values)],
    q: {
      p01: quantile(values, 0.01),
      p05: quantile(values, 0.05),
      p50: quantile(values, 0.5),
      p95: quantile(values, 0.95),
      p99: quantile(values, 0.99),
    },
    extrapolated: false,
  };
  if (dist === 't') {
    let nu = exKurt > 0 ? 6 / exKurt + 4 : 30;
    nu = Math.min(60, Math.max(4, nu));
    return { ...base, dist, nu };
  }
  if (dist === 'lognormal') {
    const logs = values.map((v) => Math.log(v));
    return { ...base, dist, muLog: mean(logs), sdLog: sd(logs) };
  }
  return { ...base, dist: 'normal' };
}

/** Marginal from a declared assumption — always flagged extrapolated. */
function assumedMarginal(assumed) {
  return {
    dist: assumed.dist,
    n: 0,
    mean: assumed.mean,
    sd: assumed.sd,
    nu: assumed.nu || 5,
    support: null,
    q: null,
    extrapolated: true,
  };
}

function chi2Draw(normal, nu) {
  let s = 0;
  const k = Math.max(1, Math.round(nu));
  for (let i = 0; i < k; i++) s += normal() ** 2;
  return s;
}

/** Convert a standard-normal latent into a marginal value. */
function marginalValue(fit, y) {
  if (fit.dist === 'lognormal') return Math.exp(fit.muLog + fit.sdLog * y);
  if (fit.dist === 't') {
    // y already standardized; callers handle heavy tails via latent scaling
    return fit.mean + fit.sd * y;
  }
  return fit.mean + fit.sd * y;
}

function columnStats(ds, colIdx) {
  let s = 0;
  for (const row of ds.rows) s += row[colIdx];
  const m = s / ds.rows.length;
  let q = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const row of ds.rows) {
    const x = row[colIdx];
    q += (x - m) ** 2;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return { mean: m, sd: Math.sqrt(q / Math.max(1, ds.rows.length - 1)), lo, hi, n: ds.rows.length };
}

function buildSupports(scenario) {
  const out = {};
  for (const part of scenario.parts) {
    const ds = scenario.datasets[part.id];
    for (const v of part.variables) {
      if (v.assumed) {
        out[`${part.id}.${v.id}`] = {
          lo: v.assumed.mean - 4 * v.assumed.sd,
          hi: v.assumed.mean + 4 * v.assumed.sd,
          mean: v.assumed.mean,
          sd: v.assumed.sd,
          n: 0,
          assumed: true,
        };
      } else {
        const ci = ds.columns.indexOf(v.id);
        out[`${part.id}.${v.id}`] = { ...columnStats(ds, ci), assumed: false };
      }
    }
  }
  return out;
}

/**
 * Empirical engine: resample measured rows with replacement.
 * Assumed variables are drawn independently from their assumed marginal.
 */
function buildEmpiricalSampleSet(scenario, { n, seed }) {
  const rand = mulberry32(seed);
  const normal = makeNormal(rand);
  const keys = [];
  let width = 0;
  for (const part of scenario.parts) for (const v of part.variables) {
    keys.push(`${part.id}.${v.id}`);
  }
  width = keys.length;

  const entries = [];
  for (const part of scenario.parts) {
    const ds = scenario.datasets[part.id];
    const measuredVars = part.variables.filter((v) => !v.assumed);
    const colIdx = measuredVars.map((v) => ds.columns.indexOf(v.id));
    const colKeys = measuredVars.map((v) => `${part.id}.${v.id}`);
    const colOffsets = colKeys.map((k) => keys.indexOf(k));
    const stats = colIdx.map((ci) => columnStats(ds, ci));
    const idx = new Int32Array(n);
    for (let i = 0; i < n; i++) idx[i] = Math.floor(rand() * ds.rows.length) >>> 0;
    const assumedVars = part.variables.filter((v) => v.assumed);
    entries.push({ partId: part.id, ds, colIdx, colOffsets, stats, idx, assumedVars });
  }

  const base = new Float64Array(n * width);
  const means = new Float64Array(width);
  for (let j = 0; j < width; j++) {
    const [partId] = splitKey(keys[j]);
    const part = scenario.parts.find((p) => p.id === partId);
    const variable = part.variables.find((v) => `${part.id}.${v.id}` === keys[j]);
    means[j] = variable.assumed ? variable.assumed.mean : columnStats(scenario.datasets[partId], scenario.datasets[partId].columns.indexOf(variable.id)).mean;
  }

  for (const e of entries) {
    for (let i = 0; i < n; i++) {
      const row = e.ds.rows[e.idx[i]];
      const off = i * width;
      for (let j = 0; j < e.colIdx.length; j++) {
        base[off + e.colOffsets[j]] = row[e.colIdx[j]];
      }
    }
    for (const av of e.assumedVars) {
      const j = keys.indexOf(`${e.partId}.${av.id}`);
      for (let i = 0; i < n; i++) {
        base[i * width + j] = drawAssumed(av.assumed, normal, rand);
      }
    }
  }

  const warnings = [];
  const assumedKeys = keys.filter((k) => {
    const [pid] = splitKey(k);
    const p = scenario.parts.find((pp) => pp.id === pid);
    const v = p.variables.find((vv) => `${p.id}.${vv.id}` === k);
    return v.assumed;
  });
  if (assumedKeys.length) {
    warnings.push(
      `以下尺寸没有测量数据，按声明分布外推：${assumedKeys.join('、')}。含这些尺寸的约束会标记“外推”。`,
    );
  }

  return {
    kind: 'empirical',
    n,
    width,
    keys,
    base,
    means,
    fitted: null,
    supports: buildSupports(scenario),
    assumedKeys,
    warnings,
    seed,
    independentAssumption: false,
    tailMode: 'empirical',
  };
}

function drawAssumed(assumed, normal, rand) {
  if (assumed.dist === 'lognormal') {
    const m = Math.log(assumed.mean) - 0.5 * Math.log(1 + (assumed.sd / assumed.mean) ** 2);
    const s = Math.sqrt(Math.log(1 + (assumed.sd / assumed.mean) ** 2));
    return Math.exp(m + s * normal());
  }
  if (assumed.dist === 't') {
    const nu = assumed.nu || 5;
    const t = normal() / Math.sqrt(chi2Draw(normal, nu) / nu);
    return assumed.mean + assumed.sd * t * Math.sqrt((nu - 2) / nu);
  }
  return assumed.mean + assumed.sd * normal();
}

/**
 * Parametric engine: Gaussian copula over within-part correlations.
 * tailMode: 'normal' | 't-marginals' | 't-copula'.
 */
function buildParametricSampleSet(scenario, { n, seed, tailMode = 'normal', correlationShrinkage = 0.1, independence = false, nuTail = 5 }) {
  const rand = mulberry32(seed);
  const normal = makeNormal(rand);
  const keys = [];
  const fitted = [];
  const partBlocks = [];
  let width = 0;

  for (const part of scenario.parts) {
    const ds = scenario.datasets[part.id];
    const measured = part.variables.filter((v) => !v.assumed);
    const colIdx = measured.map((v) => ds.columns.indexOf(v.id));
    const mat = ds.rows.map((r) => colIdx.map((k) => r[k]));
    let corr = measured.length > 1 ? correlationFromCov(covarianceMatrix(mat).cov) : [[1]];
    if (independence) corr = shrinkCorrelation(corr, 1);
    else if (correlationShrinkage > 0) corr = shrinkCorrelation(corr, correlationShrinkage);
    const block = {
      partId: part.id,
      measuredKeys: measured.map((v) => `${part.id}.${v.id}`),
      assumedKeys: part.variables.filter((v) => v.assumed).map((v) => `${part.id}.${v.id}`),
      corr,
      offset: width,
    };
    for (let j = 0; j < measured.length; j++) {
      const fit = fitMarginal(mat.map((r) => r[j]), measured[j].dist);
      keys.push(`${part.id}.${measured[j].id}`);
      fitted.push({ key: `${part.id}.${measured[j].id}`, partId: part.id, variableId: measured[j].id, colIndex: j, fit });
    }
    width += measured.length;
    partBlocks.push(block);
  }

  const p = width;
  const R = Array.from({ length: p }, () => new Array(p).fill(0));
  for (const b of partBlocks) {
    const k = b.measuredKeys.length;
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) R[b.offset + i][b.offset + j] = b.corr[i][j];
  }
  let warning = null;
  let L = p ? cholesky(R) : [];
  if (p && !L) {
    const { values: ev, vectors: V } = symEigen(R);
    const clipped = R.map((row, i) => row.map((_, j) => V[i].reduce((s, v, k) => s + v * Math.max(ev[k], 1e-8) * V[j][k], 0)));
    L = cholesky(clipped);
    if (!L) {
      L = cholesky(Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => (i === j ? 1 : 0))));
      warning = '相关矩阵非正定，已退化为独立抽样（结果仅作参考）';
    } else {
      warning = '相关矩阵非正定，已裁剪负特征值后再抽样';
    }
  }

  // full key list includes assumed vars after measured ones
  const allKeys = [];
  for (const part of scenario.parts) for (const v of part.variables) allKeys.push(`${part.id}.${v.id}`);
  const fullWidth = allKeys.length;
  const base = new Float64Array(n * fullWidth);
  const means = new Float64Array(fullWidth);
  for (const k of keys) means[allKeys.indexOf(k)] = fitted.find((f) => f.key === k).fit.mean;

  const assumedVars = [];
  for (const part of scenario.parts) {
    for (const v of part.variables) {
      if (v.assumed) assumedVars.push({ partId: part.id, variable: v, col: allKeys.indexOf(`${part.id}.${v.id}`) });
      else means[allKeys.indexOf(`${part.id}.${v.id}`)] = fitted.find((f) => f.key === `${part.id}.${v.id}`).fit.mean;
    }
  }

  const tailScale = tailMode === 't-copula';
  for (let s = 0; s < n; s++) {
    const off = s * fullWidth;
    const z = new Float64Array(Math.max(1, p));
    for (let j = 0; j < p; j++) z[j] = normal();
    const common = tailScale ? Math.sqrt((nuTail - 2) / chi2Draw(normal, nuTail)) : 1;
    for (let i = 0; i < p; i++) {
      let acc = 0;
      for (let j = 0; j <= i; j++) acc += L[i][j] * z[j];
      const fit = fitted[i].fit;
      let y = acc;
      if (tailScale) y *= common;
      else if (tailMode === 't-marginals') y *= Math.sqrt(nuTail / chi2Draw(normal, nuTail));
      else if (fit.dist === 't') y *= Math.sqrt(fit.nu / chi2Draw(normal, fit.nu));
      base[off + allKeys.indexOf(fitted[i].key)] = marginalValue(fit, y);
    }
    for (const av of assumedVars) base[off + av.col] = drawAssumed(av.variable.assumed, normal, rand);
  }

  const warnings = [];
  if (warning) warnings.push(warning);
  const assumedKeys = assumedVars.map((a) => `${a.partId}.${a.variable.id}`);
  if (assumedKeys.length) {
    warnings.push(`以下尺寸没有测量数据，按声明分布外推：${assumedKeys.join('、')}。含这些尺寸的约束会标记“外推”。`);
  }

  return {
    kind: 'parametric',
    n,
    width: fullWidth,
    keys: allKeys,
    base,
    means,
    fitted,
    supports: buildSupports(scenario),
    correlation: R,
    tailMode,
    independence,
    warnings,
    assumedKeys,
    seed,
    independentAssumption: independence,
  };
}

function buildSampleSet(scenario, options) {
  if (options.method === 'parametric') return buildParametricSampleSet(scenario, options);
  return buildEmpiricalSampleSet(scenario, options);
}

/** Apply one parameter version to a pre-built sample set (column-wise affine). */
function applyVersion(sampleSet, params) {
  const { n, width, keys, base } = sampleSet;
  const out = new Float64Array(n * width);
  const shifts = new Float64Array(width);
  const scales = new Float64Array(width);
  const means = new Float64Array(width);
  for (let j = 0; j < width; j++) {
    const p = params[keys[j]];
    means[j] = p.mean;
    shifts[j] = p.centerShift;
    scales[j] = p.sigmaScale;
  }
  for (let i = 0; i < n; i++) {
    const off = i * width;
    for (let j = 0; j < width; j++) {
      out[off + j] = means[j] + shifts[j] + scales[j] * (base[off + j] - means[j]);
    }
  }
  return out;
}

function splitKey(key) {
  const idx = key.indexOf('.');
  return [key.slice(0, idx), key.slice(idx + 1)];
}

module.exports = {
  fitMarginal,
  assumedMarginal,
  buildSampleSet,
  buildEmpiricalSampleSet,
  buildParametricSampleSet,
  buildSupports,
  applyVersion,
  marginalValue,
  drawAssumed,
  splitKey,
};
