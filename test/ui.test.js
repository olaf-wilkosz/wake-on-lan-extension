'use strict';
// Testy UI: prawdziwy popup.js + background.js + shared/api.js w headless Chrome, atrapa chrome.*
// i atrapa serwera gptwol. Asercje na zrzucie DOM oraz na liczbie pakietów, które dotarły do serwera.
// Pomijane, gdy nie ma Chrome (ustaw CHROME_PATH). Uruchom: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeGptwol } = require('./support/fake-gptwol.js');
const { findChrome, writeHarness, runChrome, DEFAULT_HOST } = require('./support/harness.js');

const chrome = findChrome();
const skip = chrome ? false : 'brak Chrome/Chromium (ustaw CHROME_PATH)';

async function scenario(name, awakeIps) {
  const awake = {};
  (awakeIps || []).forEach(function (ip) { awake[ip] = true; });
  const srv = await createFakeGptwol({ awake: awake });
  try {
    const dom = await runChrome(chrome, writeHarness(srv.base, name), ['--dump-dom']);
    return { dom: dom, posts: srv.state.posts };
  } finally { await srv.close(); }
}

// Pomocnicze wyciąganie z zrzutu DOM
function tag(dom, id) { const m = new RegExp('<[a-z]+ id="' + id + '"[^>]*>').exec(dom); return m ? m[0] : ''; }
function text(dom, id) { const m = new RegExp('id="' + id + '"[^>]*>([^<]*)<').exec(dom); return m ? m[1].trim() : ''; }
function hidden(dom, id) { return /\shidden(=|\s|>)/.test(tag(dom, id)); }
function btnClass(dom, id) { const m = /class="([^"]*)"/.exec(tag(dom, id)); return m ? m[1] : ''; }

test('host uśpiony: zielony "Wybudź", status Offline, nic nie wysłano', { skip: skip }, async function () {
  const r = await scenario('idle', []);
  assert.match(text(r.dom, 'defaultHostName'), /Biurko/);
  assert.equal(text(r.dom, 'defaultStatusText'), 'Offline');
  assert.match(btnClass(r.dom, 'defaultWakeBtn'), /btn-wake-big/);
  assert.equal(text(r.dom, 'defaultWakeBtn'), 'Wybudź');
  assert.equal(r.posts.length, 0);
});

test('host działa: czerwony "Uśpij", status Online, bez potwierdzenia na starcie', { skip: skip }, async function () {
  const r = await scenario('idle', [DEFAULT_HOST.ip]);
  assert.equal(text(r.dom, 'defaultStatusText'), 'Online');
  assert.match(btnClass(r.dom, 'defaultWakeBtn'), /btn-sleep-big/);
  assert.equal(text(r.dom, 'defaultWakeBtn'), 'Uśpij');
  assert.equal(hidden(r.dom, 'defaultConfirm'), true);
  assert.equal(r.posts.length, 0);
});

test('klik "Uśpij" tylko prosi o potwierdzenie i NIC nie wysyła', { skip: skip }, async function () {
  const r = await scenario('confirm', [DEFAULT_HOST.ip]);
  assert.equal(hidden(r.dom, 'defaultConfirm'), false);
  assert.equal(hidden(r.dom, 'defaultWakeBtn'), true);
  assert.match(text(r.dom, 'defaultConfirmText'), /Uśpić „Biurko”\?/);
  assert.equal(r.posts.length, 0);
});

test('"Wybudź" wysyła dokładnie jeden Wake-on-LAN', { skip: skip }, async function () {
  const r = await scenario('wake', []);
  assert.deepEqual(r.posts, [{ mac: DEFAULT_HOST.mac, action: 'wake' }]);
  assert.match(text(r.dom, 'toast'), /Wysłano Wake-on-LAN: Biurko/);
});

test('uśpienie po potwierdzeniu wysyła dokładnie jeden Sleep-on-LAN', { skip: skip }, async function () {
  const r = await scenario('sleep', [DEFAULT_HOST.ip]);
  assert.deepEqual(r.posts, [{ mac: DEFAULT_HOST.mac, action: 'sleep' }]);
  assert.match(text(r.dom, 'toast'), /Wysłano Sleep-on-LAN: Biurko/);
});

test('nieaktualny status "offline", a host już działa: "Wybudź" NIE wyłącza go, UI się koryguje', { skip: skip }, async function () {
  const r = await scenario('blocked', [DEFAULT_HOST.ip]);
  assert.equal(r.posts.length, 0, 'nic nie powinno trafić do serwera');
  assert.equal(hidden(r.dom, 'errorBanner'), false);
  assert.match(text(r.dom, 'errorBannerText'), /Host już działa/);
  assert.equal(text(r.dom, 'defaultStatusText'), 'Online');
  assert.match(btnClass(r.dom, 'defaultWakeBtn'), /btn-sleep-big/);
});

test('lista pozostałych hostów po rozwinięciu', { skip: skip }, async function () {
  const r = await scenario('others', []);
  assert.equal(hidden(r.dom, 'otherHostsList'), false);
  assert.match(r.dom, /other-host-name">Laptop</);
  assert.match(r.dom, /other-host-name">Serwer testowy</);
});

test('ustawienia: hosty z serwera z MAC/IP/typem testu i gwiazdką hosta domyślnego', { skip: skip }, async function () {
  const r = await scenario('settings', []);
  assert.equal(hidden(r.dom, 'settingsScreen'), false);
  assert.match(r.dom, /AA:BB:CC:00:00:03 · 10\.0\.0\.3 · TCP 3389/);
  assert.match(r.dom, /AA:BB:CC:00:00:01 · 10\.0\.0\.1 · ICMP/);
  assert.equal((r.dom.match(/>★</g) || []).length >= 1, true);
});
