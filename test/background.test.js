'use strict';
// Testy dziennika błędów w background.js. Ładujemy prawdziwy plik do izolowanego kontekstu (vm)
// z atrapą chrome.* -- bez przeglądarki. Uruchom: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function loadBackground() {
  const store = { sync: {}, local: {} };
  const logs = { info: [], error: [] };
  const area = function (name) {
    return {
      get: function (d) { const r = {}; Object.keys(d).forEach(function (k) { r[k] = (k in store[name]) ? JSON.parse(JSON.stringify(store[name][k])) : d[k]; }); return Promise.resolve(r); },
      set: function (o) { Object.keys(o).forEach(function (k) { store[name][k] = JSON.parse(JSON.stringify(o[k])); }); return Promise.resolve(); },
      remove: function () { return Promise.resolve(); }
    };
  };
  const noop = { addListener: function () {} };
  const chrome = {
    storage: { sync: area('sync'), local: area('local'), onChanged: noop },
    runtime: { onInstalled: noop, onStartup: noop, onMessage: noop },
    alarms: { create: function () {}, onAlarm: noop },
    action: { setBadgeText: function () {}, setBadgeBackgroundColor: function () {}, setIcon: function () {} },
    permissions: { contains: function () { return Promise.resolve(true); } }
  };
  const ctx = vm.createContext({
    chrome: chrome, URL: URL, URLSearchParams: URLSearchParams, AbortController: AbortController,
    setTimeout: setTimeout, clearTimeout: clearTimeout, fetch: function () { return Promise.reject(new Error('brak sieci w teście')); },
    console: { info: function (m) { logs.info.push(m); }, error: function (m) { logs.error.push(m); }, log: function () {}, warn: function () {} }
  });
  ctx.importScripts = function (f) { vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx); };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), ctx);
  return { ctx: ctx, store: store, logs: logs };
}

const plain = function (v) { return JSON.parse(JSON.stringify(v)); };

test('brak sieci/VPN (network, timeout) idzie jako info, a nie console.error', async function () {
  const bg = loadBackground();
  bg.ctx.logError('Sprawdzanie hosta "A"', { ok: false, kind: 'network', message: 'Failed to fetch' });
  bg.ctx.logError('Sprawdzanie hosta "A"', { ok: false, kind: 'timeout', message: 'Przekroczono czas oczekiwania.' });
  await bg.ctx.errorLogQueue;
  assert.equal(bg.logs.error.length, 0, 'oczekiwany stan offline nie może zalewać chrome://extensions -> Błędy');
  assert.equal(bg.logs.info.length, 2);
});

test('błędy wymagające reakcji (HTTP, format, logowanie, uprawnienia) nadal idą jako console.error', async function () {
  const bg = loadBackground();
  ['http_error', 'bad_format', 'auth_required', 'permission'].forEach(function (kind) {
    bg.ctx.logError('ctx ' + kind, { ok: false, kind: kind, status: kind === 'http_error' ? 500 : undefined });
  });
  await bg.ctx.errorLogQueue;
  assert.equal(bg.logs.error.length, 4);
  assert.equal(bg.logs.info.length, 0);
});

test('powtarzający się błąd scala się w jeden wpis z licznikiem (także przy przeplataniu kontekstów)', async function () {
  const bg = loadBackground();
  const A = ['Sprawdzanie hosta "A"', { ok: false, kind: 'timeout', message: 'Przekroczono czas oczekiwania.' }];
  const B = ['Pobieranie listy hostów', { ok: false, kind: 'timeout', message: 'Przekroczono czas oczekiwania.' }];
  // typowy tick bez VPN: lista i status padają na przemian
  for (let i = 0; i < 5; i++) { bg.ctx.logError.apply(null, A); bg.ctx.logError.apply(null, B); }
  await bg.ctx.errorLogQueue;
  const log = plain(bg.store.local.errorLog);
  assert.equal(log.length, 2, 'dwa różne zdarzenia = dwa wpisy, nie dziesięć');
  assert.deepEqual(log.map(function (e) { return e.count; }), [5, 5]);
  assert.match(log[0].message, /VPN/);
});

test('różne błędy nie są scalane, a dziennik ma limit 50 wpisów', async function () {
  const bg = loadBackground();
  for (let i = 0; i < 60; i++) bg.ctx.logError('zdarzenie ' + i, { ok: false, kind: 'http_error', status: 500 });
  await bg.ctx.errorLogQueue;
  const log = plain(bg.store.local.errorLog);
  assert.equal(log.length, 50);
  assert.equal(log[0].context, 'zdarzenie 59', 'najnowszy na górze');
});

test('jednoczesne błędy nie gubią zliczeń (zapis do dziennika jest szeregowany)', async function () {
  const bg = loadBackground();
  for (let i = 0; i < 20; i++) bg.ctx.logError('to samo', { ok: false, kind: 'timeout', message: 'x' });
  await bg.ctx.errorLogQueue;
  const log = plain(bg.store.local.errorLog);
  assert.equal(log.length, 1);
  assert.equal(log[0].count, 20);
});
