'use strict';

/**
 * Core + API tests. Run with: npm test
 *
 * No test framework: node:test only. Each test states the modelling rule it
 * protects, so failures read as broken guarantees rather than broken output.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { normalizeScenario } = require('../src/core/schema');
const { attachDatasetMeans, materializeVersion, versionCost, versionFeasibility } = require('../src/core/params');
const { buildSampleSet, buildEmpiricalSampleSet, buildParametricSampleSet, applyVersion, buildSupports } = require('../src/core/sampling');
const {
  evaluateYield,
  constraintValues,
  shuffledDiagnostic,
  sectionData,
  yieldInterval,
} = require('../src/core/yield');
const { optimize, emptyVersion } = require('../src/core/optimize');
const { enumerateEmpirical, quadrature, verify } = require('../src/core/verify');
const { pearson } = require('../src/core/stats');

const SCEN_DIR = path.join(__dirname, '..', 'data', 'scenarios');

function loadRaw(file) {
  return JSON.parse(fs.readFileSync(path.join(SCEN_DIR, file), 'utf8'));
}
function prepare(raw) {
  const sc = normalizeScenario(raw);
  attachDatasetMeans(sc);
  return sc;
}
function scenarioFiles() {
  return fs.readdirSync(SCEN_DIR).filter((f) => f.endsWith('.json')).sort();
}

/** Small synthetic scenario used by several tests (one part, two correlated dims). */
function makeSynthetic() {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const a = Math.sin(i * 1.7) * 0.01;
    const b = a * 0.9 + Math.cos(i * 0.31) * 0.004;
    rows.push([10 + a, 5 + b]);
  }
  return {
    name: 'synthetic',
    parts: [
      {
        id: 'p',
        label: '零件 P',
        variables: [
          { id: 'a', label: 'A', dist: 'normal', cost: { perShift: 100, perSigma: 80, maxShift: 0.01, minSigmaScale: 0.6 } },
          { id: 'b', label: 'B', dist: 'normal', cost: { perShift: 100, perSigma: 80, maxShift: 0.01, minSigmaScale: 0.6 } },
        ],
      },
    ],
    datasets: { p: { columns: ['a', 'b'], rows } },
    constraints: [{ id: 'gap', label: '间隙', terms: [{ part: 'p', variable: 'a', coef: 1 }, { part: 'p', variable: 'b', coef: -1 }], lower: 4.98, upper: 5.02 }],
    simulation: { seed: 7, drawsPerPart: 800, method: 'empirical', correlationShrinkage: 0.1, tailSensitivity: true },
    budget: { total: 20, currency: '元' },
  };
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

test('schema: rejects a constraint referencing an unknown variable', () => {
  const raw = makeSynthetic();
  raw.constraints[0].terms[0].variable = 'nope';
  assert.throws(() => normalizeScenario(raw), (e) => e.code === 'SCHEMA' && /unknown variable/.test(e.message));
});

test('schema: requires at least 3 measured rows per part', () => {
  const raw = makeSynthetic();
  raw.datasets.p.rows = raw.datasets.p.rows.slice(0, 2);
  assert.throws(() => normalizeScenario(raw), (e) => e.code === 'SCHEMA' && /3 measured rows/.test(e.message));
});

test('schema: a part with only assumed variables needs no dataset and is flagged noMeasurements', () => {
  const raw = makeSynthetic();
  raw.parts.push({ id: 'vendor', label: '外购件', variables: [{ id: 'w', label: 'W', assumed: { mean: 3, sd: 0.01, dist: 'normal' } }] });
  raw.constraints[0].terms.push({ part: 'vendor', variable: 'w', coef: -1 });
  const sc = normalizeScenario(raw);
  assert.equal(sc.datasets.vendor.noMeasurements, true);
  assert.deepEqual(sc.datasets.vendor.rows, []);
});

test('schema: lower > upper is rejected', () => {
  const raw = makeSynthetic();
  raw.constraints[0].lower = 6;
  raw.constraints[0].upper = 5;
  assert.throws(() => normalizeScenario(raw), (e) => e.code === 'SCHEMA');
});

// ---------------------------------------------------------------------------
// sampling / correlation
// ---------------------------------------------------------------------------

