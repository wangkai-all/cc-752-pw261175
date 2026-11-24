/* Chart primitives for the workbench: SVG, no dependencies.
   Palette roles: series-1/2/3 for identity, status-good/critical for outcome,
   muted ink for axes. Tooltips enhance; every chart has a table twin. */
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const C = {
    surface: 'var(--surface-1)',
    text: 'var(--text-primary)',
    secondary: 'var(--text-secondary)',
    muted: 'var(--muted)',
    grid: 'var(--grid)',
    axis: 'var(--axis)',
    s1: 'var(--series-1)',
    s2: 'var(--series-2)',
    s3: 'var(--series-3)',
    good: 'var(--status-good)',
    critical: 'var(--status-critical)',
    warning: 'var(--status-warning)',
    serious: 'var(--status-serious)',
  };

  function el(name, attrs, parent) {
    const n = document.createElementNS(NS, name);
    if (attrs) for (const k in attrs) {
      if (attrs[k] === undefined || attrs[k] === null) continue;
      n.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(n);
    return n;
  }
  function html(tag, attrs, parent) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(n);
    return n;
  }

  function niceTicks(min, max, count) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
    if (min === max) return [min];
    const span = max - min;
    const step0 = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    let step;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 2.5) step = 2.5;
    else if (norm <= 5) step = 5;
    else step = 10;
    step *= mag;
    const start = Math.ceil(min / step) * step;
    const out = [];
    for (let v = start; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return out;
  }

  function fmtNum(v, digits) {
    if (!Number.isFinite(v)) return '—';
    if (digits !== undefined) return v.toFixed(digits);
    const a = Math.abs(v);
    if (a !== 0 && a < 0.001) return v.toExponential(2);
    if (a >= 1000) return v.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
    if (a >= 100) return v.toFixed(1);
    if (a >= 1) return v.toFixed(3);
    return v.toFixed(4);
  }

  function tooltipFor(container) {
    let tip = container.querySelector('.tooltip');
    if (!tip) {
      tip = html('div', { class: 'tooltip', role: 'status' }, container);
    }
    return tip;
  }

  /**
   * Histogram of one values array with optional lower/upper spec lines.
   * opts: { values, lower, upper, label, unit, bins, color, height, onHover }
   */
  function histogram(container, opts) {
    container.innerHTML = '';
    const width = Math.max(280, container.clientWidth || 620);
    const height = opts.height || 190;
    const pad = { l: 44, r: 14, t: 12, b: 30 };
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', role: 'img' }, container);
    const values = Array.from(opts.values).filter(Number.isFinite);
    if (!values.length) {
      html('p', { class: 'muted small', text: '暂无数据' }, container);
      return;
    }
    const lower = opts.lower;
    const upper = opts.upper;
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (Number.isFinite(lower)) lo = Math.min(lo, lower);
    if (Number.isFinite(upper)) hi = Math.max(hi, upper);
    const spanPad = (hi - lo) * 0.04 || 0.001;
    lo -= spanPad;
    hi += spanPad;
    const bw = (hi - lo) / (opts.bins || 34);
    const bins = new Array(opts.bins || 34).fill(0);
    for (const v of values) {
      let k = Math.floor((v - lo) / bw);
      if (k < 0) k = 0;
      if (k >= bins.length) k = bins.length - 1;
      bins[k]++;
    }
    const yMax = Math.max(...bins) * 1.12 || 1;
    const x = (v) => pad.l + ((v - lo) / (hi - lo)) * (width - pad.l - pad.r);
    const y = (c) => height - pad.b - (c / yMax) * (height - pad.t - pad.b);

    const total = values.length;
    const inSpec = values.filter(
      (v) => (!Number.isFinite(lower) || v >= lower) && (!Number.isFinite(upper) || v <= upper),
    ).length;
    for (let k = 0; k < bins.length; k++) {
      const cx0 = lo + k * bw;
      const cx1 = cx0 + bw;
      const barX = x(cx0);
      const barW = Math.max(1, x(cx1) - x(cx0) - 1);
      const inside =
        (!Number.isFinite(lower) || cx0 + bw / 2 >= lower) && (!Number.isFinite(upper) || cx0 + bw / 2 <= upper);
      const rect = el(
        'rect',
        {
          x: barX,
          y: y(bins[k]),
          width: barW,
          height: Math.max(0, height - pad.b - y(bins[k])),
          rx: Math.min(3, barW / 2),
          fill: inside ? opts.color || C.s1 : C.critical,
          'fill-opacity': inside ? 0.85 : 0.75,
        },
        svg,
      );
      const tip = tooltipFor(container);
      rect.addEventListener('mousemove', (ev) => {
        const r = container.getBoundingClientRect();
        tip.innerHTML = `<b>${fmtNum(cx0, 4)} – ${fmtNum(cx1, 4)}</b><br>${bins[k]} 次 · ${((bins[k] / total) * 100).toFixed(1)}%${inside ? '' : '<br><span style="color:var(--bad-text)">在规格外</span>'}`;
        tip.classList.add('show');
        tip.style.left = `${Math.min(ev.clientX - r.left + 12, r.width - 190)}px`;
        tip.style.top = `${Math.max(4, ev.clientY - r.top - 10)}px`;
      });
      rect.addEventListener('mouseleave', () => tip.classList.remove('show'));
    }

    const ticks = niceTicks(lo, hi, 5);
    for (const t of ticks) {
      el('line', { x1: x(t), x2: x(t), y1: height - pad.b, y2: height - pad.b + 4, stroke: C.axis }, svg);
      const tx = el('text', { x: x(t), y: height - pad.b + 17, 'text-anchor': 'middle', class: 'axis-label' }, svg);
      tx.textContent = fmtNum(t);
    }
    el('line', { x1: pad.l, x2: width - pad.r, y1: height - pad.b, y2: height - pad.b, stroke: C.axis }, svg);

    function limit(v, label) {
      if (!Number.isFinite(v)) return;
      el('line', { x1: x(v), x2: x(v), y1: pad.t, y2: height - pad.b, class: 'limit' }, svg);
      const tx = el(
        'text',
        { x: x(v) + (v > (lo + hi) / 2 ? -4 : 4), y: pad.t + 10, 'text-anchor': v > (lo + hi) / 2 ? 'end' : 'start' },
        svg,
      );
      tx.textContent = label;
      tx.style.fill = 'var(--bad-text)';
    }
    limit(lower, `下界 ${fmtNum(lower)}`);
    limit(upper, `上界 ${fmtNum(upper)}`);
    return { inSpec, total, lo, hi };
  }

  /**
   * Dot plot of pass/fail points in two dimensions.
   * opts { points:[[x,y]], reasons:[...], xLabel, yLabel, xLim, yLim, onPick }
   */
  function scatter2d(container, opts) {
    container.innerHTML = '';
    const width = Math.max(320, container.clientWidth || 720);
    const height = opts.height || 380;
    const pad = { l: 56, r: 18, t: 14, b: 42 };
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', role: 'img' }, container);
    const pts = opts.points || [];
    if (!pts.length) {
      html('p', { class: 'muted small', text: '暂无数据' }, container);
      return;
    }
    let [xlo, xhi] = opts.xLim || [
      Math.min(...pts.map((p) => p[0])),
      Math.max(...pts.map((p) => p[0])),
    ];
    let [ylo, yhi] = opts.yLim || [
      Math.min(...pts.map((p) => p[1])),
      Math.max(...pts.map((p) => p[1])),
    ];
    const px = (xhi - xlo) * 0.04 || 1e-3;
    const py = (yhi - ylo) * 0.04 || 1e-3;
    xlo -= px; xhi += px; ylo -= py; yhi += py;
    const X = (v) => pad.l + ((v - xlo) / (xhi - xlo)) * (width - pad.l - pad.r);
    const Y = (v) => height - pad.b - ((v - ylo) / (yhi - ylo)) * (height - pad.t - pad.b);

    for (const t of niceTicks(xlo, xhi, 6)) {
      el('line', { x1: X(t), x2: X(t), y1: pad.t, y2: height - pad.b, class: 'grid-line' }, svg);
      const tx = el('text', { x: X(t), y: height - pad.b + 16, 'text-anchor': 'middle', class: 'axis-label' }, svg);
      tx.textContent = fmtNum(t);
    }
    for (const t of niceTicks(ylo, yhi, 5)) {
      el('line', { x1: pad.l, x2: width - pad.r, y1: Y(t), y2: Y(t), class: 'grid-line' }, svg);
      const tx = el('text', { x: pad.l - 8, y: Y(t) + 3.5, 'text-anchor': 'end', class: 'axis-label' }, svg);
      tx.textContent = fmtNum(t);
    }
    el('line', { x1: pad.l, x2: width - pad.r, y1: height - pad.b, y2: height - pad.b, class: 'axis-line' }, svg);
    el('line', { x1: pad.l, x2: pad.l, y1: pad.t, y2: height - pad.b, class: 'axis-line' }, svg);

    const xa = el('text', { x: (pad.l + width - pad.r) / 2, y: height - 6, 'text-anchor': 'middle' }, svg);
    xa.textContent = opts.xLabel || '';
    xa.style.fill = 'var(--text-secondary)';
    const ya = el(
      'text',
      { x: 12, y: (pad.t + height - pad.b) / 2, 'text-anchor': 'middle', transform: `rotate(-90 12 ${(pad.t + height - pad.b) / 2})` },
      svg,
    );
    ya.textContent = opts.yLabel || '';
    ya.style.fill = 'var(--text-secondary)';

    const tip = tooltipFor(container);
    const radius = pts.length > 900 ? 1.6 : pts.length > 400 ? 2.2 : 3;
    const frag = document.createDocumentFragment();
    pts.forEach((p, i) => {
      const fail = opts.reasons && opts.reasons[i];
      const dot = el(
        'circle',
        {
          cx: X(p[0]),
          cy: Y(p[1]),
          r: fail ? radius + 0.7 : radius,
          class: fail ? 'fail-dot' : 'pass-dot',
        },
        frag,
      );
      if (pts.length <= 1400) {
        dot.addEventListener('mousemove', (ev) => {
          const r = container.getBoundingClientRect();
          tip.innerHTML = `<b>${esc(opts.xLabel)} ${fmtNum(p[0], 5)}</b><br>${esc(opts.yLabel)} ${fmtNum(p[1], 5)}<br>${
            fail ? `<span style="color:var(--bad-text)">不合格 · ${esc(fail.replace(/;/g, ' · '))}</span>` : '<span style="color:var(--good-text)">合格</span>'
          }`;
          tip.classList.add('show');
          tip.style.left = `${Math.min(ev.clientX - r.left + 12, r.width - 210)}px`;
          tip.style.top = `${Math.max(4, ev.clientY - r.top - 8)}px`;
        });
        dot.addEventListener('mouseleave', () => tip.classList.remove('show'));
      }
    });
    svg.appendChild(frag);
    return { xlo, xhi, ylo, yhi };
  }

  /** Horizontal bar list (yield comparisons). */
  function barList(container, rows, opts) {
    opts = opts || {};
    container.innerHTML = '';
    const max = opts.max === undefined ? Math.max(1e-9, ...rows.map((r) => r.value)) : opts.max;
    const wrap = html('div', { class: 'bar-list' }, container);
    for (const r of rows) {
      const row = html('div', { class: 'bar-row' }, wrap);
      const name = html('div', { class: 'name', title: r.title || r.label }, row);
      name.textContent = r.label;
      const track = html('div', { class: 'bar-track' }, row);
      const fill = html('div', { class: 'bar-fill' + (r.invalid ? ' invalid' : r.alt ? ' alt' : '') }, track);
      const pctv = Math.max(0, Math.min(1, r.value / (max || 1))) * 100;
      fill.style.width = `${pctv}%`;
      fill.style.height = '100%';
      if (r.invalid) fill.style.opacity = '0.5';
      const val = html('div', { class: 'bar-val' }, row);
      val.textContent = opts.format ? opts.format(r.value) : `${(r.value * 100).toFixed(1)}%`;
      if (r.title) row.title = r.title;
    }
    return wrap;
  }

  /** Yield vs cost: dots + Pareto line. */
  function scatterCostYield(container, opts) {
    container.innerHTML = '';
    const width = Math.max(300, container.clientWidth || 560);
    const height = opts.height || 300;
    const pad = { l: 52, r: 18, t: 16, b: 40 };
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', role: 'img' }, container);
    const pts = opts.points || [];
    if (!pts.length) {
      html('p', { class: 'muted small', text: '暂无候选' }, container);
      return;
    }
    const xs = pts.map((p) => p.cost);
    const ys = pts.map((p) => p.yield);
    let xlo = Math.min(0, ...xs);
    let xhi = Math.max(...xs, 1e-6) * 1.08;
    let ylo = Math.min(...ys);
    let yhi = Math.max(...ys);
    const padY = (yhi - ylo) * 0.12 || 0.01;
    ylo = Math.max(0, ylo - padY);
    yhi = Math.min(1, yhi + padY);
    const X = (v) => pad.l + ((v - xlo) / (xhi - xlo || 1)) * (width - pad.l - pad.r);
    const Y = (v) => height - pad.b - ((v - ylo) / (yhi - ylo || 1)) * (height - pad.t - pad.b);
    for (const t of niceTicks(xlo, xhi, 5)) {
      el('line', { x1: X(t), x2: X(t), y1: pad.t, y2: height - pad.b, class: 'grid-line' }, svg);
      const tx = el('text', { x: X(t), y: height - pad.b + 16, 'text-anchor': 'middle', class: 'axis-label' }, svg);
      tx.textContent = fmtNum(t);
    }
    for (const t of niceTicks(ylo, yhi, 5)) {
      el('line', { x1: pad.l, x2: width - pad.r, y1: Y(t), y2: Y(t), class: 'grid-line' }, svg);
      const tx = el('text', { x: pad.l - 8, y: Y(t) + 3.5, 'text-anchor': 'end', class: 'axis-label' }, svg);
      tx.textContent = `${(t * 100).toFixed(t < 0.1 ? 1 : 0)}%`;
    }
    el('line', { x1: pad.l, x2: width - pad.r, y1: height - pad.b, y2: height - pad.b, class: 'axis-line' }, svg);
    const xa = el('text', { x: (pad.l + width - pad.r) / 2, y: height - 4, 'text-anchor': 'middle' }, svg);
    xa.textContent = `调整成本（${opts.currency || '元'}）`;
    xa.style.fill = 'var(--text-secondary)';
    const ya = el('text', { x: 12, y: (pad.t + height - pad.b) / 2, 'text-anchor': 'middle', transform: `rotate(-90 12 ${(pad.t + height - pad.b) / 2})` }, svg);
    ya.textContent = '联合合格率';
    ya.style.fill = 'var(--text-secondary)';

    const pareto = (opts.pareto || []).slice().sort((a, b) => a.cost - b.cost);
    if (pareto.length > 1) {
      const d = pareto.map((p, i) => `${i ? 'L' : 'M'}${X(p.cost).toFixed(1)},${Y(p.yield).toFixed(1)}`).join(' ');
      el('path', { d, class: 'line-1' }, svg);
    }
    const tip = tooltipFor(container);
    for (const p of pts) {
      const isBase = p.kind === 'base';
      const isRec = p.kind === 'recommended';
      const c = el(
        'circle',
        {
          cx: X(p.cost),
          cy: Y(p.yield),
          r: isRec ? 7 : isBase ? 6 : 3.6,
          fill: isRec ? C.s2 : isBase ? C.muted : C.s1,
          stroke: 'var(--surface-1)',
          'stroke-width': 2,
        },
        svg,
      );
      c.addEventListener('mousemove', (ev) => {
        const r = container.getBoundingClientRect();
        tip.innerHTML = `<b>${esc(p.label)}</b><br>合格率 ${(p.yield * 100).toFixed(2)}%<br>成本 ${fmtNum(p.cost)}${isBase ? '<br>当前方案' : ''}${isRec ? '<br>推荐方案' : ''}`;
        tip.classList.add('show');
        tip.style.left = `${Math.min(ev.clientX - r.left + 12, r.width - 200)}px`;
        tip.style.top = `${Math.max(4, ev.clientY - r.top - 8)}px`;
      });
      c.addEventListener('mouseleave', () => tip.classList.remove('show'));
    }
  }

  /** Vertical bars for per-constraint failure counts. */
  function failureBars(container, items, opts) {
    container.innerHTML = '';
    opts = opts || {};
    const width = Math.max(300, container.clientWidth || 620);
    const height = opts.height || 170;
    const pad = { l: 44, r: 14, t: 12, b: 54 };
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', role: 'img' }, container);
    if (!items.length) return;
    const max = Math.max(1, ...items.map((i) => i.failLow + i.failHigh));
    const bw = (width - pad.l - pad.r) / items.length;
    const Y = (v) => height - pad.b - (v / max) * (height - pad.t - pad.b);
    for (const t of niceTicks(0, max, 4)) {
      el('line', { x1: pad.l, x2: width - pad.r, y1: Y(t), y2: Y(t), class: 'grid-line' }, svg);
      const tx = el('text', { x: pad.l - 8, y: Y(t) + 3.5, 'text-anchor': 'end', class: 'axis-label' }, svg);
      tx.textContent = fmtNum(t);
    }
    const tip = tooltipFor(container);
    items.forEach((it, i) => {
      const cx = pad.l + bw * i + bw / 2;
      const w = Math.min(46, bw * 0.5);
      const hHigh = height - pad.b - Y(it.failHigh);
      const hLow = height - pad.b - Y(it.failLow);
      const total = it.failLow + it.failHigh;
      const g = el('g', {}, svg);
      // "high" above "low" with 2px surface gap
      if (hHigh > 0) {
        el('rect', { x: cx - w / 2, y: Y(it.failHigh), width: w, height: Math.max(0, hHigh - (hLow > 0 ? 1.5 : 0)), rx: 3, fill: C.critical, 'fill-opacity': 0.85 }, g);
      }
      if (hLow > 0) {
        el('rect', { x: cx - w / 2, y: Y(it.failLow), width: w, height: hLow, rx: 3, fill: C.serious, 'fill-opacity': 0.9 }, g);
      }
      if (total > 0) {
        const t = el('text', { x: cx, y: Y(it.failLow + it.failHigh) - 4, 'text-anchor': 'middle' }, g);
        t.textContent = total;
        t.style.fill = 'var(--text-primary)';
        t.style.fontWeight = '600';
      }
      const lbl = el('text', { x: cx, y: height - pad.b + 14, 'text-anchor': 'middle', class: 'axis-label' }, g);
      lbl.textContent = truncate(it.label, 8);
      const lbl2 = el('text', { x: cx, y: height - pad.b + 27, 'text-anchor': 'middle', class: 'axis-label' }, g);
      lbl2.textContent = `单尺寸 ${(it.marginal * 100).toFixed(1)}%`;
      g.addEventListener('mousemove', (ev) => {
        const r = container.getBoundingClientRect();
        tip.innerHTML = `<b>${esc(it.label)}</b><br>联合失败 ${total} 次<br>低于下界 ${it.failLow} · 高于上界 ${it.failHigh}`;
        tip.classList.add('show');
        tip.style.left = `${Math.min(ev.clientX - r.left + 12, r.width - 200)}px`;
        tip.style.top = `${Math.max(4, ev.clientY - r.top - 8)}px`;
      });
      g.addEventListener('mouseleave', () => tip.classList.remove('show'));
    });
    el('line', { x1: pad.l, x2: width - pad.r, y1: height - pad.b, y2: height - pad.b, class: 'axis-line' }, svg);
  }

  /** Tiny density/strip chart for tail sensitivity comparison. */
  function overlayHistograms(container, series, opts) {
    container.innerHTML = '';
    opts = opts || {};
    const width = Math.max(300, container.clientWidth || 620);
    const height = opts.height || 200;
    const pad = { l: 16, r: 16, t: 16, b: 30 };
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', role: 'img' }, container);
    const all = [];
    series.forEach((s) => all.push(...s.values));
    if (!all.length) return;
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (Number.isFinite(opts.lower)) lo = Math.min(lo, opts.lower);
    if (Number.isFinite(opts.upper)) hi = Math.max(hi, opts.upper);
    const p = (hi - lo) * 0.03 || 1e-3;
    lo -= p; hi += p;
    const BINS = 70;
    const bw = (hi - lo) / BINS;
    const hists = series.map((s) => {
      const bins = new Array(BINS).fill(0);
      for (const v of s.values) {
        let k = Math.floor((v - lo) / bw);
        if (k < 0) k = 0;
        if (k >= BINS) k = BINS - 1;
        bins[k]++;
      }
      const tot = s.values.length || 1;
      return bins.map((c) => c / tot / bw); // density
    });
    const yMax = Math.max(...hists.flat()) * 1.1 || 1;
    const X = (v) => pad.l + ((v - lo) / (hi - lo)) * (width - pad.l - pad.r);
    const colors = [C.s1, C.s2, C.s3, C.muted];
    series.forEach((s, si) => {
      const dens = hists[si];
      let d = '';
      for (let k = 0; k < BINS; k++) {
        const x0 = X(lo + k * bw);
        const x1 = X(lo + (k + 1) * bw);
        const yy = height - pad.b - (dens[k] / yMax) * (height - pad.t - pad.b);
        d += `${k === 0 ? 'M' : 'L'}${x0.toFixed(1)},${yy.toFixed(1)} L${x1.toFixed(1)},${yy.toFixed(1)} `;
      }
      el('path', { d, fill: 'none', stroke: colors[si % colors.length], 'stroke-width': s.invalid ? 1.4 : 1.8, 'stroke-dasharray': s.invalid ? '4 3' : null, opacity: s.invalid ? 0.8 : 1 }, svg);
    });
    if (Number.isFinite(opts.lower)) el('line', { x1: X(opts.lower), x2: X(opts.lower), y1: pad.t, y2: height - pad.b, class: 'limit' }, svg);
    if (Number.isFinite(opts.upper)) el('line', { x1: X(opts.upper), x2: X(opts.upper), y1: pad.t, y2: height - pad.b, class: 'limit' }, svg);
    for (const t of niceTicks(lo, hi, 5)) {
      const tx = el('text', { x: X(t), y: height - pad.b + 16, 'text-anchor': 'middle', class: 'axis-label' }, svg);
      tx.textContent = fmtNum(t);
    }
    // legend
    const lg = html('div', { class: 'legend' }, container);
    series.forEach((s, si) => {
      const item = html('span', {}, lg);
      const sw = html('span', { class: 'sw' }, item);
      sw.style.background = colors[si % colors.length];
      if (s.invalid) sw.style.opacity = '0.6';
      item.appendChild(document.createTextNode(`${s.label} · ${(s.yield * 100).toFixed(2)}%`));
    });
  }

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  window.Charts = {
    histogram,
    scatter2d,
    barList,
    scatterCostYield,
    failureBars,
    overlayHistograms,
    niceTicks,
    fmtNum,
    el,
    html,
    esc,
    truncate,
    colors: C,
  };
})();
