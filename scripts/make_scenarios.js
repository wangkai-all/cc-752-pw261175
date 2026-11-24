'use strict';

/**
 * Generate the fictional demo scenarios.
 * Deterministic: fixed seed, fixed rounding. Output goes to data/scenarios/.
 *
 * Run: node scripts/make_scenarios.js
 */

const fs = require('fs');
const path = require('path');
const { mulberry32, makeNormal } = require('../src/core/rng');
const { cholesky } = require('../src/core/stats');

const OUT = path.join(__dirname, '..', 'data', 'scenarios');

function corrMatrix(ids, pairs) {
  const p = ids.length;
  const R = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < p; i++) R[i][i] = 1;
  for (const [a, b, r] of pairs) {
    const i = ids.indexOf(a);
    const j = ids.indexOf(b);
    R[i][j] = r;
    R[j][i] = r;
  }
  const L = cholesky(R, 1e-9);
  if (!L) throw new Error(`correlation matrix not positive definite: ${JSON.stringify(pairs)}`);
  return L;
}

function gaussianRows(seed, n, ids, pairs) {
  const rand = mulberry32(seed);
  const normal = makeNormal(rand);
  const L = corrMatrix(ids, pairs);
  const rows = [];
  for (let s = 0; s < n; s++) {
    const z = ids.map(() => normal());
    const y = ids.map((_, i) => {
      let acc = 0;
      for (let j = 0; j <= i; j++) acc += L[i][j] * z[j];
      return acc;
    });
    rows.push(y);
  }
  return rows;
}

const r4 = (x) => Math.round(x * 1e4) / 1e4;

function normalColumn(rows, j, mean, sd, digits = 4) {
  return rows.map((r) => r4(mean + sd * r[j]));
}
function lognormalColumn(rows, j, mean, sd, digits = 4) {
  const cv2 = (sd / mean) ** 2;
  const mu = Math.log(mean) - 0.5 * Math.log(1 + cv2);
  const sig = Math.sqrt(Math.log(1 + cv2));
  return rows.map((r) => r4(Math.exp(mu + sig * r[j])));
}
function halfNormalLike(rows, j, mean, sd, digits = 4) {
  // gamma-ish positive skewed values with target mean/sd
  const shape = (mean / sd) ** 2;
  const scale = (sd * sd) / mean;
  return rows.map((r) => {
    // Wilson-Hilferty transform of the normal latent to approximate gamma
    const z = r[j];
    const v = Math.max(1e-6, 1 - 1 / (9 * shape) + Math.sqrt(1 / (9 * shape)) * z);
    return r4(scale * shape * Math.pow(v, 3));
  });
}

function buildPart(spec) {
  // spec: { id, label, n, seed, vars:[{id,label,dist,mean,sd,spec,cost}], corr:[[a,b,r]] }
  const ids = spec.vars.map((v) => v.id);
  const g = gaussianRows(spec.seed, spec.n, ids, spec.corr || []);
  const columns = [];
  const colValues = [];
  spec.vars.forEach((v, j) => {
    let vals;
    if (v.dist === 'lognormal') vals = lognormalColumn(g, j, v.mean, v.sd);
    else if (v.dist === 'gamma') vals = halfNormalLike(g, j, v.mean, v.sd);
    else vals = normalColumn(g, j, v.mean, v.sd);
    colValues.push(vals);
    columns.push(v.id);
  });
  const rows = [];
  for (let i = 0; i < spec.n; i++) rows.push(colValues.map((c) => c[i]));
  return {
    definition: {
      id: spec.id,
      label: spec.label,
      variables: spec.vars.map((v) => ({
        id: v.id,
        label: v.label,
        unit: 'mm',
        dist: v.dist === 'gamma' ? 'auto' : v.dist || 'auto',
        ...(v.spec ? { spec: v.spec } : {}),
        cost: v.cost,
      })),
    },
    dataset: { columns, rows },
  };
}

