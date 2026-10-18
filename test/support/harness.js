'use strict';
// Uruchamia PRAWDZIWE popup.html + popup.js + background.js + shared/api.js w headless Chrome,
// z atrapą chrome.* (storage/runtime/alarms/action/permissions/tabs) zamiast prawdziwego API
// rozszerzeń. Dzięki temu testujemy cały łańcuch UI -> wiadomości -> background -> api -> serwer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { pathToFileURL } = require('url');
const { DEFAULT_COMPUTERS } = require('./fake-gptwol.js');

const ROOT = path.join(__dirname, '..', '..');
const read = function (f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); };
const DEFAULT_HOST = DEFAULT_COMPUTERS[0];

function findChrome() {
  return [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean).filter(function (p) { return fs.existsSync(p); })[0] || null;
}

// scenario: idle | confirm | wake | sleep | blocked | others | settings
//   blocked = nieaktualny cache ("offline"), a serwer w rzeczywistości już działa
// Headless Chrome trzyma się motywu systemowego, a nie da się go łatwo wymusić na jasny --
// do zrzutów w jasnym motywie wycinamy z CSS blok @media (prefers-color-scheme: dark).
function stripDarkMedia(css) {
  const start = css.indexOf('@media (prefers-color-scheme: dark)');
  if (start === -1) return css;
  let depth = 0, i = css.indexOf('{', start);
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) break;
  }
  return stripDarkMedia(css.slice(0, start) + css.slice(i + 1));
}

function buildHarness(base, scenario, opts) {
  opts = opts || {};
  const stale = scenario === 'blocked';
  const localSeed = stale
    ? { hostsCache: DEFAULT_COMPUTERS, hostsCacheTime: Date.now(), statusCache: {} }
    : {};
  if (stale) localSeed.statusCache[DEFAULT_HOST.mac] = { isUp: false, lastChecked: Date.now(), errorKind: null };

  const stub = `
  const store = { sync: { serverUrl: ${JSON.stringify(base)}, defaultHostId: ${JSON.stringify(DEFAULT_HOST.mac)}, pollMinutes: 5 }, local: ${JSON.stringify(localSeed)} };
  const listeners = [], msgListeners = [];
  const clone = v => v === undefined ? v : JSON.parse(JSON.stringify(v));
  function area(name) { return {
    get(d) { const r = {}; Object.keys(d).forEach(k => r[k] = (k in store[name]) ? clone(store[name][k]) : d[k]); return Promise.resolve(r); },
    set(o) { const ch = {}; Object.keys(o).forEach(k => { ch[k] = { oldValue: store[name][k], newValue: clone(o[k]) }; store[name][k] = clone(o[k]); }); setTimeout(() => listeners.forEach(f => f(ch, name)), 0); return Promise.resolve(); },
    remove(keys) { [].concat(keys).forEach(k => delete store[name][k]); return Promise.resolve(); } }; }
  window.chrome = {
    storage: { sync: area('sync'), local: area('local'), onChanged: { addListener: f => listeners.push(f) } },
    runtime: { lastError: undefined, getURL: p => 'chrome-extension://test/' + p,
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      onMessage: { addListener: f => msgListeners.push(f) },
      sendMessage(msg, cb) { let async = false; for (const f of msgListeners) { const r = f(msg, {}, resp => cb && cb(resp)); if (r === true) async = true; } if (!async && cb) cb(undefined); } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setIcon() {} },
    permissions: { contains: () => Promise.resolve(true), request: () => Promise.resolve(true) },
    tabs: { create() {} }
  };
  window.importScripts = function () {};`;

  const driver = `
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);
  (async () => {
    await wait(900);
    const sc = ${JSON.stringify(scenario)};
    if (sc === 'confirm') { $('defaultWakeBtn').click(); await wait(200); }
    if (sc === 'wake' || sc === 'blocked') { $('defaultWakeBtn').click(); await wait(1200); }
    if (sc === 'sleep') { $('defaultWakeBtn').click(); await wait(200); $('defaultConfirmYes').click(); await wait(1200); }
    if (sc === 'others') { $('toggleOthers').click(); await wait(200); }
    if (sc === 'settings') { $('openSettings').click(); await wait(500); }
    document.title = 'DONE';
  })();`;

  let html = read('popup.html')
    .replace('<link rel="stylesheet" href="popup.css">', '<style>' + (opts.light ? stripDarkMedia(read('popup.css')) : read('popup.css')) + '</style>')
    .replace('<script src="shared/api.js"></script>', '')
    .replace('<script src="popup.js"></script>', '');
  const scripts = [stub, read('shared/api.js'), read('background.js'), read('popup.js'), driver]
    .map(function (code) { return '<script>' + code + '</script>'; }).join('');
  return html.replace('</body>', scripts + '</body>');
}

function runChrome(chrome, htmlFile, extraArgs) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wol-ui-'));
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + profile,
    '--virtual-time-budget=5000'].concat(extraArgs || [], [pathToFileURL(htmlFile).href]);
  return new Promise(function (resolve) {
    const p = cp.spawn(chrome, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', function (d) { out += d; });
    const timer = setTimeout(function () { p.kill(); }, 45000);
    p.on('close', function () {
      clearTimeout(timer);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* profil tymczasowy */ }
      resolve(out);
    });
  });
}

function writeHarness(base, scenario, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wol-harness-'));
  const file = path.join(dir, scenario + '.html');
  fs.writeFileSync(file, buildHarness(base, scenario, opts));
  return file;
}

module.exports = { findChrome: findChrome, writeHarness: writeHarness, runChrome: runChrome, DEFAULT_HOST: DEFAULT_HOST };
