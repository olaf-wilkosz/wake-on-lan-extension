(function () {
  var DEFAULT_SERVER_URL = '';

  var state = {
    settings: { serverUrl: DEFAULT_SERVER_URL, pollMinutes: 5, defaultHostId: null, hosts: [] },
    statusCache: {},
    othersExpanded: false,
    checkingIds: new Set(),
    editingId: null,
    pendingImport: null
  };

  var el = {
    popup: document.querySelector('.popup'),
    mainScreen: document.getElementById('mainScreen'),
    settingsScreen: document.getElementById('settingsScreen'),
    openSettings: document.getElementById('openSettings'),
    backToMain: document.getElementById('backToMain'),

    errorBanner: document.getElementById('errorBanner'),
    errorBannerText: document.getElementById('errorBannerText'),
    errorBannerClose: document.getElementById('errorBannerClose'),
    toast: document.getElementById('toast'),
    emptyState: document.getElementById('emptyState'),
    emptyStateOptions: document.getElementById('emptyStateOptions'),
    defaultHostSection: document.getElementById('defaultHostSection'),
    defaultHostName: document.getElementById('defaultHostName'),
    defaultStatusDot: document.getElementById('defaultStatusDot'),
    defaultStatusText: document.getElementById('defaultStatusText'),
    defaultLastChecked: document.getElementById('defaultLastChecked'),
    defaultErrorDetail: document.getElementById('defaultErrorDetail'),
    defaultWakeBtn: document.getElementById('defaultWakeBtn'),
    toggleOthers: document.getElementById('toggleOthers'),
    otherHostsList: document.getElementById('otherHostsList'),

    settingsBanner: document.getElementById('settingsBanner'),
    serverUrl: document.getElementById('serverUrl'),
    saveServerUrl: document.getElementById('saveServerUrl'),
    pollMinutes: document.getElementById('pollMinutes'),
    savePollMinutes: document.getElementById('savePollMinutes'),
    importFromServer: document.getElementById('importFromServer'),
    importPanel: document.getElementById('importPanel'),
    importSummary: document.getElementById('importSummary'),
    importConfirm: document.getElementById('importConfirm'),
    importCancel: document.getElementById('importCancel'),
    settingsHostsList: document.getElementById('settingsHostsList'),
    noHostsMsg: document.getElementById('noHostsMsg'),
    addHostToggle: document.getElementById('addHostToggle'),
    hostForm: document.getElementById('hostForm'),
    hostId: document.getElementById('hostId'),
    mac: document.getElementById('mac'),
    host: document.getElementById('host'),
    cidr: document.getElementById('cidr'),
    port: document.getElementById('port'),
    comment: document.getElementById('comment'),
    formSubmit: document.getElementById('formSubmit'),
    formCancel: document.getElementById('formCancel'),
    formError: document.getElementById('formError'),
    errorLogList: document.getElementById('errorLogList'),
    noErrorLogMsg: document.getElementById('noErrorLogMsg'),
    clearErrorLog: document.getElementById('clearErrorLog')
  };

  // ---------- shared helpers ----------

  function showError(message) {
    el.errorBannerText.textContent = message;
    el.errorBanner.hidden = false;
  }

  function hideError() {
    el.errorBanner.hidden = true;
  }

  function showToast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    setTimeout(function () { el.toast.hidden = true; }, 6000);
  }

  function showSettingsBanner(message, isError) {
    el.settingsBanner.textContent = message;
    el.settingsBanner.className = 'banner ' + (isError ? 'banner-error' : 'banner-success');
    el.settingsBanner.hidden = false;
    setTimeout(function () { el.settingsBanner.hidden = true; }, 6000);
  }

  function displayName(host) {
    return host.comment && host.comment.trim() ? host.comment : host.host;
  }

  function sortKey(host) {
    return displayName(host).toLocaleLowerCase();
  }

  function loadState() {
    return Promise.all([
      chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER_URL, pollMinutes: 5, defaultHostId: null, hosts: [] }),
      chrome.storage.local.get({ statusCache: {} })
    ]).then(function (results) {
      state.settings = results[0];
      state.statusCache = results[1].statusCache;
    });
  }

  function saveHosts() {
    return chrome.storage.sync.set({ hosts: state.settings.hosts, defaultHostId: state.settings.defaultHostId });
  }

  function refreshAll() {
    return loadState().then(function () {
      renderMain();
      renderSettings();
    });
  }

  // ---------- view switching ----------

  // Popupy rozszerzeń same dopasowują rozmiar natywnego okna do wysokości dokumentu, ale
  // robią to skokowo. Żeby to wyglądało jak płynne rozrastanie, blokujemy .popup na
  // aktualnej wysokości w pikselach, podmieniamy zawartość, a potem animujemy do nowej
  // wysokości -- Chrome śledzi zmianę i skaluje okno razem z animacją.
  function animateScreenSwitch(switchFn) {
    var startHeight = el.popup.offsetHeight;
    switchFn();
    // Zmierz naturalną wysokość NOWEJ zawartości, zanim cokolwiek zablokujemy -- inaczej
    // przy kurczeniu się (Ustawienia -> główny widok) scrollHeight po prostu zwracałby
    // wciąż obowiązującą, za dużą wysokość sprzed przełączenia (nie ma czego przelewać).
    el.popup.style.height = 'auto';
    var endHeight = el.popup.scrollHeight;
    // Z powrotem zablokuj na wysokości startowej, zanim przeglądarka zdąży to narysować,
    // żeby animacja miała od czego wystartować.
    el.popup.style.height = startHeight + 'px';
    void el.popup.offsetHeight; // wymuszenie reflow, żeby zarejestrować punkt startowy
    requestAnimationFrame(function () {
      el.popup.style.height = endHeight + 'px';
    });
    el.popup.addEventListener('transitionend', function handler(e) {
      if (e.propertyName !== 'height') return;
      el.popup.style.height = 'auto';
      el.popup.removeEventListener('transitionend', handler);
    });
  }

  function showSettingsScreen() {
    animateScreenSwitch(function () {
      el.mainScreen.hidden = true;
      el.settingsScreen.hidden = false;
    });
  }

  function showMainScreen() {
    animateScreenSwitch(function () {
      el.settingsScreen.hidden = true;
      el.mainScreen.hidden = false;
    });
  }

  // ---------- main screen ----------

  function formatLastChecked(ts) {
    if (!ts) return '';
    var diffSec = Math.round((Date.now() - ts) / 1000);
    if (diffSec < 60) return 'sprawdzono przed chwilą';
    var diffMin = Math.round(diffSec / 60);
    if (diffMin < 60) return 'sprawdzono ' + diffMin + ' min temu';
    var diffH = Math.round(diffMin / 60);
    return 'sprawdzono ' + diffH + ' godz. temu';
  }

  function statusClass(entry, checking) {
    if (checking) return 'status-checking';
    if (!entry || entry.isUp === null || entry.isUp === undefined) {
      return entry && entry.errorKind ? 'status-error' : 'status-unknown';
    }
    return entry.isUp ? 'status-online' : 'status-offline';
  }

  function statusLabel(entry, checking) {
    if (checking) return 'Sprawdzanie...';
    if (!entry || entry.isUp === null || entry.isUp === undefined) {
      return entry && entry.errorKind ? 'Błąd sprawdzania' : 'Nieznany';
    }
    return entry.isUp ? 'Online' : 'Offline';
  }

  function barsSvg(cls, activeCount) {
    var heights = [5, 8, 11, 14];
    var xs = [0, 4, 8, 12];
    var bars = heights.map(function (h, i) {
      var dim = i >= activeCount ? ' bar-dim' : '';
      return '<rect class="bar' + dim + '" x="' + xs[i] + '" y="' + (15 - h) + '" width="2.6" height="' + h + '" rx="1"/>';
    }).join('');
    return '<svg class="' + cls + '" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' + bars + '</svg>';
  }

  function statusIndicatorHtml(entry, checking) {
    if (!checking && entry && (entry.isUp === true || entry.isUp === false)) {
      return entry.isUp ? barsSvg('bars-online', 4) : barsSvg('bars-offline', 1);
    }
    return '<span class="status-dot ' + statusClass(entry, checking) + '"></span>';
  }

  function renderMain() {
    var hosts = state.settings.hosts || [];

    if (hosts.length === 0) {
      el.emptyState.hidden = false;
      el.defaultHostSection.hidden = true;
      el.toggleOthers.hidden = true;
      el.otherHostsList.hidden = true;
      return;
    }
    el.emptyState.hidden = true;

    var defaultHost = null;
    var others = [];
    hosts.forEach(function (h) {
      if (h.id === state.settings.defaultHostId) defaultHost = h;
      else others.push(h);
    });
    if (!defaultHost) {
      defaultHost = hosts[0];
      others = hosts.slice(1);
    }
    others.sort(function (a, b) { return sortKey(a).localeCompare(sortKey(b)); });

    renderDefaultHost(defaultHost);
    renderOthers(others);
  }

  function renderDefaultHost(host) {
    el.defaultHostSection.hidden = false;
    el.defaultHostName.textContent = displayName(host);
    var entry = state.statusCache[host.id];
    var checking = state.checkingIds.has(host.id);
    el.defaultStatusDot.innerHTML = statusIndicatorHtml(entry, checking);
    el.defaultStatusText.textContent = statusLabel(entry, checking);
    el.defaultLastChecked.textContent = entry && entry.lastChecked ? formatLastChecked(entry.lastChecked) : '';

    if (!checking && entry && entry.errorKind && entry.errorMessage) {
      el.defaultErrorDetail.textContent = entry.errorMessage;
      el.defaultErrorDetail.hidden = false;
    } else {
      el.defaultErrorDetail.hidden = true;
    }

    el.defaultWakeBtn.onclick = function () { wakeHost(host, el.defaultWakeBtn); };

    var staleMs = Math.max(1, state.settings.pollMinutes) * 60 * 1000;
    var isStale = !entry || !entry.lastChecked || (Date.now() - entry.lastChecked) > staleMs;
    if (isStale && !checking) {
      state.checkingIds.add(host.id);
      el.defaultStatusDot.innerHTML = statusIndicatorHtml(null, true);
      el.defaultStatusText.textContent = 'Sprawdzanie...';
      chrome.runtime.sendMessage({ type: 'CHECK_HOST', hostId: host.id }, function () {
        state.checkingIds.delete(host.id);
        loadState().then(renderMain);
      });
    }
  }

  function renderOthers(others) {
    if (others.length === 0) {
      el.toggleOthers.hidden = true;
      el.otherHostsList.hidden = true;
      return;
    }
    el.toggleOthers.hidden = false;
    el.toggleOthers.textContent = (state.othersExpanded ? 'Ukryj pozostałe hosty (' : 'Pokaż pozostałe hosty (') +
      others.length + ')';
    el.otherHostsList.hidden = !state.othersExpanded;

    el.otherHostsList.innerHTML = '';
    others.forEach(function (host) {
      var li = document.createElement('li');
      li.className = 'other-host-row';

      var info = document.createElement('div');
      info.className = 'other-host-info';

      var name = document.createElement('div');
      name.className = 'other-host-name';
      name.textContent = displayName(host);
      info.appendChild(name);

      var statusRow = document.createElement('div');
      statusRow.className = 'other-host-status';
      var indicator = document.createElement('span');
      indicator.className = 'status-indicator';
      indicator.innerHTML = statusIndicatorHtml(state.statusCache[host.id], state.checkingIds.has(host.id));
      var text = document.createElement('span');
      text.textContent = statusLabel(state.statusCache[host.id], state.checkingIds.has(host.id));
      var otherEntry = state.statusCache[host.id];
      if (otherEntry && otherEntry.errorKind && otherEntry.errorMessage) {
        text.title = otherEntry.errorMessage;
      }
      statusRow.appendChild(indicator);
      statusRow.appendChild(text);
      info.appendChild(statusRow);

      info.addEventListener('click', function () {
        if (state.checkingIds.has(host.id)) return;
        state.checkingIds.add(host.id);
        renderOthers(others);
        chrome.runtime.sendMessage({ type: 'CHECK_HOST', hostId: host.id }, function () {
          state.checkingIds.delete(host.id);
          loadState().then(renderMain);
        });
      });

      var starBtn = document.createElement('button');
      starBtn.className = 'set-default-btn';
      starBtn.title = 'Ustaw jako domyślny';
      starBtn.textContent = '☆';
      starBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        starBtn.disabled = true;
        chrome.runtime.sendMessage({ type: 'SET_DEFAULT', hostId: host.id }, function () {
          state.othersExpanded = true;
          refreshAll();
        });
      });

      var wakeBtn = document.createElement('button');
      wakeBtn.className = 'btn btn-wake-small';
      wakeBtn.textContent = 'Wybudź';
      wakeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        wakeHost(host, wakeBtn);
      });

      li.appendChild(info);
      li.appendChild(starBtn);
      li.appendChild(wakeBtn);
      el.otherHostsList.appendChild(li);
    });
  }

  function wakeHost(host, button) {
    hideError();
    button.disabled = true;
    var originalText = button.textContent;
    button.textContent = '...';

    // Sprawdzanie/wysyłanie może potrwać kilka sekund (patrz shared/api.js timeouty) --
    // pokazujemy stan "w toku" natychmiast i bez auto-ukrywania (showToast ukrywa po 6s,
    // co mogłoby zniknąć zanim przyjdzie odpowiedź i wyglądać jakby nic się nie stało).
    el.toast.textContent = 'Wysyłanie pakietu magic do: ' + displayName(host) + '...';
    el.toast.hidden = false;

    var settled = false;
    var safetyTimer = setTimeout(function () {
      if (settled) return;
      settled = true;
      button.disabled = false;
      button.textContent = originalText;
      el.toast.hidden = true;
      showError('Brak odpowiedzi od rozszerzenia (przekroczono czas oczekiwania). Spróbuj ponownie.');
    }, 12000);

    chrome.runtime.sendMessage({ type: 'WAKE_HOST', hostId: host.id }, function (response) {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      button.disabled = false;
      button.textContent = originalText;
      el.toast.hidden = true;
      if (!response || !response.ok) {
        showError((response && response.message) || 'Nie udało się wysłać pakietu.');
        return;
      }
      showToast('Wysłano pakiet magic do: ' + displayName(host));
    });
  }

  // ---------- settings screen ----------

  var MAC_RE = /^([0-9A-Fa-f]{2})[:-]?([0-9A-Fa-f]{2})[:-]?([0-9A-Fa-f]{2})[:-]?([0-9A-Fa-f]{2})[:-]?([0-9A-Fa-f]{2})[:-]?([0-9A-Fa-f]{2})$/;
  var HOSTNAME_OR_IP_RE = /^(([0-9]{1,3}\.){3}[0-9]{1,3}|[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)$/;

  function normalizeMac(raw) {
    var m = raw.trim().match(MAC_RE);
    if (!m) return null;
    return [m[1], m[2], m[3], m[4], m[5], m[6]].join(':').toUpperCase();
  }

  function validateHostField(raw) {
    var v = raw.trim();
    if (!v) return null;
    if (!HOSTNAME_OR_IP_RE.test(v)) return null;
    var octets = v.split('.');
    if (octets.length === 4 && octets.every(function (o) { return /^\d+$/.test(o); })) {
      if (!octets.every(function (o) { return Number(o) >= 0 && Number(o) <= 255; })) return null;
    }
    return v;
  }

  function renderSettings() {
    if (document.activeElement !== el.serverUrl) el.serverUrl.value = state.settings.serverUrl;
    if (document.activeElement !== el.pollMinutes) el.pollMinutes.value = state.settings.pollMinutes;
    renderSettingsHostsList();
    loadAndRenderErrorLog();
  }

  function errorKindLabel(kind) {
    switch (kind) {
      case 'network': return 'NETWORK_ERROR';
      case 'timeout': return 'TIMEOUT';
      case 'http_error': return 'HTTP_ERROR';
      case 'bad_json': return 'BAD_JSON';
      case 'permission': return 'PERMISSION';
      default: return 'ERROR';
    }
  }

  function formatLogTimestamp(ts) {
    var d = new Date(ts);
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ', ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function loadAndRenderErrorLog() {
    chrome.storage.local.get({ errorLog: [] }).then(function (r) {
      renderErrorLog(r.errorLog);
    });
  }

  function renderErrorLog(log) {
    el.noErrorLogMsg.hidden = log.length > 0;
    el.errorLogList.innerHTML = '';
    log.forEach(function (entry) {
      var li = document.createElement('li');
      li.className = 'error-log-entry';

      var head = document.createElement('div');
      head.className = 'error-log-head';
      var time = document.createElement('span');
      time.className = 'error-log-time';
      time.textContent = formatLogTimestamp(entry.ts);
      var kind = document.createElement('span');
      kind.className = 'error-log-kind';
      kind.textContent = errorKindLabel(entry.kind);
      head.appendChild(time);
      head.appendChild(kind);
      li.appendChild(head);

      if (entry.context) {
        var ctx = document.createElement('div');
        ctx.className = 'error-log-context';
        ctx.textContent = entry.context;
        li.appendChild(ctx);
      }

      var msg = document.createElement('div');
      msg.className = 'error-log-message';
      msg.textContent = entry.message;
      li.appendChild(msg);

      if (entry.raw) {
        var raw = document.createElement('div');
        raw.className = 'error-log-raw';
        raw.textContent = 'Szczegóły: ' + entry.raw;
        li.appendChild(raw);
      }

      el.errorLogList.appendChild(li);
    });
  }

  function renderSettingsHostsList() {
    var hosts = state.settings.hosts || [];
    el.noHostsMsg.hidden = hosts.length > 0;
    el.settingsHostsList.innerHTML = '';

    hosts.slice().sort(function (a, b) { return sortKey(a).localeCompare(sortKey(b)); }).forEach(function (host) {
      var li = document.createElement('li');
      li.className = 'settings-host-row';

      var info = document.createElement('div');
      info.className = 'settings-host-info';
      var name = document.createElement('div');
      name.className = 'settings-host-name';
      name.textContent = displayName(host);
      var sub = document.createElement('div');
      sub.className = 'settings-host-sub';
      sub.textContent = host.mac + ' · ' + host.host;
      info.appendChild(name);
      info.appendChild(sub);

      var isDefault = host.id === state.settings.defaultHostId;
      var starBtn = document.createElement('button');
      starBtn.className = 'set-default-btn' + (isDefault ? ' is-default' : '');
      if (isDefault) starBtn.style.color = 'var(--star)';
      starBtn.title = 'Ustaw jako domyślny';
      starBtn.textContent = isDefault ? '★' : '☆';
      starBtn.addEventListener('click', function () {
        state.settings.defaultHostId = host.id;
        saveHosts().then(function () {
          chrome.runtime.sendMessage({ type: 'SET_DEFAULT', hostId: host.id });
          refreshAll();
          showSettingsBanner('Ustawiono jako domyślny: ' + displayName(host), false);
        });
      });

      var editBtn = document.createElement('button');
      editBtn.className = 'btn btn-secondary';
      editBtn.textContent = 'Edytuj';
      editBtn.addEventListener('click', function () { startEditHost(host); });

      var delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger';
      delBtn.textContent = 'Usuń';
      delBtn.addEventListener('click', function () { deleteHost(host.id); });

      li.appendChild(info);
      li.appendChild(starBtn);
      li.appendChild(editBtn);
      li.appendChild(delBtn);
      el.settingsHostsList.appendChild(li);
    });
  }

  function startEditHost(host) {
    state.editingId = host.id;
    el.hostId.value = host.id;
    el.mac.value = host.mac;
    el.host.value = host.host;
    el.cidr.value = host.cidr;
    el.port.value = host.port;
    el.comment.value = host.comment;
    el.formSubmit.textContent = 'Zapisz zmiany';
    el.formError.hidden = true;
    el.hostForm.hidden = false;
    el.mac.focus();
  }

  function resetHostForm() {
    state.editingId = null;
    el.hostForm.reset();
    el.hostId.value = '';
    el.cidr.value = 24;
    el.port.value = 9;
    el.formSubmit.textContent = 'Dodaj hosta';
    el.formError.hidden = true;
    el.hostForm.hidden = true;
  }

  function deleteHost(id) {
    state.settings.hosts = state.settings.hosts.filter(function (h) { return h.id !== id; });
    if (state.settings.defaultHostId === id) {
      state.settings.defaultHostId = state.settings.hosts.length > 0 ? state.settings.hosts[0].id : null;
    }
    saveHosts().then(function () {
      refreshAll();
      if (state.editingId === id) resetHostForm();
    });
  }

  function handleHostFormSubmit(e) {
    e.preventDefault();
    el.formError.hidden = true;

    var mac = normalizeMac(el.mac.value);
    if (!mac) {
      el.formError.textContent = 'Nieprawidłowy adres MAC (oczekiwano formatu AA:BB:CC:DD:EE:FF).';
      el.formError.hidden = false;
      return;
    }
    var host = validateHostField(el.host.value);
    if (!host) {
      el.formError.textContent = 'Nieprawidłowy adres IP lub nazwa hosta.';
      el.formError.hidden = false;
      return;
    }
    var cidr = Number(el.cidr.value);
    if (!Number.isInteger(cidr) || cidr < 0 || cidr > 32) {
      el.formError.textContent = 'CIDR musi być liczbą całkowitą od 0 do 32.';
      el.formError.hidden = false;
      return;
    }
    var port = Number(el.port.value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      el.formError.textContent = 'Port musi być liczbą całkowitą od 1 do 65535.';
      el.formError.hidden = false;
      return;
    }
    var comment = el.comment.value.trim();
    if (!comment) {
      el.formError.textContent = 'Komentarz jest wymagany.';
      el.formError.hidden = false;
      return;
    }

    if (state.editingId) {
      var existing = state.settings.hosts.find(function (h) { return h.id === state.editingId; });
      existing.mac = mac; existing.host = host; existing.cidr = cidr; existing.port = port; existing.comment = comment;
    } else {
      var newHost = { id: crypto.randomUUID(), mac: mac, host: host, cidr: cidr, port: port, comment: comment };
      state.settings.hosts.push(newHost);
      if (!state.settings.defaultHostId) state.settings.defaultHostId = newHost.id;
    }

    saveHosts().then(function () {
      refreshAll();
      resetHostForm();
      showSettingsBanner('Zapisano hosta.', false);
    });
  }

  function handleSaveServerUrl() {
    var raw = el.serverUrl.value.trim();
    if (!raw) {
      showSettingsBanner('Podaj adres serwera.', true);
      return;
    }
    var normalized = WolApi.normalizeBaseUrl(raw);
    var pattern = WolApi.originPatternFor(normalized);
    if (!pattern) {
      showSettingsBanner('Nieprawidłowy adres URL.', true);
      return;
    }

    chrome.permissions.contains({ origins: [pattern] }).then(function (granted) {
      if (granted) {
        state.settings.serverUrl = normalized;
        return chrome.storage.sync.set({ serverUrl: normalized }).then(function () {
          chrome.runtime.sendMessage({ type: 'SERVER_URL_CHANGED' });
          showSettingsBanner('Zapisano adres serwera.', false);
        });
      }
      // chrome.permissions.request() otwiera natywne okno zgody, które kradnie fokus --
      // wywołane bezpośrednio z tego popupu powoduje jego natychmiastowe zamknięcie
      // (popupy rozszerzeń zamykają się przy utracie fokusu), przez co cała operacja
      // nigdy się nie kończy. Dlatego dla NOWEGO originu otwieramy stabilną kartę, która
      // się nie zamyka -- tam dopiero prosimy o zgodę i zapisujemy.
      showSettingsBanner('Otwieram kartę, żeby przyznać dostęp do nowego adresu...', false);
      chrome.tabs.create({
        url: chrome.runtime.getURL('grant-permission.html') +
          '?origin=' + encodeURIComponent(pattern) +
          '&serverUrl=' + encodeURIComponent(normalized)
      });
    });
  }

  function handleSavePollMinutes() {
    var minutes = Number(el.pollMinutes.value);
    if (!Number.isInteger(minutes) || minutes < 1) {
      showSettingsBanner('Interwał musi być liczbą całkowitą >= 1.', true);
      return;
    }
    chrome.storage.sync.set({ pollMinutes: minutes }).then(function () {
      showSettingsBanner('Zapisano interwał odpytywania.', false);
    });
  }

  function handleImportFromServer() {
    el.importFromServer.disabled = true;
    chrome.runtime.sendMessage({ type: 'REFRESH_CONFIG' }, function (response) {
      el.importFromServer.disabled = false;
      if (!response || !response.ok) {
        showSettingsBanner((response && response.message) || 'Nie udało się pobrać konfiguracji.', true);
        return;
      }
      var serverHosts = response.hosts || [];
      var added = [];
      var updated = [];
      serverHosts.forEach(function (sh) {
        var existing = state.settings.hosts.find(function (h) { return h.mac.toUpperCase() === (sh.mac || '').toUpperCase(); });
        if (existing) {
          updated.push({ existing: existing, incoming: sh });
        } else {
          added.push(sh);
        }
      });

      if (added.length === 0 && updated.length === 0) {
        showSettingsBanner('Brak zmian do zaimportowania.', false);
        return;
      }

      state.pendingImport = { added: added, updated: updated };
      el.importSummary.innerHTML = '';
      added.forEach(function (h) {
        var div = document.createElement('div');
        div.className = 'import-item added';
        div.textContent = '+ Nowy: ' + (h.comment || h.host) + ' (' + h.mac + ')';
        el.importSummary.appendChild(div);
      });
      updated.forEach(function (u) {
        var div = document.createElement('div');
        div.className = 'import-item updated';
        div.textContent = '~ Aktualizacja: ' + (u.existing.comment || u.existing.host) + ' (' + u.existing.mac + ')';
        el.importSummary.appendChild(div);
      });
      el.importPanel.hidden = false;
    });
  }

  function confirmImport() {
    var pending = state.pendingImport;
    if (!pending) return;
    pending.added.forEach(function (sh) {
      state.settings.hosts.push({
        id: crypto.randomUUID(),
        mac: normalizeMac(sh.mac) || sh.mac,
        host: sh.host,
        cidr: Number(sh.cidr) || 24,
        port: Number(sh.port) || 9,
        comment: sh.comment || sh.host
      });
    });
    pending.updated.forEach(function (u) {
      u.existing.host = u.incoming.host;
      u.existing.cidr = Number(u.incoming.cidr) || u.existing.cidr;
      u.existing.port = Number(u.incoming.port) || u.existing.port;
      u.existing.comment = u.incoming.comment || u.existing.comment;
    });
    if (!state.settings.defaultHostId && state.settings.hosts.length > 0) {
      state.settings.defaultHostId = state.settings.hosts[0].id;
    }
    state.pendingImport = null;
    el.importPanel.hidden = true;
    saveHosts().then(function () {
      refreshAll();
      showSettingsBanner('Zaimportowano konfigurację.', false);
    });
  }

  // ---------- event wiring ----------

  el.errorBannerClose.addEventListener('click', hideError);
  el.openSettings.addEventListener('click', showSettingsScreen);
  el.emptyStateOptions.addEventListener('click', showSettingsScreen);
  el.backToMain.addEventListener('click', showMainScreen);

  el.toggleOthers.addEventListener('click', function () {
    state.othersExpanded = !state.othersExpanded;
    renderMain();
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.num-stepper-btn') : null;
    if (!btn) return;
    var input = document.getElementById(btn.getAttribute('data-target'));
    if (!input) return;
    var step = Number(input.step) || 1;
    var dir = Number(btn.getAttribute('data-dir')) || 1;
    var current = Number(input.value);
    if (!Number.isFinite(current)) current = Number(input.min) || 0;
    var next = current + dir * step;
    if (input.min !== '' && next < Number(input.min)) next = Number(input.min);
    if (input.max !== '' && next > Number(input.max)) next = Number(input.max);
    input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  el.saveServerUrl.addEventListener('click', handleSaveServerUrl);
  el.savePollMinutes.addEventListener('click', handleSavePollMinutes);
  el.importFromServer.addEventListener('click', handleImportFromServer);
  el.importConfirm.addEventListener('click', confirmImport);
  el.importCancel.addEventListener('click', function () {
    state.pendingImport = null;
    el.importPanel.hidden = true;
  });

  el.addHostToggle.addEventListener('click', function () {
    if (el.hostForm.hidden) {
      resetHostForm();
      el.hostForm.hidden = false;
      el.mac.focus();
    } else {
      resetHostForm();
    }
  });
  el.hostForm.addEventListener('submit', handleHostFormSubmit);
  el.formCancel.addEventListener('click', resetHostForm);
  el.clearErrorLog.addEventListener('click', function () {
    chrome.storage.local.set({ errorLog: [] }).then(loadAndRenderErrorLog);
  });

  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName === 'sync' || areaName === 'local') {
      refreshAll();
    }
  });

  refreshAll();
})();
