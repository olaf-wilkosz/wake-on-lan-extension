importScripts('shared/api.js');

var ALARM_NAME = 'defaultHostCheck';
var DEFAULT_SERVER_URL = '';
var DEFAULT_POLL_MINUTES = 5;
var HOSTS_MAX_AGE_MS = 60 * 60 * 1000; // lista hostów z serwera odświeżana najwyżej raz na godzinę przy sprawdzaniu w tle

var BADGE = {
  online: { text: '', color: '#2e7d32' },
  offline: { text: '', color: '#c62828' },
  unknown: { text: '?', color: '#9e9e9e' },
  error: { text: '!', color: '#e65100' }
};

var ICON_SIZES = [16, 32, 48, 128];
function iconPathsFor(variant) {
  var paths = {};
  ICON_SIZES.forEach(function (size) {
    paths[size] = 'icons/' + variant + '/icon' + size + '.png';
  });
  return paths;
}

// Źródłem prawdy o hostach jest serwer gptwol; lokalnie trzymamy tylko cache listy (storage.local)
// i wskazanie hosta domyślnego (storage.sync). Kluczem hosta jest jego MAC (unikalny na serwerze).
function getSyncSettings() {
  return chrome.storage.sync.get({
    serverUrl: DEFAULT_SERVER_URL,
    pollMinutes: DEFAULT_POLL_MINUTES,
    defaultHostId: null
  });
}

function getHostsCache() {
  return chrome.storage.local.get({ hostsCache: [], hostsCacheTime: 0 });
}

function getStatusCache() {
  return chrome.storage.local.get({ statusCache: {} }).then(function (r) { return r.statusCache; });
}

function setStatusFor(hostId, entry) {
  return getStatusCache().then(function (cache) {
    cache[hostId] = entry;
    return chrome.storage.local.set({ statusCache: cache });
  });
}

function hasPermissionFor(baseUrl) {
  var pattern = WolApi.originPatternFor(baseUrl);
  if (!pattern) return Promise.resolve(false);
  return chrome.permissions.contains({ origins: [pattern] });
}

function setBadge(state) {
  var b = BADGE[state] || BADGE.unknown;
  chrome.action.setBadgeText({ text: b.text });
  chrome.action.setBadgeBackgroundColor({ color: b.color });
  chrome.action.setIcon({ path: iconPathsFor(state) });
}

var ERROR_LOG_MAX = 50;

function logError(context, result) {
  // chrome://extensions -> Błędy pokazuje tylko spłaszczony string ("[object Object]" dla
  // obiektów) w tym jednolinijkowym podglądzie -- pełny obiekt jest widoczny dopiero po
  // otwarciu prawdziwego DevTools, więc dorzucamy JSON obok, żeby przyczyna była czytelna.
  var detail;
  try { detail = JSON.stringify(result); } catch (e) { detail = String(result); }
  console.error('[Wake on LAN] ' + context + ': ' + detail);

  var kind = (result && result.kind) || 'unknown';
  var raw = '';
  if (result) {
    if (result.status) raw = 'HTTP ' + result.status + (result.message ? ': ' + result.message : '');
    else if (result.message) raw = String(result.message);
  }
  appendErrorLog({
    ts: Date.now(),
    context: context,
    kind: kind,
    message: WolApi.errorToPolish({ ok: false, kind: kind, status: result && result.status, message: result && result.message }),
    raw: raw
  });
}

function appendErrorLog(entry) {
  chrome.storage.local.get({ errorLog: [] }).then(function (r) {
    var log = r.errorLog;
    log.unshift(entry);
    if (log.length > ERROR_LOG_MAX) log = log.slice(0, ERROR_LOG_MAX);
    chrome.storage.local.set({ errorLog: log });
  });
}

function findHost(hosts, hostId) {
  for (var i = 0; i < hosts.length; i++) {
    if (hosts[i].mac === hostId) return hosts[i];
  }
  return null;
}

// Host domyślny, a gdy nie ustawiono (albo zniknął z serwera) -- pierwszy z listy, tak samo jak w popupie.
function pickDefaultHost(hosts, defaultHostId) {
  return findHost(hosts, defaultHostId) || hosts[0] || null;
}

