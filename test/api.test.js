'use strict';
// Testy klienta API (shared/api.js) na atrapie serwera gptwol. Uruchom: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const Api = require('../shared/api.js');
const { createFakeGptwol } = require('./support/fake-gptwol.js');

const HOST = { mac: 'AA:BB:CC:00:00:01', ip: '10.0.0.1', testType: 'icmp' };

test('lista hostów: parsowanie kart, test_type, dekodowanie encji HTML', async function () {
  const srv = await createFakeGptwol({
    computers: [
      { mac: 'AA:BB:CC:00:00:01', name: 'Tom & Jerry "PC" <1>', ip: '10.0.0.1', testType: 'icmp' },
      { mac: 'AA:BB:CC:00:00:02', name: "L'ordi", ip: '10.0.0.2', testType: '3389' }
    ]
  });
  try {
    const r = await Api.getComputers(srv.base);
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, [
      { mac: 'AA:BB:CC:00:00:01', name: 'Tom & Jerry "PC" <1>', ip: '10.0.0.1', testType: 'icmp' },
      { mac: 'AA:BB:CC:00:00:02', name: "L'ordi", ip: '10.0.0.2', testType: '3389' }
    ]);
  } finally { await srv.close(); }
});

test('status: awake / asleep', async function () {
  const srv = await createFakeGptwol({ awake: { '10.0.0.1': true } });
  try {
    assert.deepEqual(await Api.checkStatus(srv.base, HOST), { ok: true, data: { isUp: true } });
    assert.deepEqual(await Api.checkStatus(srv.base, { mac: 'x', ip: '10.0.0.2', testType: 'icmp' }), { ok: true, data: { isUp: false } });
  } finally { await srv.close(); }
});

test('wake gdy host uśpiony: wysyła POST, action=wake', async function () {
  const srv = await createFakeGptwol();
  try {
    const r = await Api.sendPower(srv.base, HOST, 'wake');
    assert.equal(r.ok, true);
    assert.equal(r.data.action, 'wake');
    assert.deepEqual(srv.state.posts, [{ mac: HOST.mac, action: 'wake' }]);
  } finally { await srv.close(); }
});

test('wake gdy host działa: BLOKADA, nic nie wysłano (serwer by go wyłączył)', async function () {
  const srv = await createFakeGptwol({ awake: { '10.0.0.1': true } });
  try {
    const r = await Api.sendPower(srv.base, HOST, 'wake');
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'already_awake');
    assert.equal(srv.state.posts.length, 0);
  } finally { await srv.close(); }
});

test('sleep gdy host działa: wysyła POST, action=sleep', async function () {
  const srv = await createFakeGptwol({ awake: { '10.0.0.1': true } });
  try {
    const r = await Api.sendPower(srv.base, HOST, 'sleep');
    assert.equal(r.ok, true);
    assert.equal(r.data.action, 'sleep');
    assert.deepEqual(srv.state.posts, [{ mac: HOST.mac, action: 'sleep' }]);
  } finally { await srv.close(); }
});

test('sleep gdy host uśpiony: odmowa, nic nie wysłano', async function () {
  const srv = await createFakeGptwol();
  try {
    const r = await Api.sendPower(srv.base, HOST, 'sleep');
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'already_asleep');
    assert.equal(srv.state.posts.length, 0);
  } finally { await srv.close(); }
});

test('wyścig: zamiar wake, ale serwer wykonał sleep -- raportujemy faktyczną akcję', async function () {
  const srv = await createFakeGptwol(); // nasze sprawdzenie widzi "asleep"
  srv.state.forceReplyAction = 'sleep';  // a serwer przy wysyłaniu zdecydował inaczej
  try {
    const r = await Api.sendPower(srv.base, HOST, 'wake');
    assert.equal(r.ok, true);
    assert.equal(r.data.action, 'sleep');
  } finally { await srv.close(); }
});

test('nieznany MAC: HTTP 500 z podpowiedzią o dodaniu hosta w panelu', async function () {
  const srv = await createFakeGptwol();
  try {
    const r = await Api.sendPower(srv.base, { mac: 'FF:FF:FF:FF:FF:FF', ip: '10.0.0.1', testType: 'icmp' }, 'wake');
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'http_error');
    assert.equal(r.status, 500);
    assert.match(Api.errorToPolish(r), /dodany w panelu/);
  } finally { await srv.close(); }
});

test('włączone logowanie (302 -> /login): auth_required', async function () {
  const srv = await createFakeGptwol();
  srv.state.mode = 'login';
  try {
    const r = await Api.getComputers(srv.base);
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'auth_required');
  } finally { await srv.close(); }
});

test('strona, która nie jest gptwol: bad_format', async function () {
  const srv = await createFakeGptwol();
  srv.state.mode = 'foreign';
  try {
    const r = await Api.getComputers(srv.base);
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'bad_format');
  } finally { await srv.close(); }
});

test('serwer nie odpowiada: timeout', async function () {
  const srv = await createFakeGptwol();
  try {
    const r = await Api.request(srv.base, 'hang', { timeoutMs: 150 });
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'timeout');
  } finally { await srv.close(); }
});

test('serwer wyłączony (odmowa połączenia): network', async function () {
  const srv = await createFakeGptwol();
  const base = srv.base;
  await srv.close();
  const r = await Api.getComputers(base);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'network');
  assert.match(Api.errorToPolish(r), /VPN/);
});

test('originPatternFor uwzględnia port; normalizeBaseUrl dopisuje ukośnik', function () {
  assert.equal(Api.originPatternFor('http://192.0.2.10:5000/'), 'http://192.0.2.10:5000/*');
  assert.equal(Api.originPatternFor('https://wol.example/'), 'https://wol.example/*');
  assert.equal(Api.originPatternFor('nie-url'), null);
  assert.equal(Api.normalizeBaseUrl('http://x:5000'), 'http://x:5000/');
});
