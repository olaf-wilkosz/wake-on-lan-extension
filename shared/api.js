/* Klient API gptwol (github.com/Misterbabou/gptwol) -- JEDYNE miejsce, które zna jego kontrakt.
   Ładowany przez <script> w popup oraz przez importScripts() w background.js (service worker),
   stąd brak importów ES module i brak DOMParser (service worker go nie ma) -- HTML parsujemy regexami.

   gptwol nie ma udokumentowanego API ani endpointu JSON. Poniższe wywołania wynikają z czytania
   jego kodu (app/wol.py, templates/wol_form.html) i mogą się zmienić przy aktualizacji serwera:
     GET  /                          lista komputerów wyrenderowana w HTML (nie ma osobnego JSON-a)
     GET  /check_status?ip_address=&test_type=   -> tekst "awake" | "asleep"
     POST /wol_or_sol_send (mac_address=)        -> HTML z modalem; serwer SAM sprawdza, czy host
                                                    działa: jeśli tak, wysyła Sleep-on-LAN (wyłączenie),
                                                    jeśli nie -- Wake-on-LAN. To PRZEŁĄCZNIK. */

var WolApi = (function () {

  function normalizeBaseUrl(baseUrl) {
    var trimmed = (baseUrl || '').trim();
    if (!trimmed) return trimmed;
    return trimmed.endsWith('/') ? trimmed : trimmed + '/';
  }

  function buildUrl(baseUrl, path, params) {
    var url = normalizeBaseUrl(baseUrl) + (path || '');
    var keys = Object.keys(params || {});
    if (keys.length) {
      url += '?' + keys.map(function (key) {
        return encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key]));
      }).join('&');
    }
    return url;
  }

  function stripTags(html) {
    return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Serwer nie wysyła nagłówków CORS i prawdopodobnie nigdy nie wyśle (patrz NOTES.md). Te
  // fetch()e i tak działają, bo origin serwera dostaje uprawnienie hosta (optional_host_permissions
  // + chrome.permissions.request przy zapisie adresu), a konteksty rozszerzenia z takim
  // uprawnieniem są zwolnione z CORS. Nie próbuj tego "naprawiać" trybem no-cors ani proxy.
  function request(baseUrl, path, options) {
    options = options || {};
    var timeoutMs = options.timeoutMs || 8000;
    var url = buildUrl(baseUrl, path, options.params);
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);

    var init = { method: options.method || 'GET', signal: controller.signal };
    if (options.form) init.body = new URLSearchParams(options.form);

    return fetch(url, init)
      .then(function (response) {
        return response.text().then(function (text) {
          // Włączone logowanie w gptwol = przekierowanie na /login (HTML). Rozszerzenie go jeszcze nie obsługuje.
          if (response.redirected && /\/login(\?|$)/.test(response.url)) {
            return { ok: false, kind: 'auth_required', message: response.url };
          }
          if (!response.ok) {
            return { ok: false, kind: 'http_error', status: response.status, message: stripTags(text).slice(0, 200) };
          }
          return { ok: true, text: text };
        });
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') {
          return { ok: false, kind: 'timeout', message: 'Przekroczono czas oczekiwania.' };
        }
        return { ok: false, kind: 'network', message: err && err.message };
      })
      .finally(function () {
        clearTimeout(timer);
      });
  }

  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
  function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
      if (ENTITIES[e.toLowerCase()] !== undefined) return ENTITIES[e.toLowerCase()];
      if (e[0] === '#') {
        var code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return m;
    });
  }

  // Wyciąga komputery z HTML strony głównej gptwol. Kotwica: ukryte pole mac_address w formularzu
  // karty (jedyne `type="hidden" name="mac_address"` na stronie), potem nazwa, potem atrybuty
  // data-* wskaźnika statusu. Zwraca null, jeśli strona w ogóle nie wygląda jak gptwol.
  function parseComputers(html) {
    if (!/GPTWOL/i.test(html) || !/status-indicator|computer-card|wol_or_sol_send/.test(html)) {
      return null;
    }
    var re = /type="hidden"\s+name="mac_address"\s+value="([^"]+)"[\s\S]*?class="sortable fs-4">([\s\S]*?)<\/div>[\s\S]*?data-ip-address="([^"]*)"\s+data-test-type="([^"]*)"/g;
    var computers = [];
    var m;
    while ((m = re.exec(html)) !== null) {
      computers.push({
        mac: decodeEntities(m[1]).trim(),
        name: decodeEntities(m[2]).trim(),
        ip: decodeEntities(m[3]).trim(),
        testType: decodeEntities(m[4]).trim()
      });
    }
    return computers;
  }

  function getComputers(baseUrl) {
    return request(baseUrl, '', { timeoutMs: 8000 }).then(function (r) {
      if (!r.ok) return r;
      var computers = parseComputers(r.text);
      if (computers === null) {
        return { ok: false, kind: 'bad_format', message: 'Strona główna nie wygląda jak gptwol.' };
      }
      return { ok: true, data: computers };
    });
  }

  function checkStatus(baseUrl, host) {
    return request(baseUrl, 'check_status', {
      params: { ip_address: host.ip, test_type: host.testType },
      timeoutMs: 8000
    }).then(function (r) {
      if (!r.ok) return r;
      var t = r.text.trim();
      if (t === 'awake') return { ok: true, data: { isUp: true } };
      if (t === 'asleep') return { ok: true, data: { isUp: false } };
      return { ok: false, kind: 'bad_format', message: 'Nieoczekiwana odpowiedź statusu: ' + t.slice(0, 80) };
    });
  }

  // Serwer ma tylko przełącznik, więc intencję pilnujemy sami: najpierw sprawdzamy status tym
  // samym testem, którego użyje serwer, i odmawiamy, gdy wysłanie dałoby odwrotny skutek
  // (np. "Wybudź" na działającym komputerze wyłączyłoby go przez Sleep-on-LAN).
  // intent: 'wake' | 'sleep'. Wynik: { ok:true, data:{ action } } -- action to to, co serwer
  // FAKTYCZNIE zrobił (wyścig między sprawdzeniem a wysłaniem jest możliwy, choć wąski).
  function sendPower(baseUrl, host, intent) {
    return checkStatus(baseUrl, host).then(function (st) {
      if (!st.ok) return st;
      if (intent === 'wake' && st.data.isUp) return { ok: false, kind: 'already_awake' };
      if (intent === 'sleep' && !st.data.isUp) return { ok: false, kind: 'already_asleep' };
      return request(baseUrl, 'wol_or_sol_send', {
        method: 'POST',
        form: { mac_address: host.mac },
        timeoutMs: 10000
      }).then(function (r) {
        if (!r.ok) return r;
        var action = null;
        if (/Sleep On Lan Magic Packet Sent/i.test(r.text)) action = 'sleep';
        else if (/Wake On Lan Magic Packet Sent/i.test(r.text)) action = 'wake';
        if (!action) {
          return { ok: false, kind: 'bad_format', message: 'Nie rozpoznano potwierdzenia wysłania pakietu.' };
        }
        return { ok: true, data: { action: action } };
      });
    });
  }

  function errorToPolish(result) {
    if (!result || result.ok) return '';
    switch (result.kind) {
      case 'timeout':
        return 'Serwer nie odpowiada (przekroczono czas oczekiwania).';
      case 'network':
        return 'Brak połączenia z serwerem. Jeśli serwer jest dostępny tylko przez VPN, upewnij się, że jesteś podłączony -- to najczęstsza przyczyna tego błędu.';
      case 'http_error':
        return 'Błąd serwera (' + result.status + '). Jeśli dotyczy to wybudzania, sprawdź, czy host jest dodany w panelu serwera.';
      case 'bad_format':
        return 'Serwer zwrócił odpowiedź w nieznanym formacie. Czy to na pewno gptwol i czy w wersji, z którą rozszerzenie było testowane?';
      case 'auth_required':
        return 'Serwer wymaga logowania, którego rozszerzenie jeszcze nie obsługuje. Skorzystaj z panelu serwera w przeglądarce.';
      case 'permission':
        return 'Rozszerzenie nie ma uprawnień do tego serwera. Otwórz Ustawienia, aby je przyznać.';
      case 'already_awake':
        return 'Host już działa, więc nic nie wysłano. Użyj "Uśpij", jeśli chcesz go wyłączyć.';
      case 'already_asleep':
        return 'Host nie odpowiada, więc uśpienie nie ma sensu. Użyj "Wybudź".';
      default:
        return 'Wystąpił nieoczekiwany błąd.';
    }
  }

  function originPatternFor(baseUrl) {
    try {
      var u = new URL(baseUrl);
      return u.protocol + '//' + u.host + '/*';
    } catch (e) {
      return null;
    }
  }

  return {
    buildUrl: buildUrl,
    request: request,
    parseComputers: parseComputers,
    getComputers: getComputers,
    checkStatus: checkStatus,
    sendPower: sendPower,
    errorToPolish: errorToPolish,
    originPatternFor: originPatternFor,
    normalizeBaseUrl: normalizeBaseUrl
  };
})();

if (typeof module !== 'undefined') {
  module.exports = WolApi;
}
