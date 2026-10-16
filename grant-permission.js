(function () {
  var params = new URLSearchParams(window.location.search);
  var pattern = params.get('origin') || '';
  var serverUrl = params.get('serverUrl') || '';

  var el = {
    originText: document.getElementById('originText'),
    statusBanner: document.getElementById('statusBanner'),
    grantBtn: document.getElementById('grantBtn'),
    cancelBtn: document.getElementById('cancelBtn')
  };

  el.originText.textContent = pattern;

  function showStatus(message, isError) {
    el.statusBanner.textContent = message;
    el.statusBanner.className = 'banner ' + (isError ? 'banner-error' : 'banner-success');
    el.statusBanner.hidden = false;
  }

  el.grantBtn.addEventListener('click', function () {
    if (!pattern) {
      showStatus('Brak adresu do przyznania dostępu.', true);
      return;
    }
    el.grantBtn.disabled = true;
    chrome.permissions.request({ origins: [pattern] }).then(function (granted) {
      if (!granted) {
        el.grantBtn.disabled = false;
        showStatus('Nie przyznano dostępu. Adres serwera nie został zapisany.', true);
        return;
      }
      chrome.storage.sync.set({ serverUrl: serverUrl }).then(function () {
        chrome.runtime.sendMessage({ type: 'SERVER_URL_CHANGED' });
        showStatus('Zapisano! Możesz zamknąć tę kartę i otworzyć rozszerzenie ponownie.', false);
        el.grantBtn.hidden = true;
        el.cancelBtn.textContent = 'Zamknij kartę';
      });
    });
  });

  el.cancelBtn.addEventListener('click', function () {
    window.close();
  });
})();
