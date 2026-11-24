'use strict';

/**
 * Statistics helpers written for small samples.
 * Everything here is deterministic; no library dependency.
 */

const { makeNormal } = require('./rng');

// ---------- normal distribution ----------
function erf(x) {
  // Abramowitz & Stegun 7.1.26, |error| < 1.5e-7
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return sign * y;
}
const SQRT2 = Math.SQRT2;
function normCdf(x, mean = 0, sd = 1) {
  return 0.5 * (1 + erf((x - mean) / (sd * SQRT2)));
}
function normPdf(x, mean = 0, sd = 1) {
  const z = (x - mean) / sd;
  return Math.exp(-0.5 * z * z) / (sd * Math.sqrt(2 * Math.PI));
}
function normInv(p) {
  // Acklam's algorithm
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q; let r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ---------- chi-square / t / F ----------
function lowerRegGamma(a, x) {
  // regularized lower incomplete gamma P(a,x), series/continued fraction
  if (x <= 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  // continued fraction for Q
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}
function logGamma(x) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function chi2Cdf(x, k) {
  return lowerRegGamma(k / 2, x / 2);
}
function chi2Quantile(p, k) {
  // numeric inverse (bisection) — fine for k <= 200
  let lo = 0;
  let hi = Math.max(10, k * 4);
  while (chi2Cdf(hi, k) < p) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (chi2Cdf(mid, k) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
function tCdf(t, nu) {
  const x = nu / (nu + t * t);
  const p = 0.5 * lowerRegGamma(nu / 2, x / 2);
  return t > 0 ? 1 - p : p;
}
function tQuantile(p, nu) {
  let lo = -20;
  let hi = 20;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, nu) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
function fCdf(x, d1, d2) {
  if (x <= 0) return 0;
  const y = (d1 * x) / (d1 * x + d2);
  return lowerRegGamma(d1 / 2, y * 0 + 0) === undefined ? NaN : betai(d1 / 2, d2 / 2, y);
}
function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}
function betacf(a, b, x) {
  const MAXIT = 300;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

// ---------- basic sample stats ----------
function mean(xs) {
  let s = 0;
  for (const x of xs) s += x;
  return xs.length ? s / xs.length : NaN;
}
function variance(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / (xs.length - 1);
}
function sd(xs) {
  return Math.sqrt(variance(xs));
}
function quantile(xs, p) {
  // type-7 (linear interpolation), same as R/numpy default
  if (!xs.length) return NaN;
  const sorted = Float64Array.from(xs).sort();
  const h = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(h);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}
function median(xs) {
  return quantile(xs, 0.5);
}
function skewness(xs) {
  const n = xs.length;
  if (n < 3) return NaN;
  const m = mean(xs);
  const s2 = variance(xs);
  if (!(s2 > 0)) return 0;
  let m3 = 0;
  for (const x of xs) m3 += (x - m) ** 3;
  m3 /= n;
  return m3 / Math.pow(s2, 1.5);
}
function kurtosisExcess(xs) {
  const n = xs.length;
  if (n < 4) return NaN;
  const m = mean(xs);
  const s2 = variance(xs);
  if (!(s2 > 0)) return 0;
  let m4 = 0;
  for (const x of xs) m4 += (x - m) ** 4;
  m4 /= n;
  return m4 / (s2 * s2) - 3;
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return NaN;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}
function spearman(xs, ys) {
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  return pearson(rank(xs), rank(ys));
}

/** Covariance matrix (sample, n-1). Rows = observations. */
function covarianceMatrix(rows) {
  const n = rows.length;
  const p = rows[0].length;
  const means = new Array(p).fill(0);
  for (const r of rows) for (let j = 0; j < p; j++) means[j] += r[j];
  for (let j = 0; j < p; j++) means[j] /= n;
  const cov = Array.from({ length: p }, () => new Array(p).fill(0));
  for (const r of rows) {
    for (let a = 0; a < p; a++) {
      const da = r[a] - means[a];
      for (let b = a; b < p; b++) cov[a][b] += da * (r[b] - means[b]);
    }
  }
  const denom = Math.max(1, n - 1);
  for (let a = 0; a < p; a++) {
    for (let b = a; b < p; b++) {
      cov[a][b] /= denom;
      cov[b][a] = cov[a][b];
    }
  }
  return { means, cov };
}

function correlationFromCov(cov) {
  const p = cov.length;
  const out = Array.from({ length: p }, () => new Array(p).fill(0));
  const s = cov.map((row, i) => Math.sqrt(row[i]));
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      out[i][j] = s[i] > 0 && s[j] > 0 ? cov[i][j] / (s[i] * s[j]) : i === j ? 1 : 0;
    }
  }
  return out;
}

/** Cholesky decomposition (lower). Adds tiny ridge if needed; returns null if not PD. */
function cholesky(matrix, ridge = 0) {
  const p = matrix.length;
  const L = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = matrix[i][j] + (i === j ? ridge : 0);
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(sum > 0)) return null;
        L[i][j] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  return L;
}

/** Eigenvalues of symmetric matrix by Jacobi rotations (small p). */
function symEigen(matrix) {
  const n = matrix.length;
  const a = matrix.map((r) => r.slice());
  const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off < 1e-24) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-18) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const values = a.map((row, i) => row[i]);
  return { values, vectors: v };
}

/** Shrink a correlation matrix toward the identity: (1-lambda) R + lambda I. */
function shrinkCorrelation(R, lambda) {
  const p = R.length;
  return R.map((row, i) => row.map((v, j) => (i === j ? 1 : v * (1 - lambda))));
}

module.exports = {
  erf,
  normCdf,
  normPdf,
  normInv,
  chi2Cdf,
  chi2Quantile,
  tCdf,
  tQuantile,
  fCdf,
  betai,
  mean,
  variance,
  sd,
  quantile,
  median,
  skewness,
  kurtosisExcess,
  pearson,
  spearman,
  covarianceMatrix,
  correlationFromCov,
  cholesky,
  symEigen,
  shrinkCorrelation,
  makeNormal,
};