function scenarioA() {
  const housing = buildPart({
    id: 'housing',
    label: '壳体',
    n: 60,
    seed: 1001,
    vars: [
      { id: 'bore', label: '内孔直径', dist: 'normal', mean: 40.0, sd: 0.007, spec: { lower: 39.95, upper: 40.05 }, cost: { perShift: 1400, perSigma: 1100, maxShift: 0.02, minSigmaScale: 0.6 } },
      { id: 'depth', label: '止口深度', dist: 'normal', mean: 12.03, sd: 0.018, spec: { lower: 11.92, upper: 12.08 }, cost: { perShift: 900, perSigma: 700, maxShift: 0.03, minSigmaScale: 0.55 } },
      { id: 'faceFlat', label: '端面平面度', dist: 'gamma', mean: 0.018, sd: 0.005, spec: { upper: 0.04 }, cost: { perShift: 0, perSigma: 800, maxShift: 0, minSigmaScale: 0.55 } },
    ],
    corr: [
      ['bore', 'depth', 0.4],
      ['bore', 'faceFlat', 0.5],
      ['depth', 'faceFlat', 0.5],
    ],
  });
  const shaft = buildPart({
    id: 'shaft',
    label: '输入轴',
    n: 60,
    seed: 1002,
    vars: [
      { id: 'journal', label: '轴颈直径', dist: 'normal', mean: 39.966, sd: 0.0055, spec: { lower: 39.94, upper: 40.0 }, cost: { perShift: 1600, perSigma: 1300, maxShift: 0.02, minSigmaScale: 0.6 } },
      { id: 'length', label: '轴长', dist: 'normal', mean: 11.66, sd: 0.02, spec: { lower: 11.54, upper: 11.72 }, cost: { perShift: 800, perSigma: 900, maxShift: 0.03, minSigmaScale: 0.6 } },
      { id: 'shoulder', label: '轴肩端跳', dist: 'gamma', mean: 0.012, sd: 0.004, spec: { upper: 0.03 }, cost: { perShift: 0, perSigma: 750, maxShift: 0, minSigmaScale: 0.55 } },
    ],
    corr: [
      ['journal', 'length', 0.85],
      ['journal', 'shoulder', -0.5],
      ['length', 'shoulder', -0.6],
    ],
  });
  const shim = buildPart({
    id: 'shim',
    label: '调整垫片',
    n: 60,
    seed: 1003,
    vars: [
      { id: 'thickness', label: '厚度', dist: 'normal', mean: 0.205, sd: 0.004, spec: { lower: 0.18, upper: 0.22 }, cost: { perShift: 400, perSigma: 300, maxShift: 0.01, minSigmaScale: 0.5 } },
      { id: 'flatness', label: '平面度', dist: 'gamma', mean: 0.008, sd: 0.002, spec: { upper: 0.02 }, cost: { perShift: 0, perSigma: 500, maxShift: 0, minSigmaScale: 0.5 } },
    ],
    corr: [['thickness', 'flatness', -0.5]],
  });
  return {
    name: '减速器端盖装配',
    description:
      '三个零件各有测量数据。每个尺寸单独看都在自身规格内，但端隙、径向间隙与端面贴合三个装配约束同时满足的联合合格率明显更低。',
    story:
      '典型“单尺寸合格、装配不合格”：单尺寸超差率低于 0.1%，但三个装配约束叠加后联合合格率约七成；中心值整体偏向端隙上界，调整止口深度中心可以显著改善。',
    parts: [housing.definition, shaft.definition, shim.definition],
    datasets: { housing: housing.dataset, shaft: shaft.dataset, shim: shim.dataset },
    constraints: [
      {
        id: 'endplay',
        label: '端隙',
        kind: 'assembly',
        terms: [
          { part: 'housing', variable: 'depth', coef: 1 },
          { part: 'shaft', variable: 'length', coef: -1 },
          { part: 'shim', variable: 'thickness', coef: -1 },
        ],
        lower: 0.142,
        upper: 0.208,
      },
      {
        id: 'clearance',
        label: '径向间隙',
        kind: 'assembly',
        terms: [
          { part: 'housing', variable: 'bore', coef: 1 },
          { part: 'shaft', variable: 'journal', coef: -1 },
        ],
        lower: 0.018,
        upper: 0.052,
      },
      {
        id: 'faceContact',
        label: '端面贴合量',
        kind: 'assembly',
        terms: [
          { part: 'housing', variable: 'faceFlat', coef: 1 },
          { part: 'shaft', variable: 'shoulder', coef: 1 },
          { part: 'shim', variable: 'flatness', coef: 1 },
        ],
        lower: 0,
        upper: 0.051,
      },
    ],
    simulation: { seed: 20261124, drawsPerPart: 4000, method: 'empirical', correlationShrinkage: 0.08, tailSensitivity: true },
    budget: { total: 80, currency: '元' },
    meta: {
      accent: 'assembly-failure',
      tags: ['装配失败反例', '零件内相关', '成本优化'],
    },
  };
}

