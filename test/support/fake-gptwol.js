'use strict';
// Atrapa serwera gptwol do testów: odtwarza TYLKO to, z czego korzysta rozszerzenie
// (GET /, GET /check_status, POST /wol_or_sol_send) -- razem z przełącznikiem wake/sleep.
const http = require('http');

const DEFAULT_COMPUTERS = [
  { mac: 'AA:BB:CC:00:00:01', name: 'Biurko', ip: '10.0.0.1', testType: 'icmp' },
  { mac: 'AA:BB:CC:00:00:02', name: 'Laptop', ip: '10.0.0.2', testType: 'icmp' },
  { mac: 'AA:BB:CC:00:00:03', name: 'Serwer testowy', ip: '10.0.0.3', testType: '3389' }
];

// Jinja domyślnie escapuje HTML w nazwach -- odtwarzamy to, żeby przetestować dekodowanie encji.
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;').replace(/'/g, '&#39;');
}

function cardHtml(c) {
  return '<form method="POST" action="/wol_or_sol_send">' +
    '<input type="hidden" name="mac_address" value="' + esc(c.mac) + '"></form>' +
    '<div class="sortable fs-4">' + esc(c.name) + '</div>' +
    '<span class="status-indicator asleep" data-ip-address="' + esc(c.ip) + '" data-test-type="' + esc(c.testType) + '"></span>';
}

// mode: 'normal' | 'login' (przekierowanie na /login) | 'foreign' (strona, która nie jest gptwol)
function createFakeGptwol(options) {
  options = options || {};
  const state = {
    computers: options.computers || DEFAULT_COMPUTERS.map(function (c) { return Object.assign({}, c); }),
    awake: Object.assign({}, options.awake),   // ip -> bool
    mode: 'normal',
    forceReplyAction: null,                    // symulacja wyścigu: serwer "zrobił" co innego niż stan sugeruje
    posts: []                                  // zarejestrowane POST /wol_or_sol_send: { mac, action }
  };

  const server = http.createServer(function (req, res) {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*'); // tylko dla testów UI z file:// (prawdziwy gptwol CORS nie wysyła)

    if (state.mode === 'login' && u.pathname !== '/login') {
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    if (u.pathname === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html>formularz logowania</html>');
    }
    if (state.mode === 'foreign') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><title>Inna strona</title></html>');
    }
    if (u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<title>GPTWOL</title>' + state.computers.map(cardHtml).join('\n'));
    }
    if (u.pathname === '/check_status') {
      res.writeHead(200);
      return res.end(state.awake[u.searchParams.get('ip_address')] ? 'awake' : 'asleep');
    }
    if (u.pathname === '/hang') return; // nigdy nie odpowiada -- test timeoutu
    if (u.pathname === '/wol_or_sol_send' && req.method === 'POST') {
      let body = '';
      req.on('data', function (d) { body += d; });
      req.on('end', function () {
        const mac = new URLSearchParams(body).get('mac_address');
        const computer = state.computers.filter(function (c) { return c.mac === mac; })[0];
        if (!computer) {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          return res.end('<title>500 Internal Server Error</title><h1>Internal Server Error</h1>');
        }
        const action = state.forceReplyAction || (state.awake[computer.ip] ? 'sleep' : 'wake');
        state.posts.push({ mac: mac, action: action });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(action === 'sleep'
          ? '<h5>Shutdown</h5>Sleep On Lan Magic Packet Sent to ' + esc(computer.name) + '!'
          : '<h5>Wakeup</h5>Wake On Lan Mode: L4 Packet<br>Wake On Lan Magic Packet Sent to ' + esc(computer.name) + '!');
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  return new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(options.port || 0, '127.0.0.1', function () {
      resolve({
        base: 'http://127.0.0.1:' + server.address().port + '/',
        state: state,
        close: function () { server.closeAllConnections && server.closeAllConnections(); return new Promise(function (r) { server.close(r); }); }
      });
    });
  });
}

module.exports = { createFakeGptwol: createFakeGptwol, DEFAULT_COMPUTERS: DEFAULT_COMPUTERS };