// Pobiera listę komputerów z serwera i odświeża cache. Zwraca { ok, hosts } lub { ok:false, message }.
function refreshHosts() {
  return getSyncSettings().then(function (settings) {
    if (!settings.serverUrl) {
      return { ok: false, message: 'Najpierw wpisz adres serwera w Ustawieniach.' };
    }
    return hasPermissionFor(settings.serverUrl).then(function (granted) {
      if (!granted) {
        logError('Pobieranie listy hostów: brak uprawnień do ' + settings.serverUrl, { kind: 'permission' });
        return { ok: false, message: WolApi.errorToPolish({ ok: false, kind: 'permission' }) };
      }
      return WolApi.getComputers(settings.serverUrl).then(function (result) {
        if (!result.ok) {
          logError('Pobieranie listy hostów', result);
          return { ok: false, message: WolApi.errorToPolish(result) };
        }
        return chrome.storage.local.set({
          hostsCache: result.data,
          hostsCacheTime: Date.now()
        }).then(function () {
          return { ok: true, hosts: result.data };
        });
      });
    });
  });
}

// Zwraca hosty z cache; gdy cache jest pusty (albo force/zbyt stary), próbuje pobrać z serwera.
function loadHosts(maxAgeMs) {
  return getHostsCache().then(function (c) {
    var fresh = c.hostsCache.length > 0 && (maxAgeMs === undefined || Date.now() - c.hostsCacheTime < maxAgeMs);
    if (fresh) return c.hostsCache;
    return refreshHosts().then(function (r) { return r.ok ? r.hosts : c.hostsCache; });
  });
}

function checkDefaultHostAndSetBadge() {
  return getSyncSettings().then(function (settings) {
    if (!settings.serverUrl) {
      setBadge('unknown');
      return { ok: false, kind: 'no_server' };
    }
    return loadHosts(HOSTS_MAX_AGE_MS).then(function (hosts) {
      var host = pickDefaultHost(hosts, settings.defaultHostId);
      if (!host) {
        setBadge('unknown');
        return { ok: false, kind: 'no_default' };
      }
      return hasPermissionFor(settings.serverUrl).then(function (granted) {
        if (!granted) {
          setBadge('error');
          logError('Sprawdzanie domyślnego hosta: brak uprawnień do ' + settings.serverUrl, { kind: 'permission' });
          return { ok: false, kind: 'permission' };
        }
        return WolApi.checkStatus(settings.serverUrl, host).then(function (result) {
          if (!result.ok) {
            setBadge('error');
            logError('Sprawdzanie hosta "' + host.name + '"', result);
            return setStatusFor(host.mac, {
              isUp: null,
              lastChecked: Date.now(),
              errorKind: result.kind,
              errorMessage: WolApi.errorToPolish(result)
            }).then(function () { return result; });
          }
          var isUp = !!result.data.isUp;
          setBadge(isUp ? 'online' : 'offline');
          return setStatusFor(host.mac, {
            isUp: isUp,
            lastChecked: Date.now(),
            errorKind: null
          }).then(function () { return { ok: true, isUp: isUp }; });
        });
      });
    });
  });
}

function checkHostById(hostId) {
  return getSyncSettings().then(function (settings) {
    return loadHosts().then(function (hosts) {
      var host = findHost(hosts, hostId);
      if (!host) return { ok: false, message: 'Nie znaleziono hosta na serwerze.' };
      return hasPermissionFor(settings.serverUrl).then(function (granted) {
        if (!granted) {
          logError('Sprawdzanie hosta "' + host.name + '": brak uprawnień do ' + settings.serverUrl, { kind: 'permission' });
          return { ok: false, message: WolApi.errorToPolish({ ok: false, kind: 'permission' }) };
        }
        return WolApi.checkStatus(settings.serverUrl, host).then(function (result) {
          if (!result.ok) {
            var msg = WolApi.errorToPolish(result);
            logError('Sprawdzanie hosta "' + host.name + '"', result);
            return setStatusFor(hostId, {
              isUp: null, lastChecked: Date.now(), errorKind: result.kind, errorMessage: msg
            }).then(function () { return { ok: false, message: msg }; });
          }
          var isUp = !!result.data.isUp;
          return setStatusFor(hostId, {
            isUp: isUp, lastChecked: Date.now(), errorKind: null
          }).then(function () {
            var def = pickDefaultHost(hosts, settings.defaultHostId);
            if (def && def.mac === hostId) setBadge(isUp ? 'online' : 'offline');
            return { ok: true, isUp: isUp };
          });
        });
      });
    });
  });
}