function scenarioB() {
  const body = buildPart({
    id: 'body',
    label: '泵体',
    n: 60,
    seed: 2001,
    vars: [
      { id: 'boreA', label: '主动孔直径', dist: 'normal', mean: 12.0, sd: 0.007, spec: { lower: 11.95, upper: 12.05 }, cost: { perShift: 900, perSigma: 700, maxShift: 0.012, minSigmaScale: 0.55 } },
      { id: 'boreB', label: '从动孔直径', dist: 'normal', mean: 12.0, sd: 0.007, spec: { lower: 11.95, upper: 12.05 }, cost: { perShift: 900, perSigma: 700, maxShift: 0.012, minSigmaScale: 0.55 } },
      { id: 'centerDist', label: '孔距', dist: 'normal', mean: 18.0, sd: 0.004, spec: { lower: 17.98, upper: 18.02 }, cost: { perShift: 700, perSigma: 600, maxShift: 0.01, minSigmaScale: 0.6 } },
    ],
    corr: [
      ['boreA', 'boreB', 0.95],
      ['boreA', 'centerDist', 0.15],
      ['boreB', 'centerDist', 0.15],
    ],
  });
  return {
    name: '双孔泵体：强相关反例',
    description:
      '两个孔由同一次镗削加工，孔径强正相关（r≈0.95）。跨棒距约束由两孔共同决定；若把两列各自打乱当作独立样本，会高估装配合格率。',
    story:
      '强相关：把同一零件的两个孔径分别重排会破坏相关结构，联合分布方差被低估，合格率虚高。经验重采样保留整行，参数法用相关矩阵，两者一致；独立假设只作为错误对照显示。',
    parts: [body.definition],
    datasets: { body: body.dataset },
    constraints: [
      {
        id: 'overPins',
        label: '跨棒距',
        kind: 'assembly',
        terms: [
          { part: 'body', variable: 'centerDist', coef: 1 },
          { part: 'body', variable: 'boreA', coef: 0.5 },
          { part: 'body', variable: 'boreB', coef: 0.5 },
        ],
        lower: 29.994,
        upper: 30.006,
      },
    ],
    simulation: { seed: 20261125, drawsPerPart: 4000, method: 'empirical', correlationShrinkage: 0.05, tailSensitivity: true },
    budget: { total: 45, currency: '元' },
    meta: {
      accent: 'correlation',
      tags: ['强相关', '错误独立对照', '单零件'],
    },
  };
}

