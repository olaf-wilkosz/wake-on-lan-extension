/* Wspólny klient API serwera wake-on-lan.php. Ładowany przez <script> w popup/options
   oraz przez importScripts() w background.js (service worker), stąd brak importów ES module. */

var WolApi = (function () {

  function normalizeBaseUrl(baseUrl) {
    var trimmed = (baseUrl || '').trim();
    if (!trimmed) return trimmed;
    return trimmed.endsWith('/') ? trimmed : trimmed + '/';
  }

  function buildUrl(baseUrl, aop, params) {
    var url = normalizeBaseUrl(baseUrl) + '?aop=' + encodeURIComponent(aop);
    params = params || {};
    Object.keys(params).forEach(function (key) {
      var value = params[key];
      if (value === undefined || value === null) return;
      url += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(String(value));
    });
    return url;
  }

  // Serwer nie wysyła nagłówków CORS (Access-Control-Allow-Origin itp.) i prawdopodobnie
  // nigdy nie wyśle -- to małe, mało aktywne hobbystyczne repo (patrz NOTES.md). Ten fetch()
  // i tak działa, bo `host_permissions` w manifest.json zwalnia konteksty rozszerzenia
  // (popup/options/service worker) z restrykcji CORS -- to udokumentowane zachowanie Chrome,
  // nie przypadek. Nie próbuj tego "naprawiać" trybem no-cors ani proxy.
  function request(baseUrl, aop, params, options) {
    options = options || {};
    var timeoutMs = options.timeoutMs || 8000;
    var url = buildUrl(baseUrl, aop, params);
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);

    return fetch(url, { method: 'GET', signal: controller.signal })
      .then(function (response) {
        return response.text().then(function (text) {
          if (!response.ok) {
            return { ok: false, kind: 'http_error', status: response.status, message: text };
          }
          try {
            var data = JSON.parse(text);
            return { ok: true, data: data };
          } catch (e) {
            return { ok: false, kind: 'bad_json', message: text };
          }
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

  function configGet(baseUrl) {
    return request(baseUrl, 'CONFIG.GET', {}, { timeoutMs: 8000 });
  }

  function hostCheck(baseUrl, host) {
    return request(baseUrl, 'HOST.CHECK', { host: host, debug: 0 }, { timeoutMs: 15000 });
  }

  function hostWakeup(baseUrl, host) {
    return request(baseUrl, 'HOST.WAKEUP', {
      mac: host.mac,
      host: host.host,
      cidr: host.cidr,
      port: host.port,
      comment: host.comment,
      debug: 0
    }, { timeoutMs: 8000 });
  }

  function errorToPolish(result) {
    if (!result || result.ok) return '';
    switch (result.kind) {
      case 'timeout':
        return 'Serwer nie odpowiada (przekroczono czas oczekiwania).';
      case 'network':
        return 'Brak połączenia z serwerem. Jeśli serwer jest dostępny tylko przez VPN, upewnij się, że jesteś podłączony -- to najczęstsza przyczyna tego błędu.';
      case 'http_error':
        var msg = (result.message || '').replace(/^Internal Server Error!\s*/i, '');
        return 'Błąd serwera (' + result.status + '): ' + (msg || 'nieznany błąd.');
      case 'bad_json':
        return 'Serwer zwrócił nieprawidłową odpowiedź.';
      case 'permission':
        return 'Rozszerzenie nie ma uprawnień do tego serwera. Otwórz Ustawienia, aby je przyznać.';
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
    configGet: configGet,
    hostCheck: hostCheck,
    hostWakeup: hostWakeup,
    errorToPolish: errorToPolish,
    originPatternFor: originPatternFor,
    normalizeBaseUrl: normalizeBaseUrl
  };
})();

if (typeof module !== 'undefined') {
  module.exports = WolApi;
}