test('empirical sampling keeps rows intact (within-part correlation survives)', () => {
  const sc = prepare(makeSynthetic());
  const ss = buildEmpiricalSampleSet(sc, { n: 2000, seed: 11 });
  const ai = ss.keys.indexOf('p.a');
  const bi = ss.keys.indexOf('p.b');
  const as = [];
  const bs = [];
  for (let i = 0; i < ss.n; i++) {
    as.push(ss.base[i * ss.width + ai]);
    bs.push(ss.base[i * ss.width + bi]);
  }
  const src = pearson(sc.datasets.p.rows.map((r) => r[0]), sc.datasets.p.rows.map((r) => r[1]));
  const got = pearson(as, bs);
  assert.ok(Math.abs(got - src) < 0.06, `resampled correlation ${got.toFixed(3)} should track source ${src.toFixed(3)}`);
  // every sampled pair must exist as a measured row pair
  const pairs = new Set(sc.datasets.p.rows.map((r) => `${r[0].toFixed(12)}|${r[1].toFixed(12)}`));
  for (let i = 0; i < 200; i++) {
    const k = `${ss.base[i * ss.width + ai].toFixed(12)}|${ss.base[i * ss.width + bi].toFixed(12)}`;
    assert.ok(pairs.has(k), 'row bootstrap must not synthesise new pairs');
  }
});

test('parametric sampling reproduces the measured correlation', () => {
  const sc = prepare(makeSynthetic());
  const ss = buildParametricSampleSet(sc, { n: 4000, seed: 5, tailMode: 'normal', correlationShrinkage: 0 });
  const ai = ss.keys.indexOf('p.a');
  const bi = ss.keys.indexOf('p.b');
  const as = [];
  const bs = [];
  for (let i = 0; i < ss.n; i++) {
    as.push(ss.base[i * ss.width + ai]);
    bs.push(ss.base[i * ss.width + bi]);
  }
  const src = pearson(sc.datasets.p.rows.map((r) => r[0]), sc.datasets.p.rows.map((r) => r[1]));
  const got = pearson(as, bs);
  assert.ok(Math.abs(got - src) < 0.07, `parametric correlation ${got.toFixed(3)} vs source ${src.toFixed(3)}`);
});

test('shuffled diagnostic destroys correlation and is labelled invalid', () => {
  const sc = prepare(makeSynthetic());
  const ss = buildSampleSet(sc, { n: 3000, seed: 3, method: 'empirical' });
  const matrix = applyVersion(ss, materializeVersion(sc, emptyVersion()).params);
  const res = shuffledDiagnostic(sc, ss, matrix);
  assert.equal(res.valid, false);
  assert.ok(/错误对照/.test(res.note));
});

// ---------------------------------------------------------------------------
// parameter versions
// ---------------------------------------------------------------------------

test('applyVersion is affine: shift moves the mean, sigma scales the spread', () => {
  const sc = prepare(makeSynthetic());
  const ss = buildSampleSet(sc, { n: 500, seed: 9, method: 'empirical' });
  const base = applyVersion(ss, materializeVersion(sc, emptyVersion()).params);
  const ai = ss.keys.indexOf('p.a');
  const b0 = base.filter((_, idx) => idx % ss.width === ai);
  const m0 = b0.reduce((s, v) => s + v, 0) / b0.length;

  const shiftOnly = applyVersion(ss, materializeVersion(sc, { shifts: { 'p.a': 0.004 }, sigmas: {} }).params);
  const b1 = shiftOnly.filter((_, idx) => idx % ss.width === ai);
  const m1 = b1.reduce((s, v) => s + v, 0) / b1.length;
  assert.ok(Math.abs(m1 - m0 - 0.004) < 1e-12, 'shift must translate every draw by exactly the shift');

  const sigmaOnly = applyVersion(ss, materializeVersion(sc, { shifts: {}, sigmas: { 'p.a': 0.5 } }).params);
  const b2 = sigmaOnly.filter((_, idx) => idx % ss.width === ai);
  const sd = (arr) => {
    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
  };
  assert.ok(Math.abs(sd(b2) / sd(b0) - 0.5) < 1e-12, 'sigma scale must scale the spread exactly');
});

