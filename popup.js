(function () {
  var DEFAULT_SERVER_URL = '';

  // Hosty pochodzą z serwera gptwol (cache w storage.local); lokalnie trzymamy tylko adres serwera,
  // interwał i wybór hosta domyślnego. Kluczem hosta jest jego MAC.
  var state = {
    settings: { serverUrl: DEFAULT_SERVER_URL, pollMinutes: 5, defaultHostId: null },
    hosts: [],
    statusCache: {},
    othersExpanded: false,
    checkingIds: new Set(),
    busyIds: new Set(),
    confirmSleepId: null,
    confirmTimer: null
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
    emptyStateText: document.getElementById('emptyStateText'),
    emptyStateOptions: document.getElementById('emptyStateOptions'),
    defaultHostSection: document.getElementById('defaultHostSection'),
    defaultHostName: document.getElementById('defaultHostName'),
    defaultStatusDot: document.getElementById('defaultStatusDot'),
    defaultStatusText: document.getElementById('defaultStatusText'),
    defaultLastChecked: document.getElementById('defaultLastChecked'),
    defaultErrorDetail: document.getElementById('defaultErrorDetail'),
    defaultWakeBtn: document.getElementById('defaultWakeBtn'),
    defaultConfirm: document.getElementById('defaultConfirm'),
    defaultConfirmText: document.getElementById('defaultConfirmText'),
    defaultConfirmYes: document.getElementById('defaultConfirmYes'),
    defaultConfirmNo: document.getElementById('defaultConfirmNo'),
    toggleOthers: document.getElementById('toggleOthers'),
    otherHostsList: document.getElementById('otherHostsList'),

    settingsBanner: document.getElementById('settingsBanner'),
    serverUrl: document.getElementById('serverUrl'),
    saveServerUrl: document.getElementById('saveServerUrl'),
    pollMinutes: document.getElementById('pollMinutes'),
    savePollMinutes: document.getElementById('savePollMinutes'),
    refreshHosts: document.getElementById('refreshHosts'),
    openPanel: document.getElementById('openPanel'),
    settingsHostsList: document.getElementById('settingsHostsList'),
    noHostsMsg: document.getElementById('noHostsMsg'),
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
    return host.name && host.name.trim() ? host.name : host.ip;
  }

  function sortKey(host) {
    return displayName(host).toLocaleLowerCase();
  }

  function testLabel(testType) {
    if (testType === 'icmp') return 'ICMP';
    if (testType === 'arp') return 'ARP';
    return 'TCP ' + testType;
  }

  function loadState() {
    return Promise.all([
      chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER_URL, pollMinutes: 5, defaultHostId: null }),
      chrome.storage.local.get({ hostsCache: [], statusCache: {} })
    ]).then(function (results) {
      state.settings = results[0];
      state.hosts = results[1].hostsCache;
      state.statusCache = results[1].statusCache;
    });
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

  // Serwer gptwol ma tylko PRZEŁĄCZNIK wake/sleep, więc to, co przycisk robi, wynika ze statusu
  // hosta: działa -> "Uśpij" (z potwierdzeniem), w pozostałych przypadkach -> "Wybudź".
  // Blokadę przed odwrotnym skutkiem stosuje jeszcze background (WolApi.sendPower).
  function isAwake(entry) {
    return !!(entry && entry.isUp === true);
  }

  function armSleepConfirm(mac) {
    state.confirmSleepId = mac;
    clearTimeout(state.confirmTimer);
    state.confirmTimer = setTimeout(function () {
      state.confirmSleepId = null;
      renderMain();
    }, 6000);
  }

  function clearSleepConfirm() {
    state.confirmSleepId = null;
    clearTimeout(state.confirmTimer);
  }

  function pickDefault(hosts) {
    for (var i = 0; i < hosts.length; i++) {
      if (hosts[i].mac === state.settings.defaultHostId) return hosts[i];
    }
    return hosts[0] || null;
  }

  function renderMain() {
    var hosts = state.hosts || [];

    if (hosts.length === 0) {
      el.emptyStateText.textContent = state.settings.serverUrl
        ? 'Brak hostów na serwerze. Dodaj je w panelu serwera i odśwież listę w Ustawieniach.'
        : 'Brak hostów. Wpisz adres serwera w Ustawieniach.';
      el.emptyState.hidden = false;
      el.defaultHostSection.hidden = true;
      el.toggleOthers.hidden = true;
      el.otherHostsList.hidden = true;
      return;
    }
    el.emptyState.hidden = true;

    var defaultHost = pickDefault(hosts);
    var others = hosts.filter(function (h) { return h.mac !== defaultHost.mac; });
    others.sort(function (a, b) { return sortKey(a).localeCompare(sortKey(b)); });

    renderDefaultHost(defaultHost);
    renderOthers(others);
  }

  function renderDefaultHost(host) {
    el.defaultHostSection.hidden = false;
    el.defaultHostName.textContent = displayName(host);
    var entry = state.statusCache[host.mac];
    var checking = state.checkingIds.has(host.mac);
    var busy = state.busyIds.has(host.mac);
    var awake = isAwake(entry);
    var confirming = awake && state.confirmSleepId === host.mac;

    el.defaultStatusDot.innerHTML = statusIndicatorHtml(entry, checking);
    el.defaultStatusText.textContent = statusLabel(entry, checking);
    el.defaultLastChecked.textContent = entry && entry.lastChecked ? formatLastChecked(entry.lastChecked) : '';

    if (!checking && entry && entry.errorKind && entry.errorMessage) {
      el.defaultErrorDetail.textContent = entry.errorMessage;
      el.defaultErrorDetail.hidden = false;
    } else {
      el.defaultErrorDetail.hidden = true;
    }

    el.defaultWakeBtn.className = 'btn ' + (awake ? 'btn-sleep-big' : 'btn-wake-big');
    el.defaultWakeBtn.textContent = busy ? '...' : (awake ? 'Uśpij' : 'Wybudź');
    el.defaultWakeBtn.disabled = busy;
    el.defaultWakeBtn.hidden = confirming;
    el.defaultConfirm.hidden = !confirming;
    el.defaultConfirmText.textContent = 'Uśpić „' + displayName(host) + '”?';

    el.defaultWakeBtn.onclick = function () {
      if (awake) {
        armSleepConfirm(host.mac);
        renderMain();
      } else {
        power(host, 'wake');
      }
    };
    el.defaultConfirmYes.onclick = function () { clearSleepConfirm(); power(host, 'sleep'); };
    el.defaultConfirmNo.onclick = function () { clearSleepConfirm(); renderMain(); };

    var staleMs = Math.max(1, state.settings.pollMinutes) * 60 * 1000;
    var isStale = !entry || !entry.lastChecked || (Date.now() - entry.lastChecked) > staleMs;
    if (isStale && !checking) {
      state.checkingIds.add(host.mac);
      el.defaultStatusDot.innerHTML = statusIndicatorHtml(null, true);
      el.defaultStatusText.textContent = 'Sprawdzanie...';
      chrome.runtime.sendMessage({ type: 'CHECK_HOST', hostId: host.mac }, function () {
        state.checkingIds.delete(host.mac);
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
      var entry = state.statusCache[host.mac];
      var checking = state.checkingIds.has(host.mac);
      var busy = state.busyIds.has(host.mac);
      var awake = isAwake(entry);
      var confirming = awake && state.confirmSleepId === host.mac;

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
      indicator.innerHTML = statusIndicatorHtml(entry, checking);
      var text = document.createElement('span');
      text.textContent = statusLabel(entry, checking);
      if (entry && entry.errorKind && entry.errorMessage) {
        text.title = entry.errorMessage;
      }
      statusRow.appendChild(indicator);
      statusRow.appendChild(text);
      info.appendChild(statusRow);

      info.addEventListener('click', function () {
        if (state.checkingIds.has(host.mac)) return;
        state.checkingIds.add(host.mac);
        renderOthers(others);
        chrome.runtime.sendMessage({ type: 'CHECK_HOST', hostId: host.mac }, function () {
          state.checkingIds.delete(host.mac);
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
        chrome.runtime.sendMessage({ type: 'SET_DEFAULT', hostId: host.mac }, function () {
          state.othersExpanded = true;
          refreshAll();
        });
      });

      var powerBtn = document.createElement('button');
      powerBtn.className = 'btn ' + (awake ? 'btn-sleep-small' : 'btn-wake-small');
      powerBtn.textContent = busy ? '...' : (awake ? (confirming ? 'Na pewno?' : 'Uśpij') : 'Wybudź');
      powerBtn.disabled = busy;
      powerBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!awake) { power(host, 'wake'); return; }
        if (confirming) { clearSleepConfirm(); power(host, 'sleep'); return; }
        armSleepConfirm(host.mac);
        renderMain();
      });

      li.appendChild(info);
      li.appendChild(starBtn);
      li.appendChild(powerBtn);
      el.otherHostsList.appendChild(li);
    });
  }

  // intent: 'wake' | 'sleep'
  function power(host, intent) {
    hideError();
    state.busyIds.add(host.mac);
    renderMain();

    // Sprawdzenie statusu + wysłanie może łącznie potrwać kilkanaście sekund (timeouty w
    // shared/api.js) -- pokazujemy stan "w toku" natychmiast i bez auto-ukrywania (showToast
    // ukrywa po 6s, co mogłoby zniknąć zanim przyjdzie odpowiedź i wyglądać jakby nic się nie stało).
    el.toast.textContent = (intent === 'sleep' ? 'Usypianie: ' : 'Wybudzanie: ') + displayName(host) + '...';
    el.toast.hidden = false;

    var settled = false;
    function finish() {
      state.busyIds.delete(host.mac);
      el.toast.hidden = true;
    }

    var safetyTimer = setTimeout(function () {
      if (settled) return;
      settled = true;
      finish();
      renderMain();
      showError('Brak odpowiedzi od rozszerzenia (przekroczono czas oczekiwania). Spróbuj ponownie.');
    }, 22000);

    chrome.runtime.sendMessage({ type: 'POWER_HOST', hostId: host.mac, intent: intent }, function (response) {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      finish();

      if (!response || !response.ok) {
        showError((response && response.message) || 'Nie udało się wysłać pakietu.');
        // Odmowa "już działa"/"już nie działa" oznacza, że nasz widok statusu był nieaktualny --
        // odświeżamy go, żeby przycisk od razu pokazał właściwą akcję.
        if (response && (response.kind === 'already_awake' || response.kind === 'already_asleep')) {
          chrome.runtime.sendMessage({ type: 'CHECK_HOST', hostId: host.mac }, function () { refreshAll(); });
        } else {
          renderMain();
        }
        return;
      }

      var what = response.action === 'sleep' ? 'Sleep-on-LAN' : 'Wake-on-LAN';
      var msg = 'Wysłano ' + what + ': ' + displayName(host);
      if (response.intentMismatch) {
        msg += ' (stan hosta zmienił się w międzyczasie, więc serwer wykonał inną akcję niż zamierzona)';
      }
      showToast(msg);
      renderMain();
    });
  }

  // ---------- settings screen ----------

  function renderSettings() {
    if (document.activeElement !== el.serverUrl) el.serverUrl.value = state.settings.serverUrl;
    if (document.activeElement !== el.pollMinutes) el.pollMinutes.value = state.settings.pollMinutes;
    renderSettingsHostsList();
    loadAndRenderErrorLog();
  }

  function renderSettingsHostsList() {
    var hosts = state.hosts || [];
    el.noHostsMsg.hidden = hosts.length > 0;
    el.settingsHostsList.innerHTML = '';
    var def = pickDefault(hosts);

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
      sub.textContent = host.mac + ' · ' + host.ip + ' · ' + testLabel(host.testType);
      info.appendChild(name);
      info.appendChild(sub);

      var isDefault = def && host.mac === def.mac;
      var starBtn = document.createElement('button');
      starBtn.className = 'set-default-btn' + (isDefault ? ' is-default' : '');
      if (isDefault) starBtn.style.color = 'var(--star)';
      starBtn.title = 'Ustaw jako domyślny';
      starBtn.textContent = isDefault ? '★' : '☆';
      starBtn.addEventListener('click', function () {
        chrome.runtime.sendMessage({ type: 'SET_DEFAULT', hostId: host.mac }, function () {
          refreshAll();
          showSettingsBanner('Ustawiono jako domyślny: ' + displayName(host), false);
        });
      });

      li.appendChild(info);
      li.appendChild(starBtn);
      el.settingsHostsList.appendChild(li);
    });
  }

  function errorKindLabel(kind) {
    switch (kind) {
      case 'network': return 'NETWORK_ERROR';
      case 'timeout': return 'TIMEOUT';
      case 'http_error': return 'HTTP_ERROR';
      case 'bad_format': return 'BAD_FORMAT';
      case 'auth_required': return 'AUTH_REQUIRED';
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
          // Background czyści cache poprzedniego serwera i od razu pobiera listę hostów nowego.
          chrome.runtime.sendMessage({ type: 'SERVER_URL_CHANGED' }, function () { refreshAll(); });
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

  function handleRefreshHosts() {
    el.refreshHosts.disabled = true;
    chrome.runtime.sendMessage({ type: 'REFRESH_HOSTS' }, function (response) {
      el.refreshHosts.disabled = false;
      if (!response || !response.ok) {
        showSettingsBanner((response && response.message) || 'Nie udało się pobrać listy hostów.', true);
        return;
      }
      showSettingsBanner('Zaktualizowano listę hostów (' + response.hosts.length + ').', false);
      refreshAll();
    });
  }

  function handleOpenPanel() {
    if (!state.settings.serverUrl) {
      showSettingsBanner('Najpierw wpisz i zapisz adres serwera.', true);
      return;
    }
    chrome.tabs.create({ url: state.settings.serverUrl });
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
  el.refreshHosts.addEventListener('click', handleRefreshHosts);
  el.openPanel.addEventListener('click', handleOpenPanel);
  el.clearErrorLog.addEventListener('click', function () {
    chrome.storage.local.set({ errorLog: [] }).then(loadAndRenderErrorLog);
  });

  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName === 'sync' || areaName === 'local') {
      refreshAll();
    }
  });

  refreshAll().then(function () {
    // Lista mogła się zmienić na serwerze (np. kolega dodał komputer) -- odśwież przy każdym otwarciu.
    // Przy błędzie (np. brak VPN) zostaje cache; przyczynę pokaże sprawdzanie statusu i log błędów.
    if (state.settings.serverUrl) {
      chrome.runtime.sendMessage({ type: 'REFRESH_HOSTS' }, function () { void chrome.runtime.lastError; });
    }
  });
})();
