/**
 * Deterministic PRNG utilities (shared by core and tests).
 * Mulberry32: small, fast, good enough for simulation; seedable for reproducibility.
 */
'use strict';

function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller; consumes two uniforms. */
function makeNormal(rand) {
  let spare = null;
  return function () {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
}

/** Student-t draw (standardized to variance 1) via normal / sqrt(chi2/nu). */
function makeStandardizedT(rand, normal, nu) {
  return function () {
    // chi-square(nu) as sum of nu squared normals (nu <= 30 used in practice)
    let chi2 = 0;
    const n = Math.max(1, Math.round(nu));
    for (let i = 0; i < n; i++) chi2 += normal() ** 2;
    const z = normal();
    return z / Math.sqrt(chi2 / n) / Math.sqrt(nu / (nu - 2));
  };
}

module.exports = { hashString, mulberry32, makeNormal, makeStandardizedT };
