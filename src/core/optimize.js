'use strict';

/**
 * Yield-oriented optimization over manufacturing parameter versions.
 *
 * Every candidate is a *parameter version*: per-variable center shift and/or
 * sigma scale. The same version object feeds simulation, cost and feasibility
 * (see params.materializeVersion), so the price you see is the price of the
 * parameters that were simulated.
 *
 * We never drop "ugly" draws: all draws represent real parts, and adjustments
 * change the process that produces them.
 *
 * Search (deterministic, seeded, budget-capped):
 *   1. OAT probes — one variable at a time: center shift grid plus
 *      constraint-implied midpoints, and sigma tightening steps.
 *   2. Greedy bundle — add the feasible step with the largest joint-yield gain
 *      until no gain or budget exhausted.
 *   3. Coordinate refinement on the bundle.
 * Results are a ranked candidate list plus a yield–cost Pareto frontier.
 */

const { materializeVersion, versionCost, versionFeasibility, fmt } = require('./params');
const { applyVersion } = require('./sampling');
const { evaluateYield } = require('./yield');

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

function sortObj(o) {
  const out = {};
  for (const k of Object.keys(o).sort()) {
    if (Math.abs(o[k]) > 1e-9) out[k] = round6(o[k]);
  }
  return out;
}

function candidateId(version) {
  return JSON.stringify({ s: sortObj(version.shifts || {}), g: sortObj(version.sigmas || {}) });
}

function cloneVersion(v) {
  return { shifts: { ...(v.shifts || {}) }, sigmas: { ...(v.sigmas || {}) } };
}

function emptyVersion() {
  return { shifts: {}, sigmas: {} };
}

function evaluateCandidate(ctx, version, label) {
  const { scenario, sampleSet, budget } = ctx;
  const material = materializeVersion(scenario, version);
  const feas = versionFeasibility(scenario, version, budget);
  const matrix = applyVersion(sampleSet, material.params);
  const y = evaluateYield(scenario, sampleSet, matrix);
  return {
    id: candidateId(version),
    label: label || '候选方案',
    version: cloneVersion(version),
    fingerprint: material.fingerprint,
    yield: y.yield,
    marginalProduct: y.marginalProduct,
    correlationPenalty: y.correlationPenalty,
    constraints: y.constraints.map((c) => ({
      id: c.id,
      marginal: c.marginal,
      coverage: c.coverage.status,
    })),
    extrapolated: y.extrapolated,
    partialCoverage: y.partialCoverage,
    cost: feas.cost,
    feasible: feas.feasible,
    violations: feas.violations,
    adjustments: buildAdjustmentList(scenario, material.params),
  };
}

function buildAdjustmentList(scenario, params) {
  const out = [];
  for (const part of scenario.parts) {
    for (const v of part.variables) {
      const key = `${part.id}.${v.id}`;
      const p = params[key];
      const sigmaChanged = Math.abs(p.sigmaScale - (v.sigmaScale ?? 1)) > 1e-9;
      if (Math.abs(p.adjShift) > 1e-9 || sigmaChanged) {
        out.push({
          key,
          part: part.id,
          variable: v.id,
          label: `${part.label} · ${v.label}`,
          centerShift: round6(p.centerShift),
          adjShift: round6(p.adjShift),
          sigmaScale: round6(p.sigmaScale),
          adjSigma: round6(p.adjSigma),
          locked: Boolean(v.locked),
          extrapolated: Boolean(v.assumed),
        });
      }
    }
  }
  return out;
}

/**
 * Constraint-implied target for a single-term constraint's coefficient:
 * shifting the variable by delta moves the stack-up by coef*delta.
 */
function impliedShifts(scenario) {
  const out = {};
  for (const part of scenario.parts) for (const v of part.variables) out[`${part.id}.${v.id}`] = [];
  for (const c of scenario.constraints) {
    if (c.terms.length !== 1) continue;
    const t = c.terms[0];
    const key = `${t.part}.${t.variable}`;
    if (!(key in out)) continue;
    if (c.lower !== undefined && c.upper !== undefined) {
      out[key].push({ target: (c.lower + c.upper) / 2, coef: t.coef, constraint: c.id, strength: 1 });
    } else if (c.upper !== undefined) {
      out[key].push({ target: c.upper, coef: t.coef, constraint: c.id, strength: 1 });
    } else {
      out[key].push({ target: c.lower, coef: t.coef, constraint: c.id, strength: 1 });
    }
  }
  return out;
}

function stepGrid(variable) {
  const maxShift = variable.cost.maxShift;
  const minSigma = variable.cost.minSigmaScale;
  const shifts = new Set([0]);
  const N = 8;
  for (let i = -N; i <= N; i++) shifts.add(round6((i / N) * maxShift));
  const sigmas = new Set([1]);
  if (variable.cost.perSigma > 0 || variable.cost.minSigmaScale < 1) {
    for (const g of [0.98, 0.95, 0.92, 0.9, 0.85, 0.8, 0.75, 0.7, 0.6, 0.55, 0.5]) {
      if (g >= minSigma - 1e-12) sigmas.add(g);
    }
  }
  return {
    shifts: Array.from(shifts).sort((a, b) => a - b),
    sigmas: Array.from(sigmas).sort((a, b) => b - a),
  };
}

