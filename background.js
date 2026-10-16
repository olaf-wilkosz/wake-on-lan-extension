importScripts('shared/api.js');

var ALARM_NAME = 'defaultHostCheck';
var DEFAULT_SERVER_URL = '';
var DEFAULT_POLL_MINUTES = 5;

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

function getSyncSettings() {
  return chrome.storage.sync.get({
    serverUrl: DEFAULT_SERVER_URL,
    pollMinutes: DEFAULT_POLL_MINUTES,
    defaultHostId: null,
    hosts: []
  });
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
  // otwarciu prawdziwego DevTools (przycisk "Wyświetl w Narzędziach deweloperskich"), więc
  // dorzucamy JSON obok, żeby przyczyna była czytelna nawet bez tego dodatkowego kroku.
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
    if (hosts[i].id === hostId) return hosts[i];
  }
  return null;
}

function checkDefaultHostAndSetBadge() {
  return getSyncSettings().then(function (settings) {
    var host = findHost(settings.hosts, settings.defaultHostId);
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
      return WolApi.hostCheck(settings.serverUrl, host.host).then(function (result) {
        if (!result.ok) {
          setBadge('error');
          logError('Sprawdzanie hosta "' + (host.comment || host.host) + '"', result);
          return setStatusFor(host.id, {
            isUp: null,
            info: null,
            lastChecked: Date.now(),
            errorKind: result.kind,
            errorMessage: WolApi.errorToPolish(result)
          }).then(function () { return result; });
        }
        var isUp = !!result.data.isUp;
        setBadge(isUp ? 'online' : 'offline');
        return setStatusFor(host.id, {
          isUp: isUp,
          info: result.data.info || null,
          lastChecked: Date.now(),
          errorKind: null
        }).then(function () { return { ok: true, isUp: isUp, info: result.data.info }; });
      });
    });
  });
}

function checkHostById(hostId) {
  return getSyncSettings().then(function (settings) {
    var host = findHost(settings.hosts, hostId);
    if (!host) return { ok: false, message: 'Nie znaleziono hosta.' };
    return hasPermissionFor(settings.serverUrl).then(function (granted) {
      if (!granted) {
        logError('Sprawdzanie hosta "' + (host.comment || host.host) + '": brak uprawnień do ' + settings.serverUrl, { kind: 'permission' });
        return { ok: false, message: WolApi.errorToPolish({ ok: false, kind: 'permission' }) };
      }
      return WolApi.hostCheck(settings.serverUrl, host.host).then(function (result) {
        if (!result.ok) {
          var msg = WolApi.errorToPolish(result);
          logError('Sprawdzanie hosta "' + (host.comment || host.host) + '"', result);
          return setStatusFor(hostId, {
            isUp: null, info: null, lastChecked: Date.now(), errorKind: result.kind, errorMessage: msg
          }).then(function () { return { ok: false, message: msg }; });
        }
        var isUp = !!result.data.isUp;
        return setStatusFor(hostId, {
          isUp: isUp, info: result.data.info || null, lastChecked: Date.now(), errorKind: null
        }).then(function () {
          if (hostId === settings.defaultHostId) setBadge(isUp ? 'online' : 'offline');
          return { ok: true, isUp: isUp, info: result.data.info };
        });
      });
    });
  });
}

function wakeHostById(hostId) {
  return getSyncSettings().then(function (settings) {
    var host = findHost(settings.hosts, hostId);
    if (!host) return { ok: false, message: 'Nie znaleziono hosta.' };
    return hasPermissionFor(settings.serverUrl).then(function (granted) {
      if (!granted) {
        logError('Wybudzanie hosta "' + (host.comment || host.host) + '": brak uprawnień do ' + settings.serverUrl, { kind: 'permission' });
        return { ok: false, message: WolApi.errorToPolish({ ok: false, kind: 'permission' }) };
      }
      return WolApi.hostWakeup(settings.serverUrl, host).then(function (result) {
        if (!result.ok) {
          logError('Wybudzanie hosta "' + (host.comment || host.host) + '"', result);
          return { ok: false, message: WolApi.errorToPolish(result) };
        }
        return { ok: true, message: (result.data && result.data.info) || 'Wysłano pakiet magic.' };
      });
    });
  });
}

function refreshConfig() {
  return getSyncSettings().then(function (settings) {
    return hasPermissionFor(settings.serverUrl).then(function (granted) {
      if (!granted) {
        logError('Import konfiguracji z serwera: brak uprawnień do ' + settings.serverUrl, { kind: 'permission' });
        return { ok: false, message: WolApi.errorToPolish({ ok: false, kind: 'permission' }) };
      }
      return WolApi.configGet(settings.serverUrl).then(function (result) {
        if (!result.ok) {
          logError('Import konfiguracji z serwera', result);
          return { ok: false, message: WolApi.errorToPolish(result) };
        }
        return chrome.storage.local.set({
          configCache: result.data,
          configCacheTime: Date.now()
        }).then(function () {
          return { ok: true, hosts: result.data };
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

chrome.runtime.onInstalled.addListener(function () {
  scheduleAlarm().then(checkDefaultHostAndSetBadge);
});

chrome.runtime.onStartup.addListener(function () {
  scheduleAlarm().then(checkDefaultHostAndSetBadge);
});

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
    case 'REFRESH_CONFIG':
      refreshConfig().then(sendResponse);
      return true;
    case 'CHECK_HOST':
      checkHostById(message.hostId).then(sendResponse);
      return true;
    case 'WAKE_HOST':
      wakeHostById(message.hostId).then(sendResponse);
      return true;
    case 'SET_DEFAULT':
      chrome.storage.sync.set({ defaultHostId: message.hostId }).then(function () {
        return checkDefaultHostAndSetBadge();
      }).then(function () {
        sendResponse({ ok: true });
      });
      return true;
    case 'SERVER_URL_CHANGED':
      chrome.storage.local.set({ statusCache: {} }).then(function () {
        return checkDefaultHostAndSetBadge();
      }).then(function () {
        sendResponse({ ok: true });
      });
      return true;
    default:
      return false;
  }
});
