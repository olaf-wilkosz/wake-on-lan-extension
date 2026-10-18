'use strict';
// Generuje zrzuty ekranu do README (docs/img) z prawdziwego UI i atrapy serwera z neutralnymi danymi.
// Uruchom: npm run screenshots   (wymaga Chrome; ustaw CHROME_PATH, jeśli nie jest w typowym miejscu)
const fs = require('fs');
const path = require('path');
const { createFakeGptwol, DEFAULT_COMPUTERS } = require('./fake-gptwol.js');
const { findChrome, writeHarness, runChrome } = require('./harness.js');

const OUT = path.join(__dirname, '..', '..', 'docs', 'img');
const SHOTS = [
  { file: 'main-offline.png', scenario: 'idle', awake: false, dark: false, size: [360, 232] },
  { file: 'confirm-sleep.png', scenario: 'confirm', awake: true, dark: true, size: [360, 262] },
  { file: 'settings.png', scenario: 'settings', awake: false, dark: false, size: [360, 500] }
];

(async function () {
  const chrome = findChrome();
  if (!chrome) { console.error('Nie znaleziono Chrome/Chromium -- ustaw CHROME_PATH.'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  for (const shot of SHOTS) {
    const awake = shot.awake ? { [DEFAULT_COMPUTERS[0].ip]: true } : {};
    // stały port, żeby adres na zrzucie ustawień był czytelny; gdy zajęty -- dowolny wolny
    const srv = await createFakeGptwol({ awake: awake, port: 5000 }).catch(function () { return createFakeGptwol({ awake: awake }); });
    try {
      const out = path.join(OUT, shot.file);
      await runChrome(chrome, writeHarness(srv.base, shot.scenario, { light: !shot.dark }), [
        '--hide-scrollbars', '--force-device-scale-factor=2',
        '--window-size=' + shot.size.join(','),
        '--screenshot=' + out
      ]);
      console.log(fs.existsSync(out) ? 'OK   ' + shot.file : 'BRAK ' + shot.file);
    } finally { await srv.close(); }
  }
})();
