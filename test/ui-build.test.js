'use strict';

/** UI test: build a scenario from an empty project and run the full flow. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { waitFor, openApp, fatalErrors } = require('./jsdom-helpers');

test('UI: build a scenario from an empty project and run it', async (t) => {
  const { server } = require('../src/server/server');
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { dom, window, pageErrors, $, $$ } = await openApp(base);
  t.after(() => dom.window.close());

  // 1. enter the builder from an empty project
  $('#newScenarioBtn').click();
  await waitFor(() => $('#onboardBuilder').hidden === false, 5000, 'builder visible');
  assert.equal($$('#partDataList .builder-part').length, 1);

  // 2. fill the example measurement table (two dimensions, 8 rows)
  $('#pasteExampleBtn').click();
  await waitFor(() => $$('#partDataList textarea').length === 1, 5000, 'example table');
  const ta = $('#partDataList textarea');
  assert.ok(ta.value.split('\n').length >= 9, 'example CSV has header + rows');
  assert.ok($('#partDataList').textContent.includes('feature_a'));

  // 3. fill the assembly constraint: pick the part + one dimension, set limits
  const cpart = $('#constraintList').querySelectorAll('select')[0];
  assert.ok(Array.from(cpart.options).some((o) => o.value === 'part1'), 'part option available');
  cpart.value = 'part1';
  cpart.dispatchEvent(new window.Event('change'));
  await waitFor(() => $$('#constraintList select')[1].options.length >= 2, 3000, 'variable options');
  const cvar = $('#constraintList').querySelectorAll('select')[1];
  cvar.value = 'feature_a';
  cvar.dispatchEvent(new window.Event('change'));

  const stepInputs = $$('#constraintList input[type="number"]').filter((n) => n.step === '0.001');
  assert.ok(stepInputs.length >= 2, 'lower/upper inputs');
  stepInputs[0].value = '39.998';
  stepInputs[0].dispatchEvent(new window.Event('change'));
  stepInputs[1].value = '40.002';
  stepInputs[1].dispatchEvent(new window.Event('change'));
  await waitFor(() => $('#builderSummary').textContent.includes('结构检查通过'), 5000, 'builder validation');

  // 4. run analysis straight from the builder
  $('#simDraws').value = '1000';
  $('#simDraws').dispatchEvent(new window.Event('change'));
  $('#runAnalyzeBtn').click();
  await waitFor(() => window.__TYL.state.analysis, 30000, 'builder analysis');
  const res = window.__TYL.state.analysis;
  assert.ok(res.baseline.yield > 0 && res.baseline.yield < 1);
  assert.equal(res.baseline.method, 'empirical');
  assert.equal($('#panel-overview').hidden, false, 'switched to overview');
  assert.equal($('#overviewContent').hidden, false);
  assert.ok($('#metricGrid').textContent.includes('联合装配合格率'));

  // 5. the optimizer runs against the self-built scenario
  $$('.tab').find((x) => x.dataset.panel === 'optimize').click();
  $('#runOptimizeBtn').click();
  await waitFor(() => window.__TYL.state.optimization, 90000, 'builder optimize');
  const o = window.__TYL.state.optimization;
  assert.equal(o.consistency.costMatches, true);
  assert.ok(o.recommended.cost <= o.budget + 1e-9);

  assert.deepEqual(fatalErrors(pageErrors), []);
});