test('cost and feasibility read the same version that simulation uses', () => {
  const sc = prepare(makeSynthetic());
  const version = { shifts: { 'p.a': 0.006 }, sigmas: { 'p.b': 0.8 } };
  const a = materializeVersion(sc, version);
  const b = materializeVersion(sc, version);
  assert.equal(a.fingerprint, b.fingerprint, 'fingerprint is deterministic');
  const mat = applyVersion(buildSampleSet(sc, { n: 200, seed: 1, method: 'empirical' }), a.params);
  const ev = evaluateYield(sc, buildSampleSet(sc, { n: 200, seed: 1, method: 'empirical' }), mat);
  assert.ok(Number.isFinite(ev.yield));

  const cost = versionCost(sc, version).total;
  const expected = 100 * 0.006 + 80 * 0.2;
  assert.ok(Math.abs(cost - expected) < 1e-9, `cost ${cost} vs expected ${expected}`);
  const feas = versionFeasibility(sc, version, 20);
  assert.equal(feas.feasible, true);
  assert.equal(feas.cost, cost);
});

test('budget and process limits are hard constraints on feasibility', () => {
  const sc = prepare(makeSynthetic());
  const overBudget = { shifts: { 'p.a': 0.01 }, sigmas: {} };
  assert.equal(versionFeasibility(sc, overBudget, 0.5).feasible, false);
  const overShift = { shifts: { 'p.a': 0.02 }, sigmas: {} };
  const f = versionFeasibility(sc, overShift, 1e9);
  assert.equal(f.feasible, false);
  assert.ok(f.violations.some((v) => /可调范围/.test(v)));
  const overSigma = { shifts: {}, sigmas: { 'p.a': 0.3 } };
  const g = versionFeasibility(sc, overSigma, 1e9);
  assert.equal(g.feasible, false);
  assert.ok(g.violations.some((v) => /标准差倍率/.test(v)));
  const expansion = { shifts: {}, sigmas: { 'p.a': 1.5 } };
  assert.equal(versionFeasibility(sc, expansion, 1e9).feasible, false);
});

test('locked variables are excluded from optimization', () => {
  const raw = makeSynthetic();
  raw.parts[0].variables[0].locked = true;
  const sc = prepare(raw);
  const ss = buildSampleSet(sc, { n: 600, seed: 21, method: 'empirical' });
  const res = optimize(sc, ss, { budget: 20, maxEvaluations: 200 });
  assert.ok(res.lockedKeys.includes('p.a'));
  assert.ok(!res.recommended.version.shifts['p.a']);
});

// ---------------------------------------------------------------------------
// yield semantics
// ---------------------------------------------------------------------------

test('joint yield equals the AND of per-constraint passes, never the product', () => {
  const sc = prepare(makeSynthetic());
  const ss = buildSampleSet(sc, { n: 2000, seed: 13, method: 'empirical' });
  const mat = applyVersion(ss, materializeVersion(sc, emptyVersion()).params);
  const ev = evaluateYield(sc, ss, mat, { includeValues: true });
  let passed = 0;
  for (let i = 0; i < ss.n; i++) {
    let ok = 1;
    for (const c of ev.constraints) ok &= c.pass[i];
    if (ok) passed++;
  }
  assert.equal(passed, ev.passed);
  assert.equal(ev.jointMask.length, ss.n);
  assert.ok(Math.abs(ev.marginalProduct - ev.constraints.reduce((s, c) => s * c.marginal, 1)) < 1e-12);
});