/**
 * Run the optimizer.
 * @param scenario normalized (with dataset means attached)
 * @param sampleSet built level-0 sample set (common random numbers)
 * @param opts { budget, maxEvaluations, baseVersion, lockedKeys, minGain }
 */
function optimize(scenario, sampleSet, opts = {}) {
  const budget = opts.budget === undefined ? scenario.budget.total : opts.budget;
  const maxEvaluations = opts.maxEvaluations || 1200;
  const baseVersion = opts.baseVersion ? cloneVersion(opts.baseVersion) : emptyVersion();
  const minGain = opts.minGain || 1e-5;
  const ctx = { scenario, sampleSet, budget };
  let evaluations = 0;
  const cache = new Map();

  function evalVersion(version, label) {
    const id = candidateId(version);
    if (cache.has(id)) return cache.get(id);
    if (evaluations >= maxEvaluations) return null;
    evaluations++;
    const r = evaluateCandidate(ctx, version, label);
    cache.set(id, r);
    return r;
  }

  const base = evalVersion(baseVersion, '原方案');
  const baseYield = base.yield;

  const locked = new Set(opts.lockedKeys || []);
  for (const part of scenario.parts) {
    for (const v of part.variables) if (v.locked) locked.add(`${part.id}.${v.id}`);
  }
  const adjustable = [];
  for (const part of scenario.parts) {
    for (const v of part.variables) {
      const key = `${part.id}.${v.id}`;
      if (locked.has(key)) continue;
      if (v.cost.perShift <= 0 && v.cost.perSigma <= 0) continue;
      adjustable.push({ key, part, variable: v });
    }
  }

  const implied = impliedShifts(scenario);
  const probes = [];

  // ---- stage 1: OAT probes ----
  for (const a of adjustable) {
    const mean = a.variable.datasetMean;
    const grid = stepGrid(a.variable);
    const shiftSet = new Set(grid.shifts);
    for (const t of implied[a.key] || []) {
      const delta = t.target / (t.coef || 1) - mean;
      const clipped = Math.max(-a.variable.cost.maxShift, Math.min(a.variable.cost.maxShift, delta));
      shiftSet.add(round6(clipped));
      shiftSet.add(round6(clipped / 2));
    }
    const shiftList = Array.from(shiftSet).sort((x, y) => x - y);
    for (const s of shiftList) {
      if (Math.abs(s) < 1e-12) continue;
      if (a.variable.cost.perShift <= 0) continue;
      const v = { shifts: { [a.key]: s }, sigmas: {} };
      const r = evalVersion(v, `单项 · ${labelForKey(a.key, scenario)} 中心 ${s >= 0 ? '+' : ''}${fmt(s)}`);
      if (r) probes.push({ kind: 'shift', key: a.key, value: s, result: r, label: r.label });
    }
    for (const g of grid.sigmas) {
      if (g >= 1 - 1e-12) continue;
      if (a.variable.cost.perSigma <= 0) continue;
      const v = { shifts: {}, sigmas: { [a.key]: g } };
      const r = evalVersion(v, `单项 · ${labelForKey(a.key, scenario)} σ×${g}`);
      if (r) probes.push({ kind: 'sigma', key: a.key, value: g, result: r, label: r.label });
    }
  }

  const ranked = [];
  for (const p of probes) {
    const gain = p.result.yield - baseYield;
    p.gain = gain;
    p.efficiency = p.result.cost > 1e-9 ? gain / p.result.cost : gain > 0 ? Infinity : 0;
    if (p.result.feasible) ranked.push(p);
  }
  ranked.sort((a, b) => b.gain - a.gain || a.result.cost - b.result.cost);

  // ---- stage 2: greedy bundle ----
  let current = cloneVersion(baseVersion);
  let currentEval = base;
  const steps = [];
  const usedDirections = new Set();
  for (let iter = 0; iter < 30; iter++) {
    let best = null;
    for (const p of ranked) {
      // avoid re-applying the exact same direction on the same variable
      const dirKey = `${p.kind}:${p.key}:${p.value}`;
      if (usedDirections.has(dirKey)) continue;
      const trial = cloneVersion(current);
      if (p.kind === 'shift') {
        trial.shifts[p.key] = round6((trial.shifts[p.key] || 0) + p.value);
      } else {
        trial.sigmas[p.key] = Math.min(trial.sigmas[p.key] ?? 1, p.value);
      }
      const r = evalVersion(trial, `组合 ${iter + 1}`);
      if (!r || !r.feasible) continue;
      const gain = r.yield - currentEval.yield;
      if (gain <= minGain) continue;
      if (!best || gain > best.gain + 1e-9 || (Math.abs(gain - best.gain) <= 1e-9 && r.cost < best.result.cost)) {
        best = { version: trial, result: r, gain, probe: p, dirKey };
      }
    }
    if (!best) break;
    current = best.version;
    currentEval = best.result;
    usedDirections.add(best.dirKey);
    steps.push({
      key: best.probe.key,
      kind: best.probe.kind,
      value: best.probe.value,
      yieldAfter: best.result.yield,
      costAfter: best.result.cost,
      label: best.result.label,
    });
    if (currentEval.yield > 1 - 1e-7) break;
  }

  // ---- stage 3: coordinate refinement ----
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 4) {
    improved = false;
    for (const a of adjustable) {
      const grid = stepGrid(a.variable);
      const trials = [];
      for (const s of grid.shifts) {
        if (Math.abs(s) < 1e-12) continue;
        if (a.variable.cost.perShift <= 0) continue;
        const t = cloneVersion(current);
        t.shifts[a.key] = s;
        trials.push(t);
      }
      if (a.variable.cost.perSigma > 0) {
        for (const g of grid.sigmas) {
          if (g >= 1 - 1e-12) continue;
          const t = cloneVersion(current);
          t.sigmas[a.key] = g;
          trials.push(t);
        }
      }
      // also try clearing the key
      {
        const t = cloneVersion(current);
        delete t.shifts[a.key];
        delete t.sigmas[a.key];
        trials.push(t);
      }
      for (const t of trials) {
        const r = evalVersion(t, '坐标精修');
        if (!r || !r.feasible) continue;
        if (r.yield > currentEval.yield + minGain) {
          current = t;
          currentEval = r;
          improved = true;
        }
      }
    }
  }

  const feasibleCandidates = Array.from(cache.values()).filter((r) => r.feasible);
  const candidatesByYield = feasibleCandidates.slice().sort((a, b) => b.yield - a.yield || a.cost - b.cost);
  const candidatesByCost = feasibleCandidates.slice().sort((a, b) => a.cost - b.cost || b.yield - a.yield);

  // Pareto frontier (cost ↑, yield ↑)
  const pareto = [];
  let bestYieldSoFar = -Infinity;
  for (const c of candidatesByCost) {
    if (c.yield > bestYieldSoFar + 1e-9) {
      pareto.push({ cost: c.cost, yield: c.yield, id: c.id, label: c.label, adjustments: c.adjustments });
      bestYieldSoFar = c.yield;
    }
  }

  const recommended = currentEval;
  const gain = recommended.yield - baseYield;
  const alternatives = candidatesByYield
    .filter((c) => c.id !== recommended.id && c.id !== base.id && c.yield > baseYield + 1e-6)
    .slice(0, 8)
    .map((c) => ({
      id: c.id,
      label: c.label,
      yield: c.yield,
      cost: c.cost,
      gain: c.yield - baseYield,
      adjustments: c.adjustments,
      feasible: c.feasible,
      violations: c.violations,
    }));

  const recommendedOut = {
    id: recommended.id,
    label: recommended.label,
    version: recommended.version,
    fingerprint: recommended.fingerprint,
    yield: recommended.yield,
    cost: recommended.cost,
    gain,
    gainPerCost: recommended.cost > 1e-9 ? gain / recommended.cost : gain > 0 ? Infinity : 0,
    feasible: recommended.feasible,
    violations: recommended.violations,
    adjustments: recommended.adjustments,
    constraints: recommended.constraints,
    extrapolated: recommended.extrapolated,
    partialCoverage: recommended.partialCoverage,
  };

  const rejected = Array.from(cache.values())
    .filter((r) => !r.feasible)
    .slice(0, 12)
    .map((r) => ({ label: r.label, yield: r.yield, cost: r.cost, violations: r.violations }));

  return {
    budget,
    currency: scenario.budget.currency,
    evaluations,
    base: {
      id: base.id,
      label: '原方案',
      version: base.version,
      fingerprint: base.fingerprint,
      yield: base.yield,
      cost: base.cost,
      feasible: base.feasible,
      adjustments: base.adjustments,
      constraints: base.constraints,
    },
    recommended: recommendedOut,
    alternatives,
    pareto,
    probes: ranked.slice(0, 60).map((p) => ({
      kind: p.kind,
      key: p.key,
      value: p.value,
      label: p.label,
      yield: p.result.yield,
      gain: p.gain,
      cost: p.result.cost,
      efficiency: p.efficiency,
    })),
    steps,
    rejected,
    lockedKeys: Array.from(locked),
  };
}

function labelForKey(key, scenario) {
  const idx = key.indexOf('.');
  const partId = key.slice(0, idx);
  const variableId = key.slice(idx + 1);
  const part = scenario.parts.find((p) => p.id === partId);
  const v = part && part.variables.find((x) => x.id === variableId);
  return part && v ? `${part.label}·${v.label}` : key;
}

module.exports = {
  optimize,
  evaluateCandidate,
  stepGrid,
  impliedShifts,
  candidateId,
  cloneVersion,
  emptyVersion,
};
