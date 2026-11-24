/* Tolerance Yield Lab — application logic.
   No framework: plain DOM, fetch, and the small SVG chart helpers in charts.js. */
(function () {
  'use strict';
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const html = Charts.html;
  const esc = Charts.esc;
  const fmtNum = Charts.fmtNum;
  const fmtPct = (x, d = 2) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
  const fmtSignedPct = (x, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)} 个百分点` : '—');
  const fmtMoney = (x, cur = '元') => `${Number(x).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${cur}`;
  const emptyVersion = () => ({ shifts: {}, sigmas: {} });

  const state = {
    scenario: null,
    analysis: null,
    version: emptyVersion(),
    section: null,
    verification: null,
    optimization: null,
    compare: null,
    demoList: null,
    lastSectionQuery: null,
  };

  // ---------------- utilities ----------------
  function api(path, body) {
    return fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => {
      let data = null;
      try {
        data = await r.json();
      } catch (e) {
        throw new Error(`服务器返回无法解析（HTTP ${r.status}）`);
      }
      if (!r.ok || data.ok === false) throw new Error(data.error || `请求失败（HTTP ${r.status}）`);
      return data;
    });
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    const el = $('#toast');
    el.innerHTML = `<span class="glyph">${isErr ? '⚠️' : '✅'}</span><span>${esc(msg)}</span>`;
    el.classList.toggle('err', Boolean(isErr));
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), isErr ? 7000 : 3500);
  }

  function busy(btn, on, label) {
    if (!btn) return;
    if (on) {
      btn.dataset.orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner" style="width:12px;height:12px;border-width:2px"></span>${esc(label || '计算中…')}`;
    } else {
      btn.disabled = false;
      if (btn.dataset.orig) btn.innerHTML = btn.dataset.orig;
    }
  }

  function showPanel(name) {
    $$('.panel').forEach((p) => {
      p.hidden = p.id !== `panel-${name}`;
    });
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.panel === name)));
    if (name === 'onboard') renderOnboardVisibility();
    if (name === 'explain' && state.analysis && !state.section) drawSection();
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/json;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 0);
  }

  function optionsFromUI() {
    const method = ($('#simMethod') && $('#simMethod').value) || 'empirical';
    const draws = Number(($('#simDraws') && $('#simDraws').value) || 4000);
    const seed = Number(($('#simSeed') && $('#simSeed').value) || 20261124);
    return { method, draws, seed };
  }

  // ---------------- tab handling ----------------
  $$('.tab').forEach((t) => t.addEventListener('click', () => showPanel(t.dataset.panel)));
  window.addEventListener('hashchange', () => {
    const m = location.hash.match(/^#(onboard|overview|explain|optimize|compare)$/);
    if (m) showPanel(m[1]);
  });

  $('#themeToggle').addEventListener('click', () => {
    const root = document.documentElement;
    const cur = root.getAttribute('data-theme');
    const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark' : sysDark ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('tyl-theme', next);
    } catch (e) {}
    redrawCharts();
  });
  try {
    const savedTheme = localStorage.getItem('tyl-theme');
    if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
  } catch (e) {}

  function redrawCharts() {
    if (state.analysis) {
      renderOverviewCharts();
      if (state.section) renderSection();
      if (state.optimization) renderOptimizationCharts();
    }
  }
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redrawCharts, 200);
  });

  // ---------------- scenario chip ----------------
  function updateChip() {
    const chip = $('#scenarioChip');
    if (!state.scenario) {
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    $('#scenarioChipName').textContent = state.scenario.name || '未命名方案';
    const a = state.analysis;
    $('#scenarioChipMeta').textContent = a
      ? `${a.options.method === 'empirical' ? '经验' : '参数'} · ${a.baseline.draws.toLocaleString()} 次`
      : '';
  }

  // =========================================================
  // ① onboarding
  // =========================================================
  const builder = {
    active: false,
    step: 1,
    name: '新建装配分析',
    budget: 50,
    currency: '元',
    method: 'empirical',
    draws: 4000,
    seed: 20261124,
    parts: [],
    constraints: [],
    costByKey: {},
    costEnabled: false,
  };

  function newPartId() {
    let i = builder.parts.length + 1;
    while (builder.parts.some((p) => p.id === `part${i}`)) i++;
    return `part${i}`;
  }

  function blankPart() {
    return {
      id: newPartId(),
      label: '零件',
      csv: 'feature_a,feature_b\n',
    };
  }

  function blankConstraint() {
    return {
      id: `c${builder.constraints.length + 1}`,
      label: '装配约束',
      terms: [{ part: '', variable: '', coef: 1 }],
      lower: '',
      upper: '',
    };
  }

  function parseCSV(text) {
    const lines = String(text)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length && !l.startsWith('#'));
    if (!lines.length) return { columns: [], rows: [], error: '没有数据行' };
    const delim = lines[0].includes('\t') ? '\t' : lines[0].includes(',') ? ',' : /\s+/;
    const split = (line) => line.split(delim).map((s) => s.trim()).filter((s, i, arr) => !(i === arr.length - 1 && s === ''));
    const columns = split(lines[0]);
    if (columns.length < 1) return { columns: [], rows: [], error: '缺少表头' };
    if (new Set(columns).size !== columns.length) return { columns: [], rows: [], error: '表头有重复列名' };
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = split(lines[i]);
      if (!parts.length) continue;
      if (parts.length !== columns.length) return { columns, rows, error: `第 ${i + 1} 行有 ${parts.length} 个值，表头有 ${columns.length} 列` };
      const nums = parts.map((p) => Number(p));
      if (nums.some((n) => !Number.isFinite(n))) return { columns, rows, error: `第 ${i + 1} 行包含非数字` };
      rows.push(nums);
    }
    return { columns, rows, error: null };
  }

  function renderOnboardVisibility() {
    const start = $('#onboardStart');
    if (!start) return;
    start.hidden = builder.active || !$('#onboardPaste').hidden;
    $('#onboardBuilder').hidden = !builder.active;
    if (builder.active) renderBuilder();
  }

  function resetBuilder() {
    builder.active = true;
    builder.step = 1;
    builder.name = '新建装配分析';
    builder.budget = 50;
    builder.currency = '元';
    builder.method = 'empirical';
    builder.draws = 4000;
    builder.seed = 20261124;
    builder.parts = [blankPart()];
    builder.constraints = [blankConstraint()];
    builder.costByKey = {};
    builder.costEnabled = false;
    hideDemoPicker();
    $('#onboardPaste').hidden = true;
    renderOnboardVisibility();
  }

  function hideDemoPicker() {
    const host = $('#onboardDemoPicker');
    if (host) {
      host.hidden = true;
      host.innerHTML = '';
    }
  }

  $('#newScenarioBtn').addEventListener('click', () => {
    resetBuilder();
    showPanel('onboard');
    $('#builderStep1').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#startPaste').addEventListener('click', () => {
    hideDemoPicker();
    $('#onboardPaste').hidden = false;
    renderOnboardVisibility();
    $('#pasteArea').focus();
  });
  $('#startDemo').addEventListener('click', () => loadDemo());
  $('#loadDemoBtn').addEventListener('click', () => {
    showPanel('onboard');
    loadDemo();
  });
  $('#startFile').addEventListener('click', () => $('#fileImportInput').click());

  // Drag a .json scenario (or a .csv table) anywhere onto the page.
  function readDroppedFile(f) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result);
      if (/\.json$/i.test(f.name) || text.trim().startsWith('{')) {
        try {
          const obj = JSON.parse(text);
          builder.active = false;
          hideDemoPicker();
          $('#onboardPaste').hidden = true;
          applyScenario(obj, f.name);
        } catch (err) {
          toast(`文件不是有效的方案 JSON：${err.message}`, true);
        }
      } else {
        // treat as one part's measurement table and open the builder
        resetBuilder();
        builder.parts[0].csv = text;
        builder.parts[0].label = f.name.replace(/\.[^.]+$/, '');
        builder.name = f.name.replace(/\.[^.]+$/, '');
        ensureCosts(builder.parts[0], parseCSV(text));
        renderOnboardVisibility();
        showPanel('onboard');
        toast('已读入测量表；请补全装配约束');
      }
    };
    reader.readAsText(f);
  }
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
      document.body.classList.add('dragging');
    }
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) document.body.classList.remove('dragging');
  });
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    document.body.classList.remove('dragging');
    readDroppedFile(e.dataTransfer.files[0]);
  });
  $('#fileImportInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    readDroppedFile(f);
    e.target.value = '';
  });

  async function loadDemo() {
    try {
      if (!state.demoList) {
        const r = await api('/api/scenarios');
        state.demoList = r.scenarios;
      }
      renderDemoPicker(state.demoList);
    } catch (e) {
      toast(e.message, true);
    }
  }

  function renderDemoPicker(list) {
    builder.active = false;
    $('#onboardPaste').hidden = true;
    $('#onboardBuilder').hidden = true;
    const start = $('#onboardStart');
    start.hidden = true;
    const host = $('#onboardDemoPicker');
    host.hidden = false;
    host.innerHTML = '';
    const wrap = html('div', { class: 'card' }, host);
    const head = html('div', { class: 'card-head' }, wrap);
    html('div', {}, head).innerHTML =
      '<h2>选择一个虚构示例</h2><div class="sub">每个方案都刻意演示一类问题：装配失败反例、强相关、外推、小样本尾部、小维度校核。</div>';
    const actions = html('div', { class: 'actions' }, head);
    const back = html('button', { class: 'btn sm', type: 'button', text: '返回' }, actions);
    back.addEventListener('click', () => {
      hideDemoPicker();
      start.hidden = false;
      renderOnboardVisibility();
    });
    const grid = html('div', { class: 'scenario-pick' }, wrap);
    for (const s of list) {
      const card = html('button', { class: 'scenario-option', type: 'button' }, grid);
      html('div', { class: 'nm', text: s.name }, card);
      html('div', { class: 'ds', text: s.description }, card);
      const meta = html('div', { class: 'chip-list', style: 'margin-top:8px' }, card);
      for (const t of s.tags) html('span', { class: 'badge neutral', text: t }, meta);
      html(
        'div',
        {
          class: 'pill-note',
          style: 'margin-top:6px',
          text: `${s.parts.length} 个零件 · ${s.constraints} 条约束 · 预算 ${s.budget} 元`,
        },
        card,
      );
      card.addEventListener('click', async () => {
        card.disabled = true;
        try {
          const r = await api(`/api/scenarios/${encodeURIComponent(s.file)}`);
          hideDemoPicker();
          start.hidden = false;
          applyScenario(r.scenario, s.file);
        } catch (e) {
          toast(e.message, true);
          card.disabled = false;
        }
      });
    }
  }

  /** Load a raw scenario, optionally run analysis immediately. */
  async function applyScenario(raw, file) {
    state.scenario = raw;
    state.analysis = null;
    state.version = emptyVersion();
    state.section = null;
    state.verification = null;
    state.optimization = null;
    state.compare = null;
    $('#simMethod').value = (raw.simulation && raw.simulation.method) || 'empirical';
    $('#simDraws').value = String((raw.simulation && raw.simulation.drawsPerPart) || 4000);
    $('#simSeed').value = String((raw.simulation && raw.simulation.seed) || 20261124);
    $('#optBudget').value = String((raw.budget && raw.budget.total) || 0);
    updateChip();
    try {
      const res = await api('/api/analyze', { scenario: raw, options: optionsFromUI() });
      state.analysis = res;
      updateChip();
      renderAll();
      showPanel('overview');
      toast('分析完成');
    } catch (e) {
      toast(`分析失败：${e.message}`, true);
      showPanel('onboard');
    }
  }

  // ---------------- builder rendering ----------------
  function renderBuilder() {
    if (!builder.active) return;
    $$('.step-pill', $('#builderSteps')).forEach((el, i) => {
      el.classList.toggle('active', i + 1 === builder.step);
      el.classList.toggle('done', i + 1 < builder.step);
    });
    renderPartList();
    renderConstraintList();
    $('#budgetName').value = builder.name;
    $('#budgetTotal').value = String(builder.budget);
    $('#budgetCurrency').value = builder.currency;
    $('#simMethod').value = builder.method;
    $('#simDraws').value = String(builder.draws);
    $('#simSeed').value = String(builder.seed);
    renderBuilderSummary();
  }

  function csvExample() {
    return `feature_a,feature_b\n40.002,11.998\n39.997,12.004\n40.004,11.996\n40.001,12.002\n39.996,11.993\n40.003,12.006\n39.999,12.001\n40.005,11.997`;
  }

  function renderPartList() {
    const host = $('#partDataList');
    host.innerHTML = '';
    builder.parts.forEach((part, idx) => {
      const parsed = parseCSV(part.csv);
      const card = html('div', { class: 'builder-part' }, host);
      const head = html('div', { class: 'row', style: 'margin-bottom:10px' }, card);
      const idField = html('div', { class: 'field', style: 'width:140px' }, head);
      html('label', { text: '零件 ID' }, idField);
      const idInp = html('input', { type: 'text', value: part.id }, idField);
      idInp.addEventListener('change', () => {
        const old = part.id;
        const nid = idInp.value.trim().replace(/[^\w一-龥-]/g, '') || old;
        if (builder.parts.some((p) => p !== part && p.id === nid)) {
          toast('零件 ID 不能重复', true);
          idInp.value = old;
          return;
        }
        // remap constraint terms and cost keys
        builder.constraints.forEach((c) => c.terms.forEach((t) => {
          if (t.part === old) t.part = nid;
        }));
        const newCosts = {};
        for (const k of Object.keys(builder.costByKey)) {
          const [pid, ...rest] = k.split('.');
          newCosts[`${pid === old ? nid : pid}.${rest.join('.')}`] = builder.costByKey[k];
        }
        builder.costByKey = newCosts;
        part.id = nid;
        renderBuilder();
      });
      const labelField = html('div', { class: 'field', style: 'flex:1;min-width:140px' }, head);
      html('label', { text: '显示名称' }, labelField);
      const labelInp = html('input', { type: 'text', value: part.label }, labelField);
      labelInp.addEventListener('input', () => {
        part.label = labelInp.value;
        renderBuilderSummary();
      });
      const remove = html('button', { class: 'btn sm danger', type: 'button', text: '删除零件' }, head);
      remove.style.marginLeft = 'auto';
      remove.disabled = builder.parts.length <= 1;
      remove.addEventListener('click', () => {
        builder.parts.splice(idx, 1);
        builder.constraints.forEach((c) => c.terms.forEach((t) => {
          if (t.part === part.id) {
            t.part = '';
            t.variable = '';
          }
        }));
        renderBuilder();
      });

      const areaField = html('div', { class: 'field', style: 'margin-top:8px' }, card);
      const lbl = html('label', {}, areaField);
      lbl.innerHTML = `测量表（第一行表头；每行一个真实零件） <span class="muted tiny">· ${parsed.rows.length} 行 · ${parsed.columns.length} 列</span>`;
      const ta = html('textarea', { rows: Math.min(10, Math.max(4, parsed.rows.length + 1)), spellcheck: 'false' }, areaField);
      ta.value = part.csv;
      ta.addEventListener('input', () => {
        part.csv = ta.value;
        const p2 = parseCSV(ta.value);
        const counter = lbl.querySelector('span');
        if (counter) counter.textContent = `· ${p2.rows.length} 行 · ${p2.columns.length} 列`;
        renderBuilderSummary();
      });
      ta.addEventListener('blur', () => {
        renderPartMeta(card, part, parsed);
        ensureCosts(part, parseCSV(part.csv));
        renderBuilderSummary();
      });
      if (parsed.error) {
        html('div', { class: 'callout danger', style: 'margin-top:8px', text: parsed.error }, areaField);
      }
      const meta = html('div', { class: 'stack', style: 'margin-top:8px' }, card);
      meta.dataset.meta = '1';
      renderPartMeta(meta, part, parsed);
      ensureCosts(part, parsed);

      if (builder.costEnabled) renderCostEditor(card, part, parsed);
    });
    const toggle = html('div', { class: 'row', style: 'margin-top:4px' }, host);
    const chk = html('label', { class: 'check' }, toggle);
    const cb = html('input', { type: 'checkbox' }, chk);
    cb.checked = builder.costEnabled;
    cb.addEventListener('change', () => {
      builder.costEnabled = cb.checked;
      renderBuilder();
    });
    chk.appendChild(document.createTextNode('编辑加工参数与调整成本（优化需要）'));
    if (!builder.costEnabled) {
      html('span', { class: 'hint', text: '默认成本为零：可以模拟，但优化不会推荐该尺寸的调整。' }, toggle);
    }
  }

  function ensureCosts(part, parsed) {
    for (const c of parsed.columns) {
      const key = `${part.id}.${c}`;
      if (!builder.costByKey[key]) {
        builder.costByKey[key] = { perShift: 800, perSigma: 600, maxShift: 0.02, minSigmaScale: 0.6 };
      }
    }
  }

  function renderPartMeta(host, part, parsed) {
    const meta = host.dataset && host.dataset.meta ? host : host.querySelector('[data-meta="1"]');
    const target = meta || host;
    target.innerHTML = '';
    if (parsed.error || !parsed.columns.length) return;
    const cols = parsed.columns;
    const stats = cols.map((c, j) => {
      const xs = parsed.rows.map((r) => r[j]);
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
      return { c, m, sd, min: Math.min(...xs), max: Math.max(...xs) };
    });
    const wrap = html('div', { class: 'table-wrap' }, target);
    const t = html('table', {}, wrap);
    t.innerHTML = `<thead><tr><th>尺寸列</th><th class="num">均值</th><th class="num">标准差</th><th class="num">范围</th></tr></thead>`;
    const tb = html('tbody', {}, t);
    for (const s of stats) {
      const tr = html('tr', {}, tb);
      tr.innerHTML = `<td class="mono">${esc(part.id)}.${esc(s.c)}</td><td class="num">${fmtNum(s.m, 5)}</td><td class="num">${fmtNum(s.sd, 5)}</td><td class="num">${fmtNum(s.min, 4)} – ${fmtNum(s.max, 4)}</td>`;
    }
    if (parsed.rows.length < 3) {
      html('div', { class: 'callout warn', style: 'margin-top:8px', text: '行数少于 3，无法估计相关性。请补充测量行。' }, target);
    }
  }

  function renderCostEditor(card, part, parsed) {
    if (!parsed.columns.length) return;
    const details = html('details', { class: 'tech', style: 'margin-top:8px' }, card);
    html('summary', { text: `${part.label}：加工参数与调整成本` }, details);
    const wrap = html('div', { class: 'table-wrap', style: 'margin-top:8px' }, details);
    const t = html('table', {}, wrap);
    t.innerHTML = `<thead><tr>
      <th>尺寸</th><th class="num">中心可调 ±mm</th><th class="num">最小 σ 倍率</th>
      <th class="num">单位偏移成本 /mm</th><th class="num">σ 收紧成本 /(倍率)</th><th></th></tr></thead>`;
    const tb = html('tbody', {}, t);
    for (const c of parsed.columns) {
      const key = `${part.id}.${c}`;
      const cost = builder.costByKey[key];
      const tr = html('tr', {}, tb);
      const td0 = html('td', { class: 'mono', text: key }, tr);
      const mkNum = (field, step) => {
        const td = html('td', { class: 'num' }, tr);
        const inp = html('input', { type: 'number', step: String(step), value: String(cost[field]) }, td);
        inp.style.width = '90px';
        inp.addEventListener('change', () => {
          const v = Number(inp.value);
          if (Number.isFinite(v) && v >= 0) cost[field] = v;
          else inp.value = String(cost[field]);
        });
        return inp;
      };
      mkNum('maxShift', 0.001);
      mkNum('minSigmaScale', 0.05);
      mkNum('perShift', 10);
      mkNum('perSigma', 10);
      const tdL = html('td', {}, tr);
      const lock = html('label', { class: 'check' }, tdL);
      const cb = html('input', { type: 'checkbox' }, lock);
      cb.checked = Boolean(part.lockedVars && part.lockedVars[c]);
      cb.addEventListener('change', () => {
        part.lockedVars = part.lockedVars || {};
        part.lockedVars[c] = cb.checked;
      });
      lock.appendChild(document.createTextNode('锁定'));
    }
    html('p', { class: 'hint', style: 'margin-top:8px', text: '锁定表示该工艺参数不可调（例如外购件）。成本按“绝对偏移量 × 单位成本 + 标准差倍率下降量 × 收紧成本”计。' }, details);
  }

  function renderConstraintList() {
    const host = $('#constraintList');
    host.innerHTML = '';
    builder.constraints.forEach((c, idx) => {
      const card = html('div', { class: 'builder-part' }, host);
      const top = html('div', { class: 'row', style: 'margin-bottom:8px' }, card);
      const idF = html('div', { class: 'field', style: 'width:120px' }, top);
      html('label', { text: '约束 ID' }, idF);
      const idI = html('input', { type: 'text', value: c.id }, idF);
      idI.addEventListener('change', () => {
        const v = idI.value.trim().replace(/[^\w一-龥-]/g, '');
        if (v) c.id = v;
        else idI.value = c.id;
      });
      const lF = html('div', { class: 'field', style: 'flex:1;min-width:130px' }, top);
      html('label', { text: '名称' }, lF);
      const lI = html('input', { type: 'text', value: c.label }, lF);
      lI.addEventListener('input', () => (c.label = lI.value));
      const loF = html('div', { class: 'field', style: 'width:110px' }, top);
      html('label', { text: '下界' }, loF);
      const loI = html('input', { type: 'number', step: '0.001', value: c.lower }, loF);
      loI.addEventListener('change', () => (c.lower = loI.value === '' ? '' : Number(loI.value)));
      const hiF = html('div', { class: 'field', style: 'width:110px' }, top);
      html('label', { text: '上界' }, hiF);
      const hiI = html('input', { type: 'number', step: '0.001', value: c.upper }, hiF);
      hiI.addEventListener('change', () => (c.upper = hiI.value === '' ? '' : Number(hiI.value)));
      const del = html('button', { class: 'btn sm danger', type: 'button', text: '删除' }, top);
      del.style.marginLeft = 'auto';
      del.disabled = builder.constraints.length <= 1;
      del.addEventListener('click', () => {
        builder.constraints.splice(idx, 1);
        renderBuilder();
      });

      const termWrap = html('div', { class: 'stack' }, card);
      c.terms.forEach((term, ti) => {
        const row = html('div', { class: 'row' }, termWrap);
        const partSel = html('select', {}, row);
        html('option', { value: '', text: '选择零件…' }, partSel);
        for (const p of builder.parts) {
          const o = html('option', { value: p.id, text: `${p.label}（${p.id}）` }, partSel);
          if (p.id === term.part) o.selected = true;
        }
        const varSel = html('select', {}, row);
        const fillVars = () => {
          varSel.innerHTML = '';
          const p = builder.parts.find((pp) => pp.id === term.part);
          const cols = p ? parseCSV(p.csv).columns : [];
          html('option', { value: '', text: '选择尺寸…' }, varSel);
          for (const col of cols) {
            const o = html('option', { value: col, text: col }, varSel);
            if (col === term.variable) o.selected = true;
          }
        };
        fillVars();
        partSel.addEventListener('change', () => {
          term.part = partSel.value;
          term.variable = '';
          fillVars();
          renderBuilderSummary();
        });
        varSel.addEventListener('change', () => {
          term.variable = varSel.value;
          renderBuilderSummary();
        });
        const coefF = html('div', { class: 'field', style: 'width:90px' }, row);
        html('label', { text: '系数' }, coefF);
        const coefI = html('input', { type: 'number', step: '0.1', value: String(term.coef) }, coefF);
        coefI.addEventListener('change', () => {
          const v = Number(coefI.value);
          term.coef = Number.isFinite(v) && v !== 0 ? v : 1;
          coefI.value = String(term.coef);
        });
        const plus = html('button', { class: 'btn sm ghost', type: 'button', text: ti === 0 ? '＋' : '＋' }, row);
        plus.title = '在同一约束里增加一个尺寸项';
        plus.addEventListener('click', () => {
          c.terms.push({ part: term.part, variable: '', coef: 1 });
          renderBuilder();
        });
        if (c.terms.length > 1) {
          const minus = html('button', { class: 'btn sm ghost', type: 'button', text: '−' }, row);
          minus.title = '移除此尺寸项';
          minus.addEventListener('click', () => {
            c.terms.splice(ti, 1);
            renderBuilder();
          });
        }
      });
      const formula = c.terms
        .filter((t) => t.part && t.variable)
        .map((t, i) => `${i ? (t.coef >= 0 ? ' + ' : ' − ') : ''}${Math.abs(t.coef) === 1 ? '' : Math.abs(t.coef) + '×'}${t.part}.${t.variable}`)
        .join('');
      html('div', { class: 'formula', style: 'margin-top:8px', text: `${c.id} = ${formula || '（尚未选择尺寸）'}，要求 ${c.lower === '' ? '−∞' : c.lower} ≤ 值 ≤ ${c.upper === '' ? '∞' : c.upper}` }, card);
    });
    const add = html('button', { class: 'btn sm', type: 'button', text: '＋ 添加约束' }, host);
    add.addEventListener('click', () => {
      builder.constraints.push(blankConstraint());
      renderBuilder();
    });
  }

  function buildScenarioFromBuilder() {
    const name = builder.name.trim() || '未命名方案';
    const parts = [];
    const datasets = {};
    const errors = [];
    for (const p of builder.parts) {
      const parsed = parseCSV(p.csv);
      if (parsed.error) errors.push(`${p.label}: ${parsed.error}`);
      if (!parsed.columns.length || parsed.rows.length < 3) errors.push(`${p.label}: 至少需要 3 行测量`);
      const variables = parsed.columns.map((c) => {
        const key = `${p.id}.${c}`;
        const cost = builder.costByKey[key] || { perShift: 0, perSigma: 0, maxShift: 0, minSigmaScale: 0.6 };
        return {
          id: c,
          label: c,
          unit: 'mm',
          dist: 'auto',
          cost: {
            perShift: Number(cost.perShift) || 0,
            perSigma: Number(cost.perSigma) || 0,
            maxShift: Number(cost.maxShift) || 0,
            minSigmaScale: Number(cost.minSigmaScale) || 0.6,
          },
          locked: Boolean(p.lockedVars && p.lockedVars[c]),
        };
      });
      parts.push({ id: p.id, label: p.label, variables });
      datasets[p.id] = { columns: parsed.columns, rows: parsed.rows };
    }
    const constraints = [];
    for (const c of builder.constraints) {
      const terms = c.terms.filter((t) => t.part && t.variable);
      if (!terms.length) continue;
      constraints.push({
        id: c.id,
        label: c.label,
        kind: 'assembly',
        terms: terms.map((t) => ({ part: t.part, variable: t.variable, coef: Number(t.coef) || 1 })),
        ...(c.lower !== '' && c.lower !== null ? { lower: Number(c.lower) } : {}),
        ...(c.upper !== '' && c.upper !== null ? { upper: Number(c.upper) } : {}),
      });
    }
    if (!constraints.length) errors.push('至少需要一条包含有效尺寸项的装配约束');
    return {
      errors,
      scenario: {
        name,
        description: '由构建器创建',
        parts,
        datasets,
        constraints,
        simulation: { seed: builder.seed, drawsPerPart: builder.draws, method: builder.method, correlationShrinkage: 0.1, tailSensitivity: true },
        budget: { total: Number(builder.budget) || 0, currency: builder.currency || '元' },
        meta: { tags: ['自建方案'] },
      },
    };
  }

  function renderBuilderSummary() {
    const host = $('#builderSummary');
    if (!host) return;
    const { errors, scenario } = buildScenarioFromBuilder();
    host.innerHTML = '';
    if (errors.length) {
      for (const e of errors) html('div', { class: 'callout danger', text: e }, host);
    }
    const rows = [
      ['方案', scenario.name],
      ['零件', scenario.parts.map((p) => `${p.label}（${datasets0(scenario, p.id)} 行）`).join('、')],
      ['约束', scenario.constraints.map((c) => c.label || c.id).join('、') || '—'],
      ['抽样', `${scenario.simulation.method === 'empirical' ? '经验重采样' : '参数分布'} · ${scenario.simulation.drawsPerPart.toLocaleString()} 次 · 种子 ${scenario.simulation.seed}`],
      ['预算', `${scenario.budget.total} ${scenario.budget.currency}`],
    ];
    const kv = html('dl', { class: 'kv' }, host);
    for (const [k, v] of rows) {
      html('dt', { text: k }, kv);
      html('dd', { text: v }, kv);
    }
    if (!errors.length) {
      html('div', { class: 'callout ok', text: '结构检查通过。运行后会给出联合合格率；若某些约束涉及无测量数据的尺寸，会被标记为外推。' }, host);
    }
    const errBox = $('#builderError');
    if (errBox) errBox.hidden = true;
  }
  function datasets0(scenario, partId) {
    return scenario.datasets[partId].rows.length;
  }

  $('#budgetName').addEventListener('input', (e) => {
    builder.name = e.target.value;
    renderBuilderSummary();
  });
  $('#budgetTotal').addEventListener('change', (e) => {
    builder.budget = Math.max(0, Number(e.target.value) || 0);
    renderBuilderSummary();
  });
  $('#budgetCurrency').addEventListener('input', (e) => {
    builder.currency = e.target.value || '元';
  });
  $('#simMethod').addEventListener('change', (e) => (builder.method = e.target.value));
  $('#simDraws').addEventListener('change', (e) => (builder.draws = Number(e.target.value)));
  $('#simSeed').addEventListener('change', (e) => (builder.seed = Number(e.target.value) || 1));
  $('#addPartBtn').addEventListener('click', () => {
    builder.parts.push(blankPart());
    renderBuilder();
  });
  $('#addConstraintBtn').addEventListener('click', () => {
    builder.constraints.push(blankConstraint());
    renderBuilder();
  });
  $('#pasteExampleBtn').addEventListener('click', () => {
    if (!builder.parts.length) builder.parts.push(blankPart());
    builder.parts[0].csv = csvExample();
    builder.costEnabled = true;
    ensureCosts(builder.parts[0], parseCSV(csvExample()));
    renderBuilder();
    toast('已填入两列表格；可在“加工参数与调整成本”里设定可调范围');
  });
  $('#fileImportInputBtn').addEventListener('click', () => $('#fileImportInput').click());
  $('#saveScenarioBtn').addEventListener('click', () => {
    const { errors, scenario } = buildScenarioFromBuilder();
    if (errors.length) {
      toast('先修正构建器中的错误', true);
      return;
    }
    download(`${scenario.name.replace(/\s+/g, '-')}.json`, JSON.stringify(scenario, null, 2) + '\n');
  });
  $('#pasteFormatHelp').addEventListener('click', () => {
    toast('支持：① 完整方案 JSON；② 以 "# 零件 id | 名称" 开头的 CSV 分段；③ 单个 CSV 表（仅一个零件）。');
  });

  $('#parsePasteBtn').addEventListener('click', () => {
    const raw = $('#pasteArea').value.trim();
    const errBox = $('#pasteError');
    errBox.hidden = true;
    if (!raw) {
      errBox.hidden = false;
      errBox.textContent = '请先粘贴内容。';
      return;
    }
    try {
      if (raw.startsWith('{')) {
        const obj = JSON.parse(raw);
        builder.active = false;
        applyScenario(obj, null);
        return;
      }
      const sections = raw.split(/^#\s*/m).filter((s) => s.trim());
      const parts = [];
      for (const sec of sections) {
        const lines = sec.replace(/\r\n?/g, '\n').split('\n');
        const header = lines[0];
        const m = header.match(/^([^|]+?)(?:\s*\|\s*(.+))?$/);
        const id = (m && m[1].trim()) || `part${parts.length + 1}`;
        const label = (m && m[2] && m[2].trim()) || id;
        parts.push({ id: id.replace(/[^\w一-龥-]/g, ''), label, csv: lines.slice(1).join('\n'), lockedVars: {} });
      }
      builder.active = true;
      builder.parts = parts.length ? parts : [blankPart()];
      builder.constraints = [blankConstraint()];
      builder.costByKey = {};
      builder.costEnabled = true;
      for (const p of builder.parts) ensureCosts(p, parseCSV(p.csv));
      builder.name = '粘贴导入的方案';
      renderOnboardVisibility();
      toast('已解析测量表；请补全装配约束与预算');
    } catch (e) {
      errBox.hidden = false;
      errBox.textContent = `解析失败：${e.message}`;
    }
  });

  $('#runAnalyzeBtn').addEventListener('click', async (e) => {
    const { errors, scenario } = buildScenarioFromBuilder();
    if (errors.length) {
      const box = $('#builderError');
      box.hidden = false;
      box.innerHTML = errors.map((x) => `<div>• ${esc(x)}</div>`).join('');
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    busy(e.currentTarget, true, '运行分析…');
    try {
      builder.active = false;
      state.scenario = scenario;
      const res = await api('/api/analyze', { scenario, options: optionsFromUI() });
      state.analysis = res;
      state.version = emptyVersion();
      state.section = null;
      state.verification = null;
      state.optimization = null;
      state.compare = null;
      $('#optBudget').value = String(scenario.budget.total);
      updateChip();
      renderAll();
      showPanel('overview');
      toast('分析完成');
    } catch (err) {
      const box = $('#builderError');
      box.hidden = false;
      box.textContent = `分析失败：${err.message}`;
      builder.active = true;
      renderOnboardVisibility();
    } finally {
      busy(e.currentTarget, false);
    }
  });

  // =========================================================
  // ② overview rendering
  // =========================================================
  function renderAll() {
    const a = state.analysis;
    if (!a) return;
    $('#overviewEmpty').hidden = true;
    $('#overviewContent').hidden = false;
    $('#explainEmpty').hidden = true;
    $('#explainContent').hidden = false;
    $('#optimizeEmpty').hidden = true;
    $('#optimizeContent').hidden = false;
    renderOverview();
    renderExplainStatic();
    renderOptimizeUI();
    renderCompareUI();
  }

  function renderOverview() {
    const a = state.analysis;
    const b = a.baseline;
    const cur = a.scenario.budget.currency;
    const grid = $('#metricGrid');
    grid.innerHTML = '';

    const hero = html('div', { class: 'metric hero' }, grid);
    html('div', { class: 'label', text: '联合装配合格率' }, hero);
    html('div', { class: 'value', text: fmtPct(b.yield) }, hero);
    html('div', {
      class: 'foot',
      text: `95% 区间 ${fmtPct(b.interval.lo)} – ${fmtPct(b.interval.hi)} · ${b.passed.toLocaleString()} / ${b.draws.toLocaleString()} 次模拟合格`,
    }, hero);

    const m1 = html('div', { class: 'metric' }, grid);
    html('div', { class: 'label', text: '单尺寸合格率连乘（仅对照）' }, m1);
    html('div', { class: 'value', text: fmtPct(b.marginalProduct) }, m1);
    const diff = b.yield - b.marginalProduct;
    const diffText =
      Math.abs(diff) < 0.0005
        ? '联合 ≈ 连乘（约束间近似独立）'
        : `联合 − 连乘 = ${fmtSignedPct(diff)}`;
    html('div', { class: `trend ${diff >= 0 ? 'up' : 'down'}`, text: diffText }, m1);
    html('div', {
      class: 'foot',
      text:
        diff < -0.001
          ? '联合低于连乘：失败在约束之间正相关，会成串出现。'
          : diff > 0.001
            ? '联合高于连乘：约束之间负相关，一个尺寸的偏移抵消另一个的风险。'
            : '连乘只是“若各约束独立”的假想值，不能替代联合口径。',
    }, m1);

    const m2 = html('div', { class: 'metric' }, grid);
    html('div', { class: 'label', text: '失败来源（按单尺寸合格率）' }, m2);
    const weakest = b.constraints.find((c) => c.id === b.weakestConstraint) || b.constraints[0];
    html('div', { class: 'value', style: 'font-size:22px;line-height:1.4', text: weakest ? weakest.label : '—' }, m2);
    html('div', { class: 'foot', text: weakest ? `单尺寸合格率 ${fmtPct(weakest.marginal)} · 失败 ${weakest.failCount.toLocaleString()} 次` : '' }, m2);

    const m3 = html('div', { class: 'metric' }, grid);
    html('div', { class: 'label', text: '当前方案调整成本 / 预算' }, m3);
    html('div', { class: 'value', style: 'font-size:26px', text: fmtMoney(b.cost, cur) }, m3);
    html('div', { class: 'foot', text: `预算上限 ${fmtMoney(a.scenario.budget.total, cur)} · ${b.cost > a.scenario.budget.total ? '已超预算' : '在预算内'}` }, m3);

    // coverage banner
    const banner = $('#coverageBanner');
    const extrapolated = b.constraints.filter((c) => c.coverage.status === 'extrapolated');
    const partial = b.constraints.filter((c) => c.coverage.status === 'partial');
    if (extrapolated.length) {
      banner.hidden = false;
      banner.innerHTML = `<span class="glyph">⚠️</span><span><b>外推提示：</b>${extrapolated
        .map((c) => `「${esc(c.label)}」${esc(c.coverage.reason)}`)
        .join(' ')} 这些约束的合格率来自假设的分布，不是测量数据覆盖的结论。</span>`;
    } else if (partial.length) {
      banner.hidden = false;
      banner.innerHTML = `<span class="glyph">ℹ️</span><span><b>部分外推：</b>${partial
        .map((c) => `「${esc(c.label)}」${esc(c.coverage.reason)}`)
        .join(' ')}</span>`;
    } else if (b.warnings && b.warnings.length) {
      banner.hidden = false;
      banner.innerHTML = `<span class="glyph">ℹ️</span><span>${b.warnings.map(esc).join(' ')}</span>`;
    } else {
      banner.hidden = true;
    }

    renderOverviewCharts();
    renderStability();
    renderFailureTable();
    $('#distConstraintSelect').innerHTML = '';
    for (const c of b.constraints) {
      const o = html('option', { value: c.id, text: c.label }, $('#distConstraintSelect'));
    }
    $('#distConstraintSelect').onchange = () => renderDistribution();
    renderDistribution();
    renderTails();
    renderOverviewTable();
  }

  function renderOverviewCharts() {
    const a = state.analysis;
    if (!a) return;
    const b = a.baseline;
    Charts.barList(
      $('#trapBars'),
      [
        { label: '联合合格率', value: b.yield },
        { label: '单尺寸合格率连乘', value: b.marginalProduct, alt: true },
        ...b.constraints.map((c) => ({ label: `　${c.label}（单尺寸）`, value: c.marginal })),
      ],
      { max: 1, format: (v) => `${(v * 100).toFixed(1)}%` },
    );
    const pen = b.marginalProduct - b.yield;
    if (b.constraints.length < 2) {
      const ind = (state.analysis.tails || []).find((t) => t.key === 'independent');
      $('#trapNote').textContent = ind && ind.invalid
        ? `本方案只有一条装配约束，所以“连乘”与联合相同。真正的相关陷阱在这里：把零件内各尺寸分别独立重排后得到 ${fmtPct(
            ind.yield,
          )}，比保留整行的 ${fmtPct(b.yield)} 高 ${((ind.yield - b.yield) * 100).toFixed(1)} 个百分点——相关结构不能拆。`
        : '本方案只有一条装配约束，联合与单尺寸连乘相同；相关结构的影响见下方“抽样方式与尾部敏感性”里的错误对照。';
    } else {
      $('#trapNote').textContent =
        pen > 0.002
          ? `单尺寸连乘高估了联合合格率 ${(pen * 100).toFixed(1)} 个百分点——失败在约束之间正相关，会成串出现。`
          : pen < -0.002
            ? `单尺寸连乘低估了联合合格率 ${(-pen * 100).toFixed(1)} 个百分点——约束之间负相关，一个尺寸偏移会抵消另一个的风险。`
            : '这个方案里约束之间近似独立，连乘与联合结果几乎一致。';
    }
    Charts.failureBars(
      $('#failureBars'),
      b.constraints.map((c) => ({ label: c.label, failLow: c.failLow, failHigh: c.failHigh, marginal: c.marginal })),
    );
  }

  let distributionReq = 0;
  function renderDistribution() {
    const a = state.analysis;
    if (!a) return;
    const b = a.baseline;
    const sel = $('#distConstraintSelect').value || (b.constraints[0] && b.constraints[0].id);
    renderDistributionImpl(sel);
  }

  async function renderDistributionImpl(constraintId) {
    const a = state.analysis;
    if (!a) return;
    const c = a.baseline.constraints.find((x) => x.id === constraintId);
    if (!c) return;
    const host = $('#distChart');
    const tableHost = $('#distTable');
    const reqId = ++distributionReq;
    host.innerHTML = '<div class="loading"><span class="spinner"></span>加载分布…</div>';
    tableHost.innerHTML = '';
    try {
      const r = await api('/api/distributions', {
        scenario: state.scenario,
        options: optionsFromUI(),
        version: state.version,
        constraintId,
        series: [
          {
            key: 'current',
            label: state.analysis.options.method === 'empirical' ? '当前：经验重采样' : '当前：参数分布',
            method: state.analysis.options.method,
            tailMode: 'normal',
          },
        ],
      });
      if (reqId !== distributionReq) return;
      const s = r.series[0];
      Charts.histogram(host, {
        values: s.values,
        lower: c.lower,
        upper: c.upper,
        bins: 32,
        height: 240,
      });
      renderDistributionTable(tableHost, s, c);
    } catch (e) {
      if (reqId !== distributionReq) return;
      host.innerHTML = `<div class="callout danger">${esc(e.message)}</div>`;
    }
  }

  function renderDistributionTable(host, s, c) {
    const vals = s.values.slice().sort((x, y) => x - y);
    const q = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(p * (vals.length - 1))))];
    const inSpec = vals.filter((v) => (c.lower === undefined || v >= c.lower) && (c.upper === undefined || v <= c.upper)).length;
    const wrap = html('div', { class: 'table-wrap' }, host);
    const t = html('table', {}, wrap);
    t.innerHTML = `<thead><tr><th>统计</th><th class="num">值</th></tr></thead>`;
    const tb = html('tbody', {}, t);
    const rows = [
      ['抽样数', s.n.toLocaleString()],
      ['合格比例', fmtPct(inSpec / Math.max(1, vals.length))],
      ['最小 / 最大', `${fmtNum(vals[0])} / ${fmtNum(vals[vals.length - 1])}`],
      ['p01', fmtNum(q(0.01))],
      ['中位数', fmtNum(q(0.5))],
      ['p99', fmtNum(q(0.99))],
      ['下界 / 上界', `${c.lower === undefined ? '—' : fmtNum(c.lower)} / ${c.upper === undefined ? '—' : fmtNum(c.upper)}`],
    ];
    for (const [k, v] of rows) {
      const tr = html('tr', {}, tb);
      tr.innerHTML = `<td>${esc(k)}</td><td class="num">${esc(v)}</td>`;
    }
  }

  async function renderTails() {
    const a = state.analysis;
    if (!a) return;
    if (!a.tails) {
      $('#tailsBars').innerHTML = '<p class="muted small">敏感性分析已关闭。</p>';
      return;
    }
    const rows = a.tails.map((t) => ({ label: t.label, value: t.yield, invalid: t.invalid, title: t.note }));
    Charts.barList($('#tailsBars'), rows, { max: 1, format: (v) => `${(v * 100).toFixed(2)}%` });
    const emp = a.tails.find((t) => t.key === 'empirical');
    const par = a.tails.find((t) => t.key === 't-copula');
    const ind = a.tails.find((t) => t.key === 'independent');
    const parts = [];
    if (emp && par && !emp.invalid && !par.invalid) {
      const d = par.yield - emp.yield;
      parts.push(
        `经验重采样 ${fmtPct(emp.yield)}，重尾 t Copula ${fmtPct(par.yield)}：尾部假设影响 ${fmtSignedPct(d)}。${
          Math.abs(d) > 0.02 ? '差异较大，小样本尾部假设不可忽略。' : '当前样本下差异有限。'
        }`,
      );
    }
    if (ind && ind.invalid) {
      parts.push(`错误对照（独立重排）${fmtPct(ind.yield)}；它不是有效模型，只用来显示破坏零件内相关会怎样改变结论。`);
    }
    if (a.tails.some((t) => t.invalid)) parts.push('灰色柱为错误对照，不参与任何推荐。');
    $('#tailsNote').textContent = parts.join(' ');

    const sel = $('#tailConstraintSelect');
    sel.innerHTML = '';
    for (const c of a.baseline.constraints) html('option', { value: c.id, text: c.label }, sel);
    sel.onchange = () => renderTailOverlay();
    renderTailOverlay();
  }

  async function fetchDistributions(constraintId) {
    return api('/api/distributions', {
      scenario: state.scenario,
      options: optionsFromUI(),
      version: state.version,
      constraintId,
    });
  }

  let tailReq = 0;
  async function renderTailOverlay() {
    const a = state.analysis;
    if (!a) return;
    const cid = $('#tailConstraintSelect').value;
    if (!cid) return;
    const host = $('#tailOverlay');
    const reqId = ++tailReq;
    host.innerHTML = '<div class="loading"><span class="spinner"></span>加载分布…</div>';
    try {
      const r = await fetchDistributions(cid);
      if (reqId !== tailReq) return;
      const c = a.baseline.constraints.find((x) => x.id === cid);
      Charts.overlayHistograms(
        host,
        r.series.map((s) => ({ label: s.label, values: s.values, yield: s.yield, invalid: s.invalid })),
        { lower: c ? c.lower : undefined, upper: c ? c.upper : undefined },
      );
    } catch (e) {
      if (reqId !== tailReq) return;
      host.innerHTML = `<div class="callout danger">${esc(e.message)}</div>`;
    }
  }

  function renderStability() {
    const a = state.analysis;
    const b = a.baseline;
    const host = $('#stabilityBox');
    host.innerHTML = '';
    const st = b.stability;
    const verdict = st.stable
      ? { cls: 'ok', text: '批间波动与二项抽样噪声相符，抽样数足够支撑当前结论。' }
      : { cls: 'warn', text: '批间波动明显高于二项噪声。抽样数可能不足，或样本之间存在隐藏依赖。' };
    const call = html('div', { class: `callout ${verdict.cls}` }, host);
    call.innerHTML = `<span class="glyph">${verdict.cls === 'ok' ? '✓' : '⚠️'}</span><span><b>${st.stable ? '稳定' : '需要更多样本'}：</b>${esc(
      verdict.text,
    )} 每批 ${st.chunkSize.toLocaleString()} 次，共 ${st.rates.length} 批，批间标准差 ${(st.sd * 100).toFixed(2)} 个百分点，二项期望 ${(st.binomialSe * 100).toFixed(2)} 个百分点（比值 ${st.ratio.toFixed(2)}）。</span>`;
    const wrap = html('div', { class: 'bar-list', style: 'margin-top:12px' }, host);
    st.rates.forEach((r, i) => {
      const row = html('div', { class: 'bar-row' }, wrap);
      html('div', { class: 'name', text: `第 ${i + 1} 批` }, row);
      const track = html('div', { class: 'bar-track' }, row);
      const fill = html('div', { class: 'bar-fill' }, track);
      fill.style.width = `${Math.min(100, r * 100)}%`;
      const val = html('div', { class: 'bar-val', text: fmtPct(r) }, row);
    });
    const foot = html(
      'p',
      { class: 'hint', style: 'margin-top:10px', text: `抽样方式：${b.method === 'empirical' ? '经验重采样（保留整行）' : '参数分布（相关矩阵）'}；种子 ${b.seed}；${b.draws.toLocaleString()} 次。` },
      host,
    );
  }

  let failureCache = null;
  function renderFailureTable() {
    const a = state.analysis;
    if (!a) return;
    const host = $('#failureTable');
    const b = a.baseline;
    host.innerHTML = '';
    const sigWrap = html('div', { class: 'stack', style: 'margin-bottom:12px' }, host);
    if (!b.failureSignatures.length) {
      html('div', { class: 'callout ok', text: '本次模拟没有失败样本。' }, sigWrap);
    } else {
      for (const s of b.failureSignatures) {
        const c = html('div', { class: 'row small' }, sigWrap);
        const names = s.constraints.map((id) => (b.constraints.find((x) => x.id === id) || { label: id }).label);
        c.innerHTML = `<span class="badge bad">${(s.share * 100).toFixed(1)}%</span><span>${esc(names.join(' + '))} 同时不合格 · ${s.count.toLocaleString()} 次</span>`;
      }
    }
    if (!failureCache) {
      html('p', { class: 'hint', text: '“下载每次模拟的合格原因”会导出全部抽样（或仅失败样本）。下方表格展示失败构成汇总。' }, host);
    }
    $('#downloadFailuresBtn').onclick = async (e) => {
      busy(e.currentTarget, true, '导出中…');
      try {
        const res = await fetch('/api/export/failures', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenario: state.scenario, options: optionsFromUI(), version: state.version, limit: 20000 }),
        });
        if (!res.ok) {
          let msg = `导出失败（HTTP ${res.status}）`;
          try {
            const j = await res.json();
            msg = j.error || msg;
          } catch (err) {}
          throw new Error(msg);
        }
        const blob = await res.blob();
        const a2 = document.createElement('a');
        a2.href = URL.createObjectURL(blob);
        a2.download = `yield-draws-${Date.now()}.csv`;
        document.body.appendChild(a2);
        a2.click();
        setTimeout(() => {
          URL.revokeObjectURL(a2.href);
          a2.remove();
        }, 0);
        toast('已导出每次模拟的合格原因');
      } catch (err) {
        toast(err.message, true);
      } finally {
        busy(e.currentTarget, false);
      }
    };
  }

  function renderOverviewTable() {
    const a = state.analysis;
    const b = a.baseline;
    const host = $('#overviewTable');
    host.innerHTML = '';
    const wrap = html('div', { class: 'table-wrap' }, host);
    const t = html('table', {}, wrap);
    t.innerHTML = `<caption>基础结果 · 版本指纹 ${b.fingerprint}</caption>
      <thead><tr><th>约束</th><th class="num">单尺寸合格率</th><th class="num">失败</th>
      <th class="num">低于下界</th><th class="num">高于上界</th><th class="num">均值</th><th class="num">p01</th><th class="num">p99</th>
      <th class="num">下界</th><th class="num">上界</th><th>覆盖</th></tr></thead>`;
    const tb = html('tbody', {}, t);
    for (const c of b.constraints) {
      const tr = html('tr', {}, tb);
      tr.innerHTML = `<td>${esc(c.label)}</td><td class="num">${fmtPct(c.marginal)}</td><td class="num">${c.failCount.toLocaleString()}</td>
        <td class="num">${c.failLow.toLocaleString()}</td><td class="num">${c.failHigh.toLocaleString()}</td>
        <td class="num">${fmtNum(c.mean, 5)}</td><td class="num">${fmtNum(c.p01, 5)}</td><td class="num">${fmtNum(c.p99, 5)}</td>
        <td class="num">${fmtNum(c.lower)}</td><td class="num">${fmtNum(c.upper)}</td>
        <td>${coverageBadge(c.coverage)}</td>`;
    }
    const foot = html('tbody', {}, t);
    const tr = html('tr', { class: 'hl' }, foot);
    tr.innerHTML = `<td><b>联合</b></td><td class="num"><b>${fmtPct(b.yield)}</b></td><td class="num">${b.failed.toLocaleString()}</td><td colspan="8"></td>`;
  }

  function coverageBadge(cov) {
    if (!cov) return '';
    if (cov.status === 'extrapolated') return `<span class="badge warn" title="${esc(cov.reason)}">外推</span>`;
    if (cov.status === 'partial') return `<span class="badge warn" title="${esc(cov.reason)}">部分外推</span>`;
    return `<span class="badge ok">已覆盖</span>`;
  }

  // =========================================================
  // ③ explain
  // =========================================================
  function renderExplainStatic() {
    const a = state.analysis;
    if (!a) return;
    const x = $('#sectionX');
    const y = $('#sectionY');
    const fk = $('#sectionFixKey');
    const prevX = x.value;
    const prevY = y.value;
    x.innerHTML = '';
    y.innerHTML = '';
    fk.innerHTML = '<option value="">不锁定</option>';
    for (const c of a.sectionCandidates) {
      html('option', { value: c.key, text: c.label + (c.involved ? ' ·参与约束' : '') }, x);
      html('option', { value: c.key, text: c.label + (c.involved ? ' ·参与约束' : '') }, y);
      html('option', { value: c.key, text: c.label }, fk);
    }
    const firstInvolved = a.sectionCandidates.filter((c) => c.involved);
    const pickX = prevX || (firstInvolved[0] && firstInvolved[0].key) || a.sectionCandidates[0].key;
    const pickY = prevY || (firstInvolved[1] && firstInvolved[1].key) || a.sectionCandidates[1]?.key || a.sectionCandidates[0].key;
    x.value = pickX;
    y.value = pickY;
    if (x.value === y.value && a.sectionCandidates.length > 1) {
      const alt = a.sectionCandidates.find((c) => c.key !== x.value);
      y.value = alt.key;
    }
    fk.onchange = () => {
      const on = Boolean(fk.value);
      $('#sectionFixValue').disabled = !on;
      if (on) {
        const cand = a.sectionCandidates.find((c) => c.key === fk.value);
        const p = findVarStats(cand && cand.key);
        if (p) $('#sectionFixValue').value = String(Number(p.mean.toFixed(5)));
      }
    };
    $('#sectionFixValue').disabled = true;
    $('#corrTables').innerHTML = '';
    renderCorrelationTables();
    renderDimTable();
    renderSectionExplainPlaceholder();
  }

  function findVarStats(key) {
    const a = state.analysis;
    if (!a) return null;
    for (const p of a.parts) for (const v of p.variables) if (`${p.id}.${v.id}` === key) return v;
    return null;
  }

  async function drawSection() {
    const a = state.analysis;
    if (!a) return;
    const xKey = $('#sectionX').value;
    const yKey = $('#sectionY').value;
    if (xKey === yKey) {
      toast('两个坐标轴必须是不同尺寸', true);
      return;
    }
    const fixKey = $('#sectionFixKey').value || undefined;
    let fixValue;
    if (fixKey) {
      fixValue = Number($('#sectionFixValue').value);
      if (!Number.isFinite(fixValue)) {
        toast('锁定的工艺参数需要数值', true);
        return;
      }
    }
    const host = $('#sectionChart');
    host.innerHTML = '<div class="loading"><span class="spinner"></span>绘制截面…</div>';
    try {
      const r = await api('/api/section', {
        scenario: state.scenario,
        options: optionsFromUI(),
        version: state.version,
        xKey,
        yKey,
        fixKey,
        fixValue,
        maxPoints: 1600,
      });
      state.section = r.section;
      state.lastSectionQuery = { xKey, yKey, fixKey, fixValue };
      renderSection();
    } catch (e) {
      host.innerHTML = `<div class="callout danger">${esc(e.message)}</div>`;
    }
  }

  function renderSection() {
    const s = state.section;
    if (!s) return;
    $('#sectionChart').innerHTML = '';
    Charts.scatter2d($('#sectionChart'), {
      points: s.points,
      reasons: s.reasons,
      xLabel: s.axisLabels.x,
      yLabel: s.axisLabels.y,
      height: 400,
    });
    const fixNote = s.fixed ? ` · 已把「${s.axisLabels.fix}」锁定为 ${fmtNum(s.fixed.value)}` : '';
    $('#sectionMeta').textContent = `${s.draws.toLocaleString()} 次抽样 · 显示 ${s.shown.toLocaleString()} 点 · 截面联合合格率 ${fmtPct(s.yield)}${fixNote}`;
    $('#sectionNote').textContent = s.fixed
      ? '注意：锁定后其余尺寸仍按原分布抽样；该截面的合格率只代表这一工艺参数取值下的情况。'
      : '截面的四条边不代表规格线；合格与否按全部装配约束联合判定。';
    const host = $('#sectionExplain');
    host.innerHTML = '';
    const call = html('div', { class: 'callout info' }, host);
    call.innerHTML = `<span class="glyph">ℹ️</span><span>该平面上共 ${s.shown.toLocaleString()} 个显示点，联合合格率 <b>${fmtPct(s.yield)}</b>。${
      s.fixed ? `「${esc(s.axisLabels.fix)}」已锁定为 ${fmtNum(s.fixed.value)}。` : ''
    }</span>`;
    if (s.relevantConstraints.length) {
      const wrap = html('div', { class: 'table-wrap', style: 'margin-top:12px' }, host);
      const t = html('table', {}, wrap);
      t.innerHTML = `<caption>与这两个坐标相关的约束</caption><thead><tr><th>约束</th><th class="num">单尺寸合格率</th><th class="num">下界</th><th class="num">上界</th></tr></thead>`;
      const tb = html('tbody', {}, t);
      for (const c of s.relevantConstraints) {
        const full = s.constraints.find((x) => x.id === c.id);
        const tr = html('tr', {}, tb);
        tr.innerHTML = `<td>${esc(c.label)}</td><td class="num">${full ? fmtPct(full.marginal) : '—'}</td><td class="num">${fmtNum(c.lower)}</td><td class="num">${fmtNum(c.upper)}</td>`;
      }
    }
    // reason breakdown
    const reasonCount = new Map();
    s.reasons.forEach((r) => {
      if (!r) return;
      const key = r.replace(/;$/, '');
      reasonCount.set(key, (reasonCount.get(key) || 0) + 1);
    });
    if (reasonCount.size) {
      const wrap = html('div', { style: 'margin-top:12px' }, host);
      html('div', { class: 'section-title', text: '显示点中的失败原因组合' }, wrap);
      const list = html('div', { class: 'stack' }, wrap);
      const sorted = Array.from(reasonCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
      for (const [k, n] of sorted) {
        const parts = k.split(';').filter(Boolean).map((p) => {
          const [id, dir] = p.split(':');
          const c = s.constraints.find((x) => x.id === id);
          return `${c ? c.label : id} ${dir === 'low' ? '低于下界' : '高于上界'}`;
        });
        const row = html('div', { class: 'row small' }, list);
        row.innerHTML = `<span class="badge bad">${n}</span><span>${esc(parts.join('，'))}</span>`;
      }
    }
  }

  function renderSectionExplainPlaceholder() {
    const host = $('#sectionExplain');
    host.innerHTML = '<p class="hint">选择横纵轴（可选锁定一个工艺参数），点击“绘制截面”。红点为未通过全部约束的模拟。</p>';
    $('#sectionChart').innerHTML = '<div class="empty"><h3>尚未绘制</h3><p>截面用于直观看到失败区域落在哪些尺寸组合上。</p></div>';
    $('#sectionMeta').textContent = '';
    $('#sectionNote').textContent = '';
  }

  function renderCorrelationTables() {
    const a = state.analysis;
    const host = $('#corrTables');
    host.innerHTML = '';
    for (const part of a.parts) {
      const block = html('div', { style: 'margin-bottom:14px' }, host);
      html('div', { class: 'section-title', text: `${part.label}（${part.rows} 行）` }, block);
      if (part.noMeasurements) {
        html('p', { class: 'hint', text: '该零件没有测量数据，所有尺寸按声明分布外推。' }, block);
        continue;
      }
      if (!part.correlations.length) {
        html('p', { class: 'hint', text: '只有一列，无零件内相关。' }, block);
        continue;
      }
      const wrap = html('div', { class: 'table-wrap' }, block);
      const t = html('table', { class: 'matrix-table' }, wrap);
      const head = html('thead', {}, t);
      const hr = html('tr', {}, head);
      html('th', { text: '尺寸' }, hr);
      for (const c of part.columns) html('th', { text: c }, hr);
      const tb = html('tbody', {}, t);
      for (let i = 0; i < part.columns.length; i++) {
        const tr = html('tr', {}, tb);
        html('th', { text: part.columns[i] }, tr);
        for (let j = 0; j < part.columns.length; j++) {
          if (i === j) html('td', { class: 'diag', text: '1' }, tr);
          else {
            const corr = part.correlations.find(
              (x) => (x.a === part.columns[i] && x.b === part.columns[j]) || (x.b === part.columns[i] && x.a === part.columns[j]),
            );
            const r = corr ? corr.r : 0;
            const td = html('td', { text: r.toFixed(2) }, tr);
            td.style.color = Math.abs(r) > 0.6 ? 'var(--bad-text)' : 'var(--text-secondary)';
            td.title = Math.abs(r) > 0.6 ? '强相关：联合结论对保留相关性很敏感' : '';
          }
        }
      }
    }
    html(
      'p',
      { class: 'hint', text: '同零件内相关性由整行重采样或相关矩阵保留。若这里存在强相关，把各维独立重排会给出错误结论。' },
      host,
    );
  }

  function renderDimTable() {
    const a = state.analysis;
    const host = $('#dimTable');
    host.innerHTML = '';
    const wrap = html('div', { class: 'table-wrap' }, host);
    const t = html('table', {}, wrap);
    t.innerHTML = `<thead><tr><th>零件 · 尺寸</th><th class="num">自身规格合格率</th><th class="num">均值</th><th class="num">标准差</th><th>数据</th></tr></thead>`;
    const tb = html('tbody', {}, t);
    for (const p of a.parts) {
      for (const v of p.variables) {
        const tr = html('tr', {}, tb);
        const badge = v.extrapolated
          ? '<span class="badge warn">外推</span>'
          : `<span class="badge ok">${p.rows} 行</span>`;
        tr.innerHTML = `<td>${esc(p.label)} · ${esc(v.label)}</td><td class="num">${
          v.assumed ? '—' : fmtPct(v.specYield)
        }</td><td class="num">${fmtNum(v.mean, 5)}</td><td class="num">${fmtNum(v.sd, 5)}</td><td>${badge}</td>`;
      }
    }
    html('p', { class: 'hint', style: 'margin-top:8px', text: '“自身规格合格率”只说明单个尺寸是否在图纸公差内，不是装配合格率。' }, host);
  }

  $('#drawSectionBtn').addEventListener('click', drawSection);
  $('#refreshTailsBtn').addEventListener('click', async (e) => {
    if (!state.analysis) return;
    busy(e.currentTarget, true, '重算中…');
    try {
      const r = await api('/api/analyze', { scenario: state.scenario, options: optionsFromUI() });
      state.analysis.tails = r.tails;
      renderTails();
      toast('尾部敏感性已重算');
    } catch (err) {
      toast(err.message, true);
    } finally {
      busy(e.currentTarget, false);
    }
  });

  // verification
  $('#runVerifyBtn').addEventListener('click', async (e) => {
    const a = state.analysis;
    if (!a) return;
    busy(e.currentTarget, true, '对照计算中…');
    const host = $('#verifyBox');
    host.innerHTML = '<div class="loading"><span class="spinner"></span>穷举 / 积分 / 跨种子…</div>';
    try {
      const r = await api('/api/verify', {
        scenario: state.scenario,
        options: optionsFromUI(),
        version: state.version,
        seeds: 8,
      });
      state.verification = r.verification;
      renderVerification(r.verification);
    } catch (err) {
      host.innerHTML = `<div class="callout danger">${esc(err.message)}</div>`;
    } finally {
      busy(e.currentTarget, false);
    }
  });

  function renderVerification(v) {
    const host = $('#verifyBox');
    host.innerHTML = '';
    const call = html('div', { class: 'callout info' }, host);
    call.innerHTML = `<span class="glyph">🔎</span><span>本次抽样 ${fmtPct(v.mc.yield)}（${v.mc.n.toLocaleString()} 次，${v.mc.method === 'empirical' ? '经验' : '参数'}），用时 ${v.ms} ms。${esc(
      v.notes[v.notes.length - 1] || '',
    )}</span>`;
    const grid = html('div', { class: 'grid cols-2', style: 'margin-top:12px' }, host);

    const enumBox = html('div', { class: 'card' }, grid);
    html('div', { class: 'section-title', text: '穷举：经验模型的精确解' }, enumBox);
    if (v.enumeration.applicable) {
      const cmp = v.enumeration.comparison;
      const ok = cmp.agree;
      html(
        'p',
        {
          class: 'small',
          text: `组合数 ${v.enumeration.combinations.toLocaleString()}（每个零件取一行的全部组合）。精确合格率 ${fmtPct(
            v.enumeration.yield,
          )}；本次蒙特卡洛 ${fmtPct(cmp.mcYield)}；差 ${fmtSignedPct(cmp.diff)}。`,
        },
        enumBox,
      );
      const b = html('div', { class: `callout ${ok ? 'ok' : 'warn'}`, style: 'margin-top:8px' }, enumBox);
      b.innerHTML = `<span class="glyph">${ok ? '✓' : '⚠️'}</span><span>${ok ? '在抽样误差内一致，蒙特卡洛可信。' : `差异超过抽样容差（±${(cmp.tolerance * 100).toFixed(2)} 个百分点），建议增加抽样数。`}</span>`;
    } else {
      html('p', { class: 'small muted', text: v.enumeration.reason }, enumBox);
    }

    const quadBox = html('div', { class: 'card' }, grid);
    html('div', { class: 'section-title', text: '数值积分：≤2 维正态族的解析对照' }, quadBox);
    if (v.quadrature.applicable) {
      const cmp = v.quadrature.comparison;
      html(
        'p',
        {
          class: 'small',
          text: `${v.quadrature.dimensions} 维网格积分（${v.quadrature.grid} 点/维，相关系数 ${v.quadrature.rho.toFixed(
            3,
          )}）：${fmtPct(v.quadrature.yield)}；蒙特卡洛 ${fmtPct(cmp.mcYield)}；差 ${fmtSignedPct(cmp.diff)}。`,
        },
        quadBox,
      );
      const b = html('div', { class: `callout ${cmp.agree ? 'ok' : 'warn'}`, style: 'margin-top:8px' }, quadBox);
      b.innerHTML = `<span class="glyph">${cmp.agree ? '✓' : '⚠️'}</span><span>${cmp.agree ? '积分与蒙特卡洛一致。' : '差异偏大：检查正态假设或增加抽样数。'}</span>`;
    } else {
      html('p', { class: 'small muted', text: v.quadrature.reason }, quadBox);
    }

    const seedBox = html('div', { class: 'card' }, host);
    html('div', { class: 'section-title', text: '跨随机种子稳定性' }, seedBox);
    const seedWrap = html('div', { class: 'table-wrap' }, seedBox);
    const st = v.seedStability;
    const t = html('table', {}, seedWrap);
    t.innerHTML = `<thead><tr><th class="num">种子</th>${st.yields.map((_, i) => `<th class="num">#${i + 1}</th>`).join('')}<th class="num">范围</th></tr></thead>`;
    const tb = html('tbody', {}, t);
    const tr = html('tr', {}, tb);
    tr.innerHTML = `<td>合格率</td>${st.yields.map((y) => `<td class="num">${(y * 100).toFixed(2)}%</td>`).join('')}<td class="num">${(st.min * 100).toFixed(2)}–${(st.max * 100).toFixed(2)}%</td>`;
    const b = html('div', { class: `callout ${st.consistent ? 'ok' : 'warn'}`, style: 'margin-top:8px' }, seedBox);
    b.innerHTML = `<span class="glyph">${st.consistent ? '✓' : '⚠️'}</span><span>${
      st.consistent ? '种子间波动与二项抽样误差相符。' : '种子间波动偏大，当前抽样数不足以支撑精确结论。'
    }</span>`;

    const convBox = html('div', { class: 'card', style: 'margin-top:16px' }, host);
    html('div', { class: 'section-title', text: '不同样本量的收敛' }, convBox);
    const cw = html('div', { class: 'table-wrap' }, convBox);
    const ct = html('table', {}, cw);
    ct.innerHTML = `<thead><tr><th class="num">抽样数</th><th class="num">合格率</th><th class="num">标准误</th><th class="num">±2SE</th></tr></thead>`;
    const ctb = html('tbody', {}, ct);
    for (const c of v.convergence) {
      const tr2 = html('tr', {}, ctb);
      tr2.innerHTML = `<td class="num">${c.draws.toLocaleString()}</td><td class="num">${(c.yield * 100).toFixed(2)}%</td><td class="num">${(c.se * 100).toFixed(2)} pp</td><td class="num">${(2 * c.se * 100).toFixed(2)} pp</td>`;
    }
    html('p', { class: 'hint', style: 'margin-top:8px', text: '随抽样数增加，标准误按 1/√n 缩小；若合格率估计不再漂移，说明抽样数足够。' }, convBox);

    const shBox = html('div', { class: 'card', style: 'margin-top:16px' }, host);
    html('div', { class: 'section-title', text: '错误对照：独立重排' }, shBox);
    const ok = Math.abs(v.shuffle.yield - v.mc.yield) < 0.02;
    shBox.innerHTML += `<p class="small">把每个尺寸分别打乱后：${fmtPct(v.shuffle.yield)}（有效模型 ${fmtPct(v.mc.yield)}）。${
      ok ? '该方案中相关性弱，打乱后影响较小。' : `差 ${fmtSignedPct(v.shuffle.yield - v.mc.yield)}——相关性不可忽略，独立重排不是有效模型。`
    }</p>`;
    html('div', { class: 'callout warn', style: 'margin-top:8px', text: v.shuffle.note }, shBox);
  }

  // =========================================================
  // ④ optimize
  // =========================================================
  function renderOptimizeUI() {
    const a = state.analysis;
    if (!a) return;
    $('#optBudget').value = String(state.optimization ? state.optimization.budget : a.scenario.budget.total);
    $('#optMethod').value = a.options.method;
    $('#optDraws').value = String(Math.min(8000, Math.max(2000, a.options.draws)));
    renderOptimizationResults();
  }

  $('#runOptimizeBtn').addEventListener('click', async (e) => {
    const a = state.analysis;
    if (!a) return;
    const budget = Number($('#optBudget').value);
    if (!Number.isFinite(budget) || budget < 0) {
      toast('预算必须是非负数', true);
      return;
    }
    busy(e.currentTarget, true, '评估候选中…');
    $('#optProgress').hidden = false;
    $('#optResults').hidden = true;
    try {
      const r = await api('/api/optimize', {
        scenario: state.scenario,
        budget,
        options: {
          method: $('#optMethod').value,
          draws: Number($('#optDraws').value),
          seed: optionsFromUI().seed,
        },
      });
      state.optimization = r.optimization;
      state.optOptions = { method: $('#optMethod').value, draws: Number($('#optDraws').value), seed: optionsFromUI().seed };
      renderOptimizationResults();
      toast('优化完成');
    } catch (err) {
      toast(err.message, true);
    } finally {
      busy(e.currentTarget, false);
      $('#optProgress').hidden = true;
    }
  });

  function renderOptimizationResults() {
    const o = state.optimization;
    if (!o) return;
    $('#optResults').hidden = false;
    const cur = o.currency;
    $('#optMeta').textContent = `${o.evaluations} 个候选版本 · ${o.ms} ms · ${o.method === 'empirical' ? '经验' : '参数'} ${o.draws.toLocaleString()} 次`;

    const grid = $('#optMetrics');
    grid.innerHTML = '';
    const m0 = html('div', { class: 'metric' }, grid);
    html('div', { class: 'label', text: '原方案' }, m0);
    html('div', { class: 'value', text: fmtPct(o.base.yield) }, m0);
    html('div', { class: 'foot', text: `成本 ${fmtMoney(o.base.cost, cur)}` }, m0);

    const m1 = html('div', { class: 'metric hero' }, grid);
    html('div', { class: 'label', text: '推荐方案联合合格率' }, m1);
    html('div', { class: 'value', text: fmtPct(o.recommended.yield) }, m1);
    html('div', { class: `trend ${o.recommended.gain >= 0 ? 'up' : 'down'}`, text: `${fmtSignedPct(o.recommended.gain)} 对比原方案` }, m1);

    const m2 = html('div', { class: 'metric' }, grid);
    html('div', { class: 'label', text: '调整成本 / 预算' }, m2);
    html('div', { class: 'value', text: fmtMoney(o.recommended.cost, cur) }, m2);
    html('div', { class: 'foot', text: `预算 ${fmtMoney(o.budget, cur)} · ${o.recommended.feasible ? '可行' : '不可行'}` }, m2);

    const m3 = html('div', { class: 'metric' }, grid);
    html('div', { class: 'label', text: '每单位成本合格率增益' }, m3);
    const eff = o.recommended.gainPerCost;
    html('div', { class: 'value', style: 'font-size:26px', text: Number.isFinite(eff) ? `${(eff * 100).toFixed(3)} pp/元` : '—' }, m3);
    html('div', { class: 'foot', text: '成本与可行性使用推荐方案自己的参数版本' }, m3);

    const cons = $('#optConsistency');
    cons.innerHTML = `<span class="glyph">${o.consistency.fingerprintMatches && o.consistency.costMatches ? '✓' : '⚠️'}</span><span>
      <b>版本一致性：</b>推荐方案指纹 <span class="mono">${o.recommended.fingerprint}</span>；
      成本按同一版本重算为 ${fmtMoney(o.consistency.cost, cur)}，与模拟所用版本${o.consistency.costMatches ? '一致' : '不一致'}。
      可行性检查与模拟使用同一份参数。</span>`;

    // adjustments
    const adjHost = $('#optAdjustments');
    adjHost.innerHTML = '';
    if (!o.recommended.adjustments.length) {
      html('div', { class: 'callout info', text: '在预算与工艺范围内没有找到可改善的调整；推荐保持原方案。' }, adjHost);
    } else {
      const wrap = html('div', { class: 'table-wrap' }, adjHost);
      const t = html('table', {}, wrap);
      t.innerHTML = `<thead><tr><th>加工参数</th><th class="num">中心偏移</th><th class="num">σ 倍率</th><th>说明</th></tr></thead>`;
      const tb = html('tbody', {}, t);
      for (const adj of o.recommended.adjustments) {
        const tr = html('tr', {}, tb);
        const note = adj.extrapolated ? '<span class="badge warn">外推</span>' : adj.locked ? '<span class="badge neutral">已锁定</span>' : '<span class="badge ok">可加工调整</span>';
        tr.innerHTML = `<td>${esc(adj.label)}</td><td class="num">${adj.adjShift === 0 ? '—' : (adj.adjShift > 0 ? '+' : '') + fmtNum(adj.adjShift)} mm</td>
          <td class="num">${Math.abs(adj.sigmaScale - 1) < 1e-9 ? '—' : '×' + adj.sigmaScale}</td><td>${note}</td>`;
      }
      html(
        'p',
        { class: 'hint', style: 'margin-top:8px', text: '中心偏移改变加工中心值；σ 倍率收紧表示减小过程标准差。二者都是明确的工艺动作，不删除任何样本行。' },
        adjHost,
      );
    }

    // cost breakdown
    const cb = $('#optCostBreakdown');
    cb.innerHTML = '';
    html('div', { class: 'section-title', text: '成本明细' }, cb);
    if (!o.recommended.adjustments.length) {
      html('p', { class: 'hint', text: '无调整成本。' }, cb);
    } else {
      const w = html('div', { class: 'table-wrap' }, cb);
      const t = html('table', {}, w);
      t.innerHTML = `<thead><tr><th>参数</th><th class="num">偏移成本</th><th class="num">收紧成本</th><th class="num">小计</th></tr></thead>`;
      const tb = html('tbody', {}, t);
      // recompute itemized cost from the same version via optimizer-provided data if present
      let total = 0;
      for (const adj of o.recommended.adjustments) {
        const relevant = (o.costItems || []).find((x) => x.key === adj.key);
        const sc = relevant ? relevant.shiftCost : NaN;
        const gc = relevant ? relevant.sigmaCost : NaN;
        const sum = relevant ? relevant.cost : NaN;
        if (Number.isFinite(sum)) total += sum;
        const tr = html('tr', {}, tb);
        tr.innerHTML = `<td>${esc(adj.label)}</td><td class="num">${Number.isFinite(sc) ? fmtMoney(sc, cur) : '—'}</td><td class="num">${Number.isFinite(gc) ? fmtMoney(gc, cur) : '—'}</td><td class="num">${Number.isFinite(sum) ? fmtMoney(sum, cur) : '—'}</td>`;
      }
      const tr = html('tr', { class: 'hl' }, tb);
      tr.innerHTML = `<td><b>合计</b></td><td></td><td></td><td class="num"><b>${fmtMoney(o.recommended.cost, cur)}</b></td>`;
      html('p', { class: 'hint', style: 'margin-top:8px', text: `预算上限 ${fmtMoney(o.budget, cur)}；剩余 ${fmtMoney(Math.max(0, o.budget - o.recommended.cost), cur)}。` }, cb);
    }

    renderOptimizationCharts();

    // probes
    const ph = $('#optProbes');
    ph.innerHTML = '';
    const top = (o.probes || []).slice(0, 10);
    if (!top.length) html('p', { class: 'hint', text: '没有可行单项调整。' }, ph);
    else {
      const w = html('div', { class: 'table-wrap' }, ph);
      const t = html('table', {}, w);
      t.innerHTML = `<thead><tr><th>单项调整</th><th class="num">合格率</th><th class="num">增益</th><th class="num">成本</th></tr></thead>`;
      const tb = html('tbody', {}, t);
      for (const p of top) {
        const tr = html('tr', {}, tb);
        tr.innerHTML = `<td>${esc(p.label)}</td><td class="num">${fmtPct(p.yield)}</td><td class="num">${fmtSignedPct(p.gain)}</td><td class="num">${fmtMoney(p.cost, cur)}</td>`;
      }
    }

    // alternatives
    const ah = $('#optAlternatives');
    ah.innerHTML = '';
    if (!o.alternatives.length) html('p', { class: 'hint', text: '没有其他优于原方案的可行候选。' }, ah);
    else {
      const w = html('div', { class: 'table-wrap' }, ah);
      const t = html('table', {}, w);
      t.innerHTML = `<thead><tr><th>候选</th><th class="num">合格率</th><th class="num">成本</th><th>调整</th></tr></thead>`;
      const tb = html('tbody', {}, t);
      for (const alt of o.alternatives) {
        const tr = html('tr', {}, tb);
        const adjTxt = alt.adjustments.map((x) => `${x.variable}${x.adjShift ? ' ' + (x.adjShift > 0 ? '+' : '') + fmtNum(x.adjShift) : ''}${Math.abs(x.sigmaScale - 1) > 1e-9 ? ' σ×' + x.sigmaScale : ''}`).join('；');
        tr.innerHTML = `<td>${esc(alt.label)}</td><td class="num">${fmtPct(alt.yield)}</td><td class="num">${fmtMoney(alt.cost, cur)}</td><td class="small">${esc(adjTxt || '—')}</td>`;
      }
    }

    // constraints after adjustment
    const ch = $('#optConstraints');
    ch.innerHTML = '';
    if (o.recommended.constraints) {
      const w = html('div', { class: 'table-wrap' }, ch);
      const t = html('table', {}, w);
      t.innerHTML = `<thead><tr><th>约束</th><th class="num">调整后单尺寸合格率</th><th>覆盖</th></tr></thead>`;
      const tb = html('tbody', {}, t);
      const baseById = new Map(o.base.constraints.map((c) => [c.id, c]));
      for (const c of o.recommended.constraints) {
        const b = baseById.get(c.id);
        const tr = html('tr', {}, tb);
        tr.innerHTML = `<td>${esc((state.analysis.baseline.constraints.find((x) => x.id === c.id) || {}).label || c.id)}</td>
          <td class="num">${fmtPct(c.marginal)}${b ? ` <span class="tiny muted">(${fmtSignedPct(c.marginal - b.marginal)})</span>` : ''}</td>
          <td>${c.coverage === 'extrapolated' ? '<span class="badge warn">外推</span>' : c.coverage === 'partial' ? '<span class="badge warn">部分外推</span>' : '<span class="badge ok">已覆盖</span>'}</td>`;
      }
    }
    if (o.rejected && o.rejected.length) {
      const det = html('details', { class: 'tech', style: 'margin-top:12px' }, ch);
      html('summary', { text: `被拒绝的候选（${o.rejected.length}，超预算或超工艺范围）` }, det);
      const w = html('div', { class: 'table-wrap', style: 'margin-top:8px' }, det);
      const t = html('table', {}, w);
      t.innerHTML = `<thead><tr><th>候选</th><th class="num">合格率</th><th class="num">成本</th><th>原因</th></tr></thead>`;
      const tb = html('tbody', {}, t);
      for (const r of o.rejected) {
        const tr = html('tr', {}, tb);
        tr.innerHTML = `<td>${esc(r.label)}</td><td class="num">${fmtPct(r.yield)}</td><td class="num">${fmtMoney(r.cost, cur)}</td><td class="tiny">${esc(r.violations.slice(0, 2).join('；'))}</td>`;
      }
    }
    if (o.lockedKeys.length) {
      html('p', { class: 'hint', style: 'margin-top:10px', text: `已锁定不参与优化的尺寸：${o.lockedKeys.join('、')}。` }, ch);
    }
  }

  function renderOptimizationCharts() {
    const o = state.optimization;
    if (!o) return;
    const pts = [
      { cost: o.base.cost, yield: o.base.yield, label: '原方案', kind: 'base' },
      { cost: o.recommended.cost, yield: o.recommended.yield, label: '推荐方案', kind: 'recommended' },
      ...o.alternatives.map((a) => ({ cost: a.cost, yield: a.yield, label: a.label, kind: 'candidate' })),
      ...(o.pareto || []).map((p) => ({ cost: p.cost, yield: p.yield, label: p.label, kind: 'pareto' })),
    ];
    Charts.scatterCostYield($('#optFrontier'), {
      points: pts,
      pareto: o.pareto,
      currency: o.currency,
      height: 300,
    });
  }

  $('#sendToCompareBtn').addEventListener('click', async (e) => {
    const o = state.optimization;
    if (!o) return;
    busy(e.currentTarget, true, '对比中…');
    try {
      const r = await api('/api/compare', {
        scenario: state.scenario,
        options: state.optOptions || optionsFromUI(),
        baseVersion: emptyVersion(),
        candidateVersion: o.recommended.version,
      });
      state.compare = r;
      state.compareCandidateVersion = o.recommended.version;
      renderCompare();
      showPanel('compare');
      toast('对比完成');
    } catch (err) {
      toast(err.message, true);
    } finally {
      busy(e.currentTarget, false);
    }
  });

  // =========================================================
  // ⑤ compare
  // =========================================================
  function renderCompareUI() {
    if (!state.compare) {
      $('#compareEmpty').hidden = false;
      $('#compareContent').hidden = true;
      return;
    }
    renderCompare();
  }

  function renderCompare() {
    const r = state.compare;
    if (!r) return;
    $('#compareEmpty').hidden = true;
    $('#compareContent').hidden = false;
    const cur = r.currency;
    const host = $('#compareCards');
    host.innerHTML = '';
    const mkCard = (title, d, kind) => {
      const c = html('div', { class: 'card' }, host);
      const h = html('div', { class: 'card-head' }, c);
      html('div', {}, h).innerHTML = `<h2>${esc(title)}</h2><div class="sub mono">版本指纹 ${d.fingerprint}</div>`;
      const val = html('div', { class: 'metric', style: 'border:0;padding:0;background:none' }, c);
      html('div', { class: 'label', text: '联合合格率' }, val);
      html('div', { class: 'value', style: 'font-size:38px', text: fmtPct(d.yield) }, val);
      html('div', { class: 'foot', text: `95% 区间 ${fmtPct(d.interval.lo)}–${fmtPct(d.interval.hi)}` }, val);
      const kv = html('dl', { class: 'kv', style: 'margin-top:12px' }, c);
      const rows = [
        ['调整成本', fmtMoney(d.cost, cur)],
        ['可行性', d.feasible ? '可行' : `不可行：${d.violations.join('；')}`],
        ['参数调整', d.adjustments.length ? d.adjustments.map((a) => `${a.label}${a.adjShift ? ' 中心' + (a.adjShift > 0 ? '+' : '') + fmtNum(a.adjShift) : ''}${Math.abs(a.sigmaScale - 1) > 1e-9 ? ' σ×' + a.sigmaScale : ''}`).join('；') : '无'],
      ];
      for (const [k, v] of rows) {
        html('dt', { text: k }, kv);
        html('dd', { text: v }, kv);
      }
    };
    mkCard('原方案', r.base);
    mkCard('候选方案', r.candidate);

    const del = $('#compareDelta');
    del.innerHTML = '';
    const d = r.delta;
    const grid = html('div', { class: 'grid cols-3' }, del);
    const box1 = html('div', { class: 'metric' }, grid);
    html('div', { class: 'label', text: '配对差（候选 − 原方案）' }, box1);
    html('div', { class: 'value', text: fmtSignedPct(d.mean) }, box1);
    html('div', { class: 'foot', text: `95% 区间 ${fmtSignedPct(d.lo)} – ${fmtSignedPct(d.hi)}` }, box1);
    const box2 = html('div', { class: 'metric' }, grid);
    html('div', { class: 'label', text: '两方案都合格' }, box2);
    html('div', { class: 'value', style: 'font-size:26px', text: (d.paired.bothPass / r.n * 100).toFixed(2) + '%' }, box2);
    html('div', { class: 'foot', text: `${d.paired.bothPass.toLocaleString()} / ${r.n.toLocaleString()} 次` }, box2);
    const box3 = html('div', { class: 'metric' }, grid);
    html('div', { class: 'label', text: '仅候选合格 / 仅原方案合格' }, box3);
    html('div', { class: 'value', style: 'font-size:26px', text: `${d.paired.onlyCand.toLocaleString()} / ${d.paired.onlyBase.toLocaleString()}` }, box3);
    html('div', { class: 'foot', text: '同一批随机样本，仅参数版本不同' }, box3);
    const call = html('div', { class: 'callout ' + (d.lo > 0 ? 'ok' : d.hi < 0 ? 'danger' : 'info'), style: 'margin-top:12px' }, del);
    call.innerHTML = `<span class="glyph">${d.lo > 0 ? '✓' : d.hi < 0 ? '⚠️' : 'ℹ️'}</span><span>${
      d.lo > 0
        ? '配对差为正且区间不含 0：候选方案在统计上稳定优于原方案。'
        : d.hi < 0
          ? '配对差为负：候选方案更差。'
          : '配对差区间跨越 0：这次抽样还不足以判定两个方案有差异。'
    } 方法和种子：${r.method === 'empirical' ? '经验' : '参数'} · ${r.draws.toLocaleString()} 次 · 种子 ${r.seed}。</span>`;

    const ch = $('#compareConstraints');
    ch.innerHTML = '';
    const w = html('div', { class: 'table-wrap' }, ch);
    const t = html('table', {}, w);
    t.innerHTML = `<thead><tr><th>约束</th><th class="num">原方案</th><th class="num">候选</th><th class="num">变化</th><th>覆盖</th></tr></thead>`;
    const tb = html('tbody', {}, t);
    for (const c of r.constraints) {
      const tr = html('tr', {}, tb);
      tr.innerHTML = `<td>${esc(c.label)}</td><td class="num">${fmtPct(c.base)}</td><td class="num">${fmtPct(c.candidate)}</td><td class="num">${fmtSignedPct(c.delta)}</td>
        <td>${c.coverage === 'extrapolated' ? '<span class="badge warn">外推</span>' : c.coverage === 'partial' ? '<span class="badge warn">部分外推</span>' : '<span class="badge ok">已覆盖</span>'}</td>`;
    }

    const cc = $('#compareCost');
    cc.innerHTML = '';
    const cw = html('div', { class: 'table-wrap' }, cc);
    const ct = html('table', {}, cw);
    ct.innerHTML = `<thead><tr><th>项目</th><th class="num">原方案</th><th class="num">候选</th></tr></thead>`;
    const ctb = html('tbody', {}, ct);
    const r1 = html('tr', {}, ctb);
    r1.innerHTML = `<td>调整成本</td><td class="num">${fmtMoney(r.base.cost, cur)}</td><td class="num">${fmtMoney(r.candidate.cost, cur)}</td>`;
    const r2 = html('tr', {}, ctb);
    r2.innerHTML = `<td>预算占用</td><td class="num">${state.analysis ? fmtPct(r.base.cost / Math.max(1e-9, state.analysis.scenario.budget.total)) : '—'}</td><td class="num">${state.analysis ? fmtPct(r.candidate.cost / Math.max(1e-9, state.analysis.scenario.budget.total)) : '—'}</td>`;
    const r3 = html('tr', {}, ctb);
    r3.innerHTML = `<td>工艺可达性</td><td>${r.base.feasible ? '<span class="badge ok">可行</span>' : '<span class="badge bad">不可行</span>'}</td><td>${r.candidate.feasible ? '<span class="badge ok">可行</span>' : '<span class="badge bad">不可行</span>'}</td>`;

    $('#downloadCandidateBtn').onclick = () => {
      const sc = JSON.parse(JSON.stringify(state.scenario));
      sc.name = `${sc.name} · 候选方案`;
      sc.candidateVersion = r.candidate.version;
      download(`${sc.name.replace(/[\\/:*?"<>|\s]+/g, '-')}.json`, JSON.stringify(sc, null, 2) + '\n');
    };
    $('#downloadCompareFailuresBtn').onclick = async (e) => {
      busy(e.currentTarget, true, '导出中…');
      try {
        const res = await fetch('/api/export/failures', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scenario: state.scenario,
            options: { method: r.method, draws: r.draws, seed: r.seed },
            version: r.candidate.version,
            limit: 20000,
          }),
        });
        if (!res.ok) throw new Error(`导出失败（HTTP ${res.status}）`);
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `candidate-draws-${Date.now()}.csv`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(a.href);
          a.remove();
        }, 0);
        toast('已导出候选方案的模拟明细');
      } catch (err) {
        toast(err.message, true);
      } finally {
        busy(e.currentTarget, false);
      }
    };
  }

  // ---------------- boot ----------------
  function boot() {
    const hash = (location.hash || '').replace('#', '');
    const valid = ['onboard', 'overview', 'explain', 'optimize', 'compare'];
    showPanel(valid.includes(hash) ? hash : 'onboard');
    try {
      const saved = localStorage.getItem('tyl-last-scenario');
      if (saved && valid.includes(hash) && hash !== 'onboard') {
        const obj = JSON.parse(saved);
        applyScenario(obj, null);
      }
    } catch (e) {}
  }
  boot();

  // persist the current scenario for reloads (scenario only, not results)
  setInterval(() => {
    try {
      if (state.scenario) localStorage.setItem('tyl-last-scenario', JSON.stringify(state.scenario));
    } catch (e) {}
  }, 4000);

  window.__TYL = { state, api, renderAll };
})();