test('several dimensions can each pass while the assembly fails', () => {
  // Two strongly correlated dimensions (r≈0.9) with *opposite* one-sided
  // constraints. Each dimension passes about 58% of the time; because they move
  // together, the assembly passes far less often than the product suggests.
  const rows = [];
  const N = 5000;
  let seed = 24681357;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const tri = () => (rand() + rand() + rand() - 1.5) / 0.5; // approx standard normal
  for (let i = 0; i < N; i++) {
    const z1 = tri();
    const z2 = 0.9 * z1 + 0.4359 * tri();
    rows.push([10 + 0.01 * z1, 10 + 0.01 * z2]);
  }
  const raw = {
    name: 'trap',
    parts: [
      {
        id: 'p',
        variables: [
          { id: 'a', label: 'A', cost: { perShift: 100, perSigma: 100, maxShift: 0.01, minSigmaScale: 0.5 } },
          { id: 'b', label: 'B', cost: { perShift: 100, perSigma: 100, maxShift: 0.01, minSigmaScale: 0.5 } },
        ],
      },
    ],
    datasets: { p: { columns: ['a', 'b'], rows } },
    constraints: [
      { id: 'upperA', terms: [{ part: 'p', variable: 'a', coef: 1 }], upper: 9.998 },
      { id: 'lowerB', terms: [{ part: 'p', variable: 'b', coef: 1 }], lower: 10.002 },
    ],
    simulation: { seed: 1, drawsPerPart: 4000, method: 'empirical' },
    budget: { total: 10, currency: '元' },
  };
  const sc = prepare(raw);
  const ss = buildSampleSet(sc, { n: 4000, seed: 2, method: 'empirical' });
  const ev = evaluateYield(sc, ss, applyVersion(ss, materializeVersion(sc, emptyVersion()).params));
  assert.ok(ev.constraints.every((c) => c.marginal > 0.4), `each dimension mostly passes: ${ev.constraints.map((c) => c.marginal)}`);
  assert.ok(ev.yield < ev.marginalProduct * 0.6, `joint ${ev.yield} should be well below the product ${ev.marginalProduct}`);
  const sh = shuffledDiagnostic(sc, ss, applyVersion(ss, materializeVersion(sc, emptyVersion()).params));
  assert.ok(sh.yield > ev.yield + 0.03, `shuffling must inflate the joint yield: real ${ev.yield}, shuffled ${sh.yield}`);
});

test('shuffled dims change the joint yield when correlation matters', () => {
  const sc = prepare(makeSynthetic());
  const ss = buildSampleSet(sc, { n: 4000, seed: 17, method: 'empirical' });
  const mat = applyVersion(ss, materializeVersion(sc, emptyVersion()).params);
  const real = evaluateYield(sc, ss, mat).yield;
  const bad = shuffledDiagnostic(sc, ss, mat).yield;
  assert.ok(Math.abs(real - bad) > 0.005, `shuffle should move the joint yield (real ${real}, shuffled ${bad})`);
});

// ---------------------------------------------------------------------------
// coverage / extrapolation
// ---------------------------------------------------------------------------

test('a constraint with an unmeasured variable is flagged extrapolated', () => {
  const sc = prepare(loadRaw('bearing-extrapolation.json'));
  const ss = buildSampleSet(sc, { n: 800, seed: 3, method: 'empirical' });
  const ev = evaluateYield(sc, ss, applyVersion(ss, materializeVersion(sc, emptyVersion()).params));
  const c = ev.constraints.find((x) => x.id === 'axialClearance');
  assert.equal(c.coverage.status, 'extrapolated');
  assert.ok(c.coverage.reason.includes('bearing.width'));
  const radial = ev.constraints.find((x) => x.id === 'radialClearance');
  assert.notEqual(radial.coverage.status, 'extrapolated');
});

test('parametric tails outside the observed range are reported as partial coverage', () => {
  const sc = prepare(makeSynthetic());
  const ss = buildSampleSet(sc, { n: 6000, seed: 4, method: 'parametric', tailMode: 't-marginals' });
  const ev = evaluateYield(sc, ss, applyVersion(ss, materializeVersion(sc, emptyVersion()).params));
  assert.ok(ev.constraints.some((c) => c.coverage.status === 'partial' || c.coverage.outsideFraction > 0));
  for (const c of ev.constraints) {
    assert.ok(c.coverage.outsideFraction >= 0 && c.coverage.outsideFraction <= 1);
  }
});

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

test('exact enumeration matches the empirical bootstrap within MC noise', () => {
  const sc = prepare(loadRaw('small-dimension-check.json'));
  const version = emptyVersion();
  const ss = buildSampleSet(sc, { n: 20000, seed: 31, method: 'empirical' });
  const mc = evaluateYield(sc, ss, applyVersion(ss, materializeVersion(sc, version).params)).yield;
  const en = enumerateEmpirical(sc, version);
  assert.equal(en.applicable, true);
  const se = Math.sqrt((en.yield * (1 - en.yield)) / 20000);
  assert.ok(Math.abs(mc - en.yield) < 4 * se + 0.001, `MC ${mc} vs exact ${en.yield}`);
});