function scenarioC() {
  const housing = buildPart({
    id: 'cover',
    label: '端盖',
    n: 45,
    seed: 3001,
    vars: [
      { id: 'pocket', label: '止口深度', dist: 'normal', mean: 9.5, sd: 0.012, spec: { lower: 9.44, upper: 9.56 }, cost: { perShift: 1000, perSigma: 800, maxShift: 0.02, minSigmaScale: 0.6 } },
      { id: 'bore', label: '止口径', dist: 'normal', mean: 25.0, sd: 0.008, spec: { lower: 24.96, upper: 25.04 }, cost: { perShift: 1100, perSigma: 900, maxShift: 0.02, minSigmaScale: 0.6 } },
    ],
    corr: [['pocket', 'bore', 0.4]],
  });
  const shaft = buildPart({
    id: 'rotor',
    label: '转子',
    n: 45,
    seed: 3002,
    vars: [
      { id: 'height', label: '轴肩高度', dist: 'normal', mean: 8.9, sd: 0.01, spec: { lower: 8.85, upper: 8.95 }, cost: { perShift: 1200, perSigma: 1000, maxShift: 0.02, minSigmaScale: 0.6 } },
      { id: 'diameter', label: '轴肩直径', dist: 'normal', mean: 24.94, sd: 0.006, spec: { lower: 24.9, upper: 24.98 }, cost: { perShift: 1200, perSigma: 900, maxShift: 0.02, minSigmaScale: 0.6 } },
    ],
    corr: [['height', 'diameter', -0.3]],
  });
  return {
    name: '新轴承尺寸外推',
    description:
      '新供应商轴承宽度还没有到货测量数据，只能按供应商声明的分布（均值/标准差）外推。包含该尺寸的轴向间隙约束会被明确标记为“外推”，其合格率没有训练数据支撑。',
    story:
      '外推不是错误，但必须标出来：轴承宽度没有任何测量行，经验重采样也无法从数据中抽到它；模型按声明正态分布抽样，并在约束上打“外推”标记。含该尺寸的轴向间隙结论只能作为假设情景。',
    parts: [
      housing.definition,
      shaft.definition,
      {
        id: 'bearing',
        label: '新轴承',
        variables: [
          {
            id: 'width',
            label: '轴承宽度',
            unit: 'mm',
            dist: 'auto',
            assumed: { mean: 0.600, sd: 0.004, dist: 'normal' },
            spec: { lower: 0.59, upper: 0.61 },
            cost: { perShift: 0, perSigma: 0, maxShift: 0, minSigmaScale: 0.9 },
            locked: true,
          },
        ],
      },
    ],
    datasets: { cover: housing.dataset, rotor: shaft.dataset, bearing: { columns: [], rows: [[], []] } },
    constraints: [
      {
        id: 'axialClearance',
        label: '轴向间隙（含外推轴承）',
        kind: 'assembly',
        terms: [
          { part: 'cover', variable: 'pocket', coef: 1 },
          { part: 'rotor', variable: 'height', coef: -1 },
          { part: 'bearing', variable: 'width', coef: -1 },
        ],
        lower: 0.0,
        upper: 0.02,
      },
      {
        id: 'radialClearance',
        label: '径向间隙',
        kind: 'assembly',
        terms: [
          { part: 'cover', variable: 'bore', coef: 1 },
          { part: 'rotor', variable: 'diameter', coef: -1 },
        ],
        lower: 0.02,
        upper: 0.09,
      },
    ],
    simulation: { seed: 20261126, drawsPerPart: 4000, method: 'empirical', correlationShrinkage: 0.1, tailSensitivity: true },
    budget: { total: 50, currency: '元' },
    meta: {
      accent: 'extrapolation',
      tags: ['外推标记', '无测量数据', '不可调参数'],
    },
  };
}

