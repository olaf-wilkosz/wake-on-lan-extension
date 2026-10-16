# Notatki / backlog

Kontekst i ustalenia, spisane żeby nie trzeba było ich odkrywać ponownie.

## Układ gałęzi

- `main` — rozszerzenie pod **gptwol** ([Misterbabou/gptwol](https://github.com/Misterbabou/gptwol)), aktualny kierunek.
- `legacy-wolphp` — zamrożona wersja pod stary serwer AndiSHFR/wake-on-lan.php (zespół z niego zrezygnował, upstream nieaktywny od ok. 4 lat). Nie rozwijamy; gdyby kiedyś były dwa projekty, to stąd.

Priorytet: usprawnienie pracy własnej i zespołu. Publikacja w Chrome Web Store jest możliwym celem na później — patrz "Pod publikację".

## Kontrakt gptwol (nieoficjalny)

gptwol nie ma udokumentowanego API ani endpointu JSON. Poniższe wynika z czytania jego kodu (`app/wol.py`, `app/templates/wol_form.html`) i może się zmienić przy aktualizacji serwera. Całość jest w jednym miejscu: [shared/api.js](shared/api.js).

| Operacja | Wywołanie | Odpowiedź |
|---|---|---|
| Lista hostów | `GET /` | HTML (brak JSON-a); parsujemy ukryte pole `mac_address`, nazwę i `data-ip-address`/`data-test-type` |
| Status | `GET /check_status?ip_address=&test_type=` | tekst `awake` / `asleep` |
| Wake **albo** Sleep | `POST /wol_or_sol_send` (`mac_address=`) | HTML z modalem |

`test_type` jest per host: `icmp`, `arp` albo numer portu TCP. Hosty trzeba najpierw dodać w panelu serwera (wybudzenie idzie po samym MAC-u, nieznany MAC = HTTP 500).

### Uwaga: `wol_or_sol_send` to PRZEŁĄCZNIK

Serwer sam sprawdza, czy host działa, i jeśli tak, wysyła **Sleep-on-LAN (wyłączenie)** zamiast WoL. Samo "Wybudź" na działającym komputerze mogłoby go więc wyłączyć. Zabezpieczenia w rozszerzeniu:

- `WolApi.sendPower(base, host, intent)` najpierw sprawdza status tym samym testem co serwer i **odmawia**, gdy wysłanie dałoby odwrotny skutek (`already_awake` / `already_asleep`) — wtedy nic nie jest wysyłane.
- "Uśpij" wymaga potwierdzenia w UI (przycisk host-domyślny: wiersz "Uśpić ...?"; lista: "Na pewno?" przez 6 s).
- Zostaje wąski wyścig między naszym sprawdzeniem a sprawdzeniem serwera. Dlatego po wysłaniu parsujemy odpowiedź i raportujemy to, co serwer FAKTYCZNIE zrobił (a nie to, co zamierzaliśmy).
- Sam panel gptwol robi to samo (przycisk zielony "Wake" / czerwony "Sleep" zależnie od statusu).

Przetestowane: parser i status na żywym serwerze (tylko odczyt), cała logika przełącznika i UI na atrapie serwera. Ścieżki wysyłającej na prawdziwym serwerze celowo NIE testowano automatycznie (wybudziłaby albo wyłączyła realną maszynę).

## Model danych

Źródłem prawdy o hostach jest **serwer**; rozszerzenie trzyma tylko cache listy (`storage.local.hostsCache`), statusy (`statusCache`), log błędów, oraz (`storage.sync`) adres serwera, interwał i host domyślny. Kluczem hosta jest MAC. Dzięki temu cały zespół widzi tę samą listę bez ręcznego wpisywania. Dodawanie/edycja/usuwanie hostów odbywa się w panelu serwera (przycisk "Panel serwera" w Ustawieniach).

Stare dane z wersji `legacy-wolphp` (`storage.sync.hosts`, klucze UUID) są czyszczone przy starcie (`migrateLegacyStorage`).

## CORS i uprawnienia

Serwer nie wysyła nagłówków CORS. Rozszerzenie działa mimo to, bo origin serwera dostaje uprawnienie hosta (`optional_host_permissions` + `chrome.permissions.request` przy zapisie adresu), a konteksty rozszerzenia z takim uprawnieniem są zwolnione z CORS — nie "naprawiać" tego `no-cors` ani proxy. Natywne okno zgody zamyka popup (utrata fokusu), dlatego prośba o zgodę idzie przez osobną kartę ([grant-permission.html](grant-permission.html)).

Wzorzec uprawnienia zawiera port (`http://host:5000/*`) — do potwierdzenia w prawdziwym Chrome przy pierwszym teście.

## Dostępność tylko przez VPN/LAN

Z poziomu `fetch()` nie da się odróżnić "poza siecią" od "serwer padł" (ten sam błąd sieciowy). Komunikat dla `network` podpowiada VPN jako najczęstszą przyczynę, bez twierdzenia, że to pewne.

## Adres serwera nie trafia do repo

Rzeczywisty adres serwera jest wewnętrzny, a gptwol bywa bez autentykacji — nie wpisujemy go do żadnego śledzonego pliku (ani `manifest.json`, ani kodu, ani notatek). Pole adresu jest puste przy pierwszym uruchomieniu; użytkownik wpisuje własny. Brak statycznego `host_permissions` — każdy adres przechodzi przez ten sam `chrome.permissions.request`.

## Backlog

- **Faza 2 (hosty z poziomu rozszerzenia):** dodawanie/edycja/usuwanie komputerów (`POST /add_computer`, `/edit_computer`, `/delete_computer`) i skan ARP (`GET /arp_scan`, jedyny endpoint JSON). Cron świadomie pominięty (konfiguracja pasuje do panelu, nie do popupu).
- **Logowanie (`ENABLE_LOGIN`):** dziś wykrywamy przekierowanie na `/login` i pokazujemy czytelny błąd (`auth_required`). Obsługa sesji (`POST /login`) do zrobienia; trzeba zweryfikować, czy ciasteczka sesji są wysyłane z kontekstu rozszerzenia (instancja zespołu ma logowanie wyłączone, więc nie da się tego sprawdzić na niej). OIDC wymaga przekierowań — dla takich instancji sensowne jest tylko otwarcie panelu w karcie.
- **Odporność parsera:** parsowanie HTML jest kruche między wersjami gptwol. Przy publikacji zapisać w README wersję, z którą testowano; błąd `bad_format` mówi o niezgodności formatu.

## Pod publikację (Chrome Web Store)

- Szeroki `optional_host_permissions` (`http://*/*`, `https://*/*`) jest nieunikniony (adres serwera dowolny) — przy review zwykle wymaga uzasadnienia i może je wydłużyć.
- W opisie zaznaczyć, że to nieoficjalne rozszerzenie niezwiązane z autorem gptwol.
- Dopisać README (instalacja, wymagania: działający gptwol, uprawnienia, ograniczenia: brak logowania/OIDC).

## Status upstream: gptwol

Aktywne repo (MIT, ostatnie zmiany 2026, kilkaset gwiazdek, obraz Dockera). To zmniejsza ryzyko zmiany kontraktu w porównaniu ze starym serwerem, ale kontrakt dalej jest nieudokumentowany — stąd cały dostęp w jednym module i jawny błąd `bad_format`.