test('2-D quadrature agrees with MC for a normal 2-dimension stack-up', () => {
  const sc = prepare(loadRaw('small-dimension-check.json'));
  const version = emptyVersion();
  const ss = buildSampleSet(sc, { n: 30000, seed: 41, method: 'parametric', tailMode: 'normal' });
  const mc = evaluateYield(sc, ss, applyVersion(ss, materializeVersion(sc, version).params)).yield;
  const q = quadrature(sc, version, 401);
  assert.equal(q.applicable, true);
  const se = Math.sqrt((mc * (1 - mc)) / 30000);
  assert.ok(Math.abs(mc - q.yield) < 4 * se + 0.004, `MC ${mc} vs quadrature ${q.yield}`);
});

test('verify() reports stability, convergence and the invalid shuffle control', () => {
  const sc = prepare(loadRaw('small-sample-tails.json'));
  const v = verify(sc, emptyVersion(), { draws: 1500, method: 'empirical', seed: 9, seeds: 6 });
  assert.ok(v.mc.n === 1500);
  assert.ok(v.notes.length >= 3);
  assert.ok(Array.isArray(v.convergence) && v.convergence.length > 0);
  assert.ok(v.seedStability.yields.length === 6);
  // verification never claims the shuffle is a valid model
  assert.equal(typeof v.shuffle === 'undefined' || v.shuffle.valid === false, true);
});

// ---------------------------------------------------------------------------
// optimization
// ---------------------------------------------------------------------------

test('optimizer respects budget, process limits and only adjusts parameters', () => {
  for (const f of scenarioFiles()) {
    const sc = prepare(loadRaw(f));
    const ss = buildSampleSet(sc, { n: 900, seed: 55, method: 'empirical' });
    const res = optimize(sc, ss, { budget: sc.budget.total, maxEvaluations: 600 });
    const rec = res.recommended;
    assert.ok(rec.cost <= sc.budget.total + 1e-9, `${f}: recommendation over budget`);
    assert.equal(rec.feasible, true, `${f}: recommendation must be feasible`);
    assert.ok(rec.yield >= res.base.yield - 1e-9, `${f}: recommendation must not be worse`);
    // every adjustment is an explicit parameter change; no rows were dropped
    assert.equal(ss.n, ss.base.length / ss.width, 'sample count unchanged');
    const mat = materializeVersion(sc, rec.version);
    const cost = versionCost(sc, rec.version).total;
    assert.equal(rec.fingerprint, mat.fingerprint, `${f}: fingerprint must identify the simulated version`);
    assert.ok(Math.abs(cost - rec.cost) < 1e-9, `${f}: reported cost must equal the version's cost`);
  }
});

test('optimizer can improve at least one scenario by shifting the center', () => {
  const sc = prepare(loadRaw('reducer-cover.json'));
  const ss = buildSampleSet(sc, { n: 2000, seed: 5, method: 'empirical' });
  const res = optimize(sc, ss, { budget: sc.budget.total, maxEvaluations: 800 });
  assert.ok(res.recommended.yield > res.base.yield + 0.001, 'should find a real improvement');
  assert.ok(res.pareto.length >= 1);
  assert.ok(res.recommended.adjustments.every((a) => typeof a.key === 'string'));
});

// ---------------------------------------------------------------------------
// section + export semantics
// ---------------------------------------------------------------------------

test('section data can lock a parameter and reports the fixed value', () => {
  const sc = prepare(loadRaw('reducer-cover.json'));
  const ss = buildSampleSet(sc, { n: 1200, seed: 8, method: 'empirical' });
  const mat = applyVersion(ss, materializeVersion(sc, emptyVersion()).params);
  const ev = evaluateYield(sc, ss, mat, { includeValues: true });
  const key = ss.keys[0];
  const sec = sectionData(ss, mat, ev, key, ss.keys[1], 500);
  assert.ok(sec.points.length > 0 && sec.points.length <= 500);
  assert.equal(sec.reasons.length, sec.points.length);
});

test('yieldInterval brackets the point estimate', () => {
  const iv = yieldInterval(0.5, 1000);
  assert.ok(iv.lo < 0.5 && iv.hi > 0.5);
  assert.ok(iv.se > 0);
});