function scenarioD() {
  const flange = buildPart({
    id: 'flange',
    label: '法兰',
    n: 14,
    seed: 4001,
    vars: [
      { id: 'holePos', label: '孔位偏差', dist: 'gamma', mean: 0.012, sd: 0.010, spec: { lower: -0.01, upper: 0.04 }, cost: { perShift: 600, perSigma: 500, maxShift: 0.008, minSigmaScale: 0.5 } },
    ],
    corr: [],
  });
  const sleeve = buildPart({
    id: 'sleeve',
    label: '轴套',
    n: 14,
    seed: 4002,
    vars: [
      { id: 'pinPos', label: '销位偏差', dist: 'gamma', mean: 0.006, sd: 0.006, spec: { lower: -0.01, upper: 0.03 }, cost: { perShift: 600, perSigma: 500, maxShift: 0.008, minSigmaScale: 0.5 } },
    ],
    corr: [],
  });
  return {
    name: '小样本尾部敏感性',
    description:
      '每个零件只有 14 行测量，且偏差分布右偏。经验重采样只能在已观测值内取值，参数分布会向尾部外推；两种方式在小样本尾部的结论不同，这里并排给出敏感性。',
    story:
      '小样本 + 偏态：经验重采样最多重复观测到的最大值，参数正态/t 分布能越过观测范围。轴向/径向对尾部的敏感度不同，并排比较经验、正态、t 尾三种假设，避免把某一种模型的尾部当成事实。',
    parts: [flange.definition, sleeve.definition],
    datasets: { flange: flange.dataset, sleeve: sleeve.dataset },
    constraints: [
      {
        id: 'interference',
        label: '装配偏差',
        kind: 'assembly',
        terms: [
          { part: 'flange', variable: 'holePos', coef: 1 },
          { part: 'sleeve', variable: 'pinPos', coef: -1 },
        ],
        lower: -0.004,
        upper: 0.03,
      },
    ],
    simulation: { seed: 20261127, drawsPerPart: 4000, method: 'empirical', correlationShrinkage: 0.1, tailSensitivity: true },
    budget: { total: 30, currency: '元' },
    meta: {
      accent: 'small-sample',
      tags: ['小样本', '尾部敏感', '积分/穷举对照'],
    },
  };
}

function scenarioE() {
  const plate = buildPart({
    id: 'plate',
    label: '连接板',
    n: 18,
    seed: 5001,
    vars: [
      { id: 'span', label: '孔距', dist: 'normal', mean: 60.0, sd: 0.012, spec: { lower: 59.95, upper: 60.05 }, cost: { perShift: 800, perSigma: 650, maxShift: 0.015, minSigmaScale: 0.55 } },
    ],
    corr: [],
  });
  const bracket = buildPart({
    id: 'bracket',
    label: '支架',
    n: 18,
    seed: 5002,
    vars: [
      { id: 'span', label: '销距', dist: 'normal', mean: 59.985, sd: 0.009, spec: { lower: 59.94, upper: 60.03 }, cost: { perShift: 700, perSigma: 600, maxShift: 0.015, minSigmaScale: 0.55 } },
    ],
    corr: [],
  });
  return {
    name: '小维度数值积分对照',
    description:
      '单一装配约束只涉及两个尺寸，适合做数值积分/穷举精确解对照：经验模型可穷举所有测量行组合（18×18），参数正态模型可用二维积分得到解析对照，用来验证蒙特卡洛抽样数是否足够。',
    story:
      '小维度校核：约束只涉及两个正态尺寸。二维数值积分和穷举（经验模型的精确解）都能算出几乎无抽样误差的合格率，与蒙特卡洛结果比对，验证 4000 次抽样是否稳定。',
    parts: [plate.definition, bracket.definition],
    datasets: { plate: plate.dataset, bracket: bracket.dataset },
    constraints: [
      {
        id: 'spanFit',
        label: '跨距配合',
        kind: 'assembly',
        terms: [
          { part: 'plate', variable: 'span', coef: 1 },
          { part: 'bracket', variable: 'span', coef: -1 },
        ],
        lower: 0.0,
        upper: 0.03,
      },
    ],
    simulation: { seed: 20261128, drawsPerPart: 4000, method: 'empirical', correlationShrinkage: 0.1, tailSensitivity: true },
    budget: { total: 25, currency: '元' },
    meta: {
      accent: 'verification',
      tags: ['数值积分', '穷举', '小维度'],
    },
  };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const scenarios = {
    'reducer-cover.json': scenarioA(),
    'pump-body-correlation.json': scenarioB(),
    'bearing-extrapolation.json': scenarioC(),
    'small-sample-tails.json': scenarioD(),
    'small-dimension-check.json': scenarioE(),
  };
  for (const [file, sc] of Object.entries(scenarios)) {
    fs.writeFileSync(path.join(OUT, file), JSON.stringify(sc, null, 2) + '\n');
    console.log(`wrote ${file}`);
  }
}

main();