// intent: 'wake' | 'sleep'. Blokadę "host już działa / już nie działa" robi WolApi.sendPower
// (serwer ma tylko przełącznik, więc bez niej "Wybudź" na działającym komputerze by go wyłączyło).
function powerHostById(hostId, intent) {
  return getSyncSettings().then(function (settings) {
    return loadHosts().then(function (hosts) {
      var host = findHost(hosts, hostId);
      if (!host) return { ok: false, message: 'Nie znaleziono hosta na serwerze.' };
      var label = (intent === 'sleep' ? 'Uśpienie' : 'Wybudzanie') + ' hosta "' + host.name + '"';
      return hasPermissionFor(settings.serverUrl).then(function (granted) {
        if (!granted) {
          logError(label + ': brak uprawnień do ' + settings.serverUrl, { kind: 'permission' });
          return { ok: false, message: WolApi.errorToPolish({ ok: false, kind: 'permission' }) };
        }
        return WolApi.sendPower(settings.serverUrl, host, intent).then(function (result) {
          if (!result.ok) {
            // Odmowa z powodu stanu hosta to nie awaria -- nie śmiecimy logiem błędów.
            if (result.kind !== 'already_awake' && result.kind !== 'already_asleep') logError(label, result);
            return { ok: false, kind: result.kind, message: WolApi.errorToPolish(result) };
          }
          return { ok: true, action: result.data.action, intentMismatch: result.data.action !== intent, name: host.name };
        });
      });
    });
  });
}

function scheduleAlarm() {
  return getSyncSettings().then(function (settings) {
    var minutes = Math.max(1, Number(settings.pollMinutes) || DEFAULT_POLL_MINUTES);
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
  });
}

// Wersja pod wake-on-lan.php trzymała hosty lokalnie (storage.sync, klucze UUID). Teraz hosty
// pochodzą z serwera i są kluczowane MAC-iem, więc stare dane są bezużyteczne -- czyścimy je.
function migrateLegacyStorage() {
  return chrome.storage.sync.get({ hosts: null }).then(function (r) {
    if (!Array.isArray(r.hosts)) return;
    return chrome.storage.sync.remove(['hosts', 'defaultHostId']).then(function () {
      return chrome.storage.local.set({ statusCache: {} });
    });
  });
}

function startup() {
  return migrateLegacyStorage().then(scheduleAlarm).then(checkDefaultHostAndSetBadge);
}

chrome.runtime.onInstalled.addListener(function () { startup(); });
chrome.runtime.onStartup.addListener(function () { startup(); });

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === ALARM_NAME) {
    checkDefaultHostAndSetBadge();
  }
});

chrome.storage.onChanged.addListener(function (changes, areaName) {
  if (areaName !== 'sync') return;
  if (changes.pollMinutes) {
    scheduleAlarm();
  }
  if (changes.defaultHostId || changes.serverUrl) {
    checkDefaultHostAndSetBadge();
  }
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) return false;

  switch (message.type) {
    case 'REFRESH_HOSTS':
      refreshHosts().then(sendResponse);
      return true;
    case 'CHECK_HOST':
      checkHostById(message.hostId).then(sendResponse);
      return true;
    case 'POWER_HOST':
      powerHostById(message.hostId, message.intent).then(sendResponse);
      return true;
    case 'SET_DEFAULT':
      chrome.storage.sync.set({ defaultHostId: message.hostId }).then(function () {
        return checkDefaultHostAndSetBadge();
      }).then(function () {
        sendResponse({ ok: true });
      });
      return true;
    case 'SERVER_URL_CHANGED':
      // Cache hostów i statusów dotyczył poprzedniego serwera.
      chrome.storage.local.set({ statusCache: {}, hostsCache: [], hostsCacheTime: 0 }).then(function () {
        return checkDefaultHostAndSetBadge();
      }).then(function () {
        sendResponse({ ok: true });
      });
      return true;
    default:
      return false;
  }
});