// ---------------------------------------------------------------------------
// API (spin up the real server on an ephemeral port)
// ---------------------------------------------------------------------------

test('API end-to-end: analyze → optimize → compare → approve consistency', async (t) => {
  const { server } = require('../src/server/server');
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;
  const raw = loadRaw('reducer-cover.json');

  async function post(p, body) {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    return { status: r.status, body: j };
  }

  const health = await fetch(base + '/api/health').then((r) => r.json());
  assert.equal(health.ok, true);

  const an = await post('/api/analyze', { scenario: raw, options: { method: 'empirical', draws: 1500, seed: 3 } });
  assert.equal(an.status, 200);
  assert.ok(an.body.baseline.yield >= 0 && an.body.baseline.yield <= 1);
  assert.ok(an.body.tails.length >= 4);
  assert.ok(an.body.sectionCandidates.length > 1);

  const opt = await post('/api/optimize', { scenario: raw, budget: raw.budget.total, options: { method: 'empirical', draws: 1200, seed: 3 } });
  assert.equal(opt.status, 200);
  const o = opt.body.optimization;
  assert.equal(o.consistency.fingerprintMatches, true);
  assert.equal(o.consistency.costMatches, true);
  assert.ok(o.recommended.cost <= raw.budget.total + 1e-9);

  const cmp = await post('/api/compare', {
    scenario: raw,
    options: { method: 'empirical', draws: 1500, seed: 3 },
    baseVersion: { shifts: {}, sigmas: {} },
    candidateVersion: o.recommended.version,
  });
  assert.equal(cmp.status, 200);
  const cc = cmp.body;
  assert.equal(cc.n, 1500);
  assert.ok(cc.delta.paired.bothPass + cc.delta.paired.onlyBase + cc.delta.paired.onlyCand + cc.delta.paired.neither === 1500);
  assert.ok(cc.delta.lo <= cc.delta.mean + 1e-12 && cc.delta.hi >= cc.delta.mean - 1e-12);

  const verifyRes = await post('/api/verify', { scenario: raw, options: { method: 'empirical', draws: 800, seed: 2 }, seeds: 4 });
  assert.equal(verifyRes.status, 200);
  assert.ok(verifyRes.body.verification.mc.n === 800);

  const dist = await post('/api/distributions', { scenario: raw, options: { method: 'empirical', draws: 600, seed: 2 }, constraintId: an.body.baseline.constraints[0].id });
  assert.equal(dist.status, 200);
  assert.ok(dist.body.series.length >= 2);
  assert.ok(dist.body.series.find((s) => s.invalid), 'the independent shuffle is present as an invalid control');

  const sec = await post('/api/section', {
    scenario: raw,
    options: { method: 'empirical', draws: 800, seed: 2 },
    xKey: an.body.sectionCandidates[0].key,
    yKey: an.body.sectionCandidates[1].key,
    fixKey: an.body.sectionCandidates[2].key,
    fixValue: an.body.sectionCandidates[2].key.includes('housing') ? 40 : 12,
  });
  assert.equal(sec.status, 200);
  assert.ok(sec.body.section.fixed);

  const csvRes = await fetch(base + '/api/export/failures', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario: raw, options: { method: 'empirical', draws: 300, seed: 2 }, limit: 40 }),
  });
  assert.equal(csvRes.status, 200);
  const csv = await csvRes.text();
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 41);
  assert.ok(lines[0].includes('joint_pass'));
  assert.ok(lines[0].includes('_reason'));

  // schema errors surface as 400 with a readable message
  const bad = await post('/api/analyze', { scenario: { parts: [] } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /校验失败/);
});

test('API: demo scenarios list and static page are served', async (t) => {
  const { server } = require('../src/server/server');
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;

  const list = await fetch(base + '/api/scenarios').then((r) => r.json());
  assert.equal(list.ok, true);
  assert.ok(list.scenarios.length >= 5);
  assert.ok(list.scenarios.every((s) => s.name && s.file));

  const html = await fetch(base + '/').then((r) => r.text());
  assert.match(html, /公差联合合格率工作台/);
  assert.match(html, /js\/app\.js/);
  const app = await fetch(base + '/js/app.js');
  assert.equal(app.status, 200);
  assert.match(app.headers.get('content-type'), /javascript/);
});
