'use strict';

/** Shared jsdom harness for UI tests. */

const { JSDOM, VirtualConsole } = require('jsdom');

function waitFor(fn, timeout = 20000, label = 'condition') {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function tick() {
      let v;
      try {
        v = fn();
      } catch (e) {
        v = false;
      }
      if (v) return resolve(v);
      if (Date.now() - start > timeout) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 60);
    })();
  });
}

async function openApp(base) {
  const pageErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => pageErrors.push(e));
  virtualConsole.on('error', (...args) => pageErrors.push(new Error(args.join(' '))));

  const dom = await JSDOM.fromURL(base + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = (input, init) => fetch(new URL(String(input), base), init);
      window.matchMedia = () => ({
        matches: false,
        media: '',
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return false;
        },
      });
      window.HTMLElement.prototype.scrollIntoView = function () {};
      window.URL.createObjectURL = () => 'blob:mock';
      window.URL.revokeObjectURL = () => {};
    },
  });
  const { window } = dom;
  const doc = window.document;
  await waitFor(() => doc.readyState === 'complete', 20000, 'document load');
  await waitFor(() => window.__TYL, 10000, 'app boot');
  return {
    dom,
    window,
    doc,
    pageErrors,
    $: (s) => doc.querySelector(s),
    $$: (s) => Array.from(doc.querySelectorAll(s)),
  };
}

/** Uncaught errors during the run, ignoring jsdom's known CSS noise. */
function fatalErrors(pageErrors) {
  return pageErrors
    .filter((e) => !/Could not parse CSS|Not implemented/.test(String(e.message || e)))
    .map((e) => String(e.message || e));
}

module.exports = { waitFor, openApp, fatalErrors };
