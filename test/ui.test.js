'use strict';

/**
 * UI smoke test with jsdom against the real server.
 *
 * There is no browser in this environment, so this drives the actual page:
 * scripts load, the demo picker fills, analysis renders, the 2-D section is
 * drawn (SVG), the optimizer runs and the compare panel appears. It checks the
 * wiring, not pixel layout.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { waitFor, openApp, fatalErrors } = require('./jsdom-helpers');

test('UI: demo → analyze → section → optimize → compare', async (t) => {
  const { server } = require('../src/server/server');
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { dom, window, doc, pageErrors, $, $$ } = await openApp(base);
  t.after(() => dom.window.close());

  // 1. demo picker
  $('#loadDemoBtn').click();
  await waitFor(() => $$('#onboardDemoPicker .scenario-option').length >= 5, 15000, 'demo picker');
  const options = $$('#onboardDemoPicker .scenario-option');
  assert.ok(options.length >= 5);
  assert.ok(options.some((o) => /相关/.test(o.textContent)), 'correlation scenario offered');

  // pick the strongly-correlated pump scenario
  const pump = options.find((o) => /泵体/.test(o.textContent)) || options[0];
  pump.click();
  await waitFor(() => window.__TYL.state.analysis, 30000, 'analysis');
  await waitFor(() => !$('#panel-overview').hidden && $('#overviewContent').hidden === false, 15000, 'overview visible');

  const a = window.__TYL.state.analysis;
  assert.ok(a.baseline.yield > 0 && a.baseline.yield < 1);
  assert.ok($('#metricGrid').textContent.includes('联合装配合格率'));
  // This scenario has a single assembly constraint; the correlation trap must be
  // shown via the invalid independent-shuffle control instead of a product gap.
  if (a.baseline.constraints.length === 1) {
    const ind = (a.tails || []).find((t) => t.key === 'independent');
    assert.ok(ind && ind.invalid, 'single-constraint scenario still shows the shuffle control');
    assert.ok(ind.yield > a.baseline.yield + 0.02, 'shuffle must inflate the yield');
  } else {
    assert.ok(a.baseline.marginalProduct > a.baseline.yield, 'correlation scenario should show product > joint');
  }

  // trap bars rendered as DOM bars
  await waitFor(() => $$('#trapBars .bar-row').length >= 3, 10000, 'trap bars');
  assert.ok($('#trapNote').textContent.length > 5);

  // 2. failure export button exists and distribution chart produced an SVG
  assert.ok($('#downloadFailuresBtn'));
  await waitFor(() => $('#distChart svg'), 15000, 'constraint histogram SVG');
  assert.ok($('#distTable table'), 'table twin for the histogram');

  // 3. explanation tab draws a 2-D section
  $$('.tab').find((x) => x.dataset.panel === 'explain').click();
  await waitFor(() => $('#sectionChart svg'), 20000, 'section SVG');
  assert.ok($('#sectionMeta').textContent.includes('截面联合合格率'));
  assert.ok(window.__TYL.state.section && window.__TYL.state.section.points.length > 50);
  assert.ok($('#corrTables table'), 'correlation matrix rendered');
  assert.ok($('#dimTable table'), 'per-dimension table rendered');

  // lock a process parameter and redraw
  const fixSel = $('#sectionFixKey');
  const opt = Array.from(fixSel.options).find((o) => o.value);
  fixSel.value = opt.value;
  fixSel.dispatchEvent(new window.Event('change'));
  assert.equal($('#sectionFixValue').disabled, false, 'lock value input enabled');
  $('#sectionFixValue').value = '0.01';
  $('#drawSectionBtn').click();
  await waitFor(() => window.__TYL.state.section && window.__TYL.state.section.fixed, 20000, 'locked section');
  assert.ok($('#sectionMeta').textContent.includes('锁定'));

  // 4. verify tab
  $('#runVerifyBtn').click();
  await waitFor(() => window.__TYL.state.verification, 40000, 'verification');
  await waitFor(() => $('#verifyBox table'), 20000, 'verification tables');
  assert.ok($('#verifyBox').textContent.includes('穷举'));

  // 5. optimize
  $$('.tab').find((x) => x.dataset.panel === 'optimize').click();
  $('#optDraws').value = '2000';
  $('#runOptimizeBtn').click();
  await waitFor(() => window.__TYL.state.optimization, 90000, 'optimization');
  await waitFor(() => $('#optResults').hidden === false, 20000, 'optimize results visible');
  const o = window.__TYL.state.optimization;
  assert.equal(o.consistency.fingerprintMatches, true);
  assert.equal(o.consistency.costMatches, true);
  assert.ok(o.recommended.cost <= o.budget + 1e-9);
  assert.ok($('#optAdjustments').textContent.length > 0);
  await waitFor(() => $('#optFrontier svg'), 15000, 'frontier SVG');
  assert.ok($('#optConsistency').textContent.includes('版本一致性'));

  // 6. compare base vs candidate with paired delta
  $('#sendToCompareBtn').click();
  await waitFor(() => window.__TYL.state.compare, 40000, 'compare');
  await waitFor(() => $('#compareContent').hidden === false, 15000, 'compare visible');
  assert.equal($$('#compareCards .card').length, 2);
  assert.ok($('#compareDelta').textContent.includes('配对差'));
  assert.ok($('#compareConstraints table'));
  const c = window.__TYL.state.compare;
  assert.ok(c.delta.lo <= c.delta.mean && c.delta.hi >= c.delta.mean);
  assert.equal(c.base.fingerprint !== c.candidate.fingerprint, true, 'candidate has its own version fingerprint');

  // no uncaught page errors during the whole run
  assert.deepEqual(fatalErrors(pageErrors), []);
});
