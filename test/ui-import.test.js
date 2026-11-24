'use strict';

/** UI test: importing by drop — a scenario JSON reopens the analysis, a CSV opens the builder. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { waitFor, openApp, fatalErrors } = require('./jsdom-helpers');

const SCENARIO = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'scenarios', 'small-dimension-check.json'), 'utf8'),
);

/** jsdom has no DataTransfer; build the minimal event the drop handler reads. */
function drop(window, doc, files) {
  const ev = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { files, types: ['Files'] } });
  doc.dispatchEvent(ev);
}

test('UI: drag-and-drop import of a scenario and of a measurement table', async (t) => {
  const { server } = require('../src/server/server');
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { dom, window, doc, pageErrors, $, $$ } = await openApp(base);
  t.after(() => dom.window.close());

  // 1. drop a saved scenario file → it is analysed and the overview opens
  drop(window, doc, [new window.File([JSON.stringify(SCENARIO)], 'check.json', { type: 'application/json' })]);
  await waitFor(() => window.__TYL.state.analysis, 30000, 'dropped scenario analysis');
  assert.equal(window.__TYL.state.analysis.scenario.name, SCENARIO.name);
  assert.equal($('#panel-overview').hidden, false);
  assert.ok($('#metricGrid').textContent.includes('联合装配合格率'));

  // 2. drop a measurement table → the builder opens with that part pre-filled
  const csv = 'feature_a,feature_b\n40.000,12.000\n39.996,12.004\n40.004,11.996\n40.001,12.002\n';
  drop(window, doc, [new window.File([csv], 'bracket.csv', { type: 'text/csv' })]);
  await waitFor(() => $('#onboardBuilder').hidden === false, 10000, 'builder opened by CSV drop');
  await waitFor(() => $$('#partDataList textarea').length >= 1, 10000, 'part table filled');
  assert.equal($('#partDataList textarea').value, csv);
  assert.ok($('#partDataList').textContent.includes('feature_a'), 'columns parsed');
  assert.ok($('#builderSummary').textContent.includes('约束'), 'constraint step still needs attention');

  assert.deepEqual(fatalErrors(pageErrors), []);
});
