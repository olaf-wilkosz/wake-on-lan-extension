# Notatki / backlog

Kontekst i ustalenia z researchu przed rozpoczęciem projektu, spisane żeby nie trzeba było ich odkrywać ponownie.

## API serwera wake-on-lan.php

Serwer (`wake-on-lan.php`, projekt AndiSHFR/wake-on-lan.php) nie ma jawnie udokumentowanego API w README — poniższe endpointy zostały odkryte poprzez analizę kodu JS strony (nie oficjalna dokumentacja) i mogą się zmienić bez ostrzeżenia przy aktualizacji serwera:

- `GET /index.php?aop=CONFIG.GET` — zwraca JSON z listą hostów: `[{mac, host, cidr, port, comment}, ...]`
- `GET /index.php?aop=HOST.CHECK&host=<IP>` — sprawdza status hosta (test połączenia ssh/rdp/http/https na kolejnych portach, nie zwykły ping — patrz `HOST_CHECK_PORTS` w kodzie serwera)
- `GET /index.php?aop=HOST.WAKEUP&mac=<MAC>&host=<IP>&cidr=<CIDR>&port=<PORT>&comment=<TEXT>&debug=0` — wysyła magic packet

Błędy serwera wracają jako HTTP 500 z czystym tekstem (`"Internal Server Error! <message>"`), nie JSON — klient musi to obsłużyć osobno (patrz `shared/api.js`).

**Status**: te trzy wywołania są już wydzielone do jednego modułu klienta ([shared/api.js](shared/api.js)) zgodnie z rekomendacją "jedno miejsce edycji przy zmianie kontraktu" — nie jest to rozproszone po `popup.js`/`background.js`.

## CORS

Serwer nie wysyła jawnych nagłówków CORS. Rozszerzenie działa mimo to, bo `host_permissions` w Manifest V3 pozwala service workerowi/kontekstom rozszerzenia ominąć restrykcje CORS przy `fetch()` — to udokumentowane zachowanie Chrome, nie przypadek. Wyjaśniający komentarz dodany bezpośrednio w [shared/api.js](shared/api.js) przy funkcji `request()`, żeby nikt w przyszłości nie próbował tego niepotrzebnie "naprawiać" (np. dodając tryb `no-cors` albo proxy).

## Dostępność serwera tylko przez VPN

Docelowy serwer (adres celowo nie jest tu wypisany — patrz sekcja "Audyt bezpieczeństwa" poniżej) jest dostępny wyłącznie po połączeniu z firmowym VPN-em. Z poziomu `fetch()` w przeglądarce nie da się technicznie odróżnić "jestem poza VPN-em" od "serwer faktycznie padł" — oba objawiają się tym samym błędem sieciowym (np. `TypeError: Failed to fetch`, brak rozwiązania DNS, connection refused), bez dodatkowej infrastruktury (np. sprawdzania innego znanego hosta w tej samej sieci) nie da się tego wiarygodnie rozróżnić po stronie klienta.

Zrobione: komunikat błędu dla kategorii `network` w `WolApi.errorToPolish()` podpowiada sprawdzenie VPN, bo to najbardziej prawdopodobna przyczyna w tym środowisku — nie próbuje jednak twierdzić z pewnością, że to na 100% brak VPN (bo tego nie wiemy).

**Backlog / do rozważenia w przyszłości**: jeśli kiedyś pojawi się potrzeba pewniejszego rozróżnienia, można by dodać osobny, zawsze-dostępny (nie tylko po VPN) endpoint healthcheck do testowania ogólnej łączności z siecią firmową — obecnie takiego endpointu nie ma, więc to zostaje jako pomysł, nie zadanie do zrobienia teraz.

## Audyt bezpieczeństwa (przed pierwszym commitem)

Przed inicjalizacją gita zrobiony przegląd repo pod kątem wycieku danych. Znalezisko: rzeczywisty adres serwera (VPN-only, bez żadnej autentykacji po stronie `wake-on-lan.php` — patrz sekcja API wyżej) był zahardcodowany w `manifest.json` (`host_permissions`), `background.js`, `popup.js` i jako placeholder w `popup.html`. Ryzyko: skoro serwer nie ma auth, upublicznienie repo ujawniłoby dokładny adres wewnętrznej bramki WoL komukolwiek z dostępem do tego samego VPN-a (niekoniecznie autoryzowanemu do używania akurat tego narzędzia) — bez żadnej korzyści dla kogoś spoza tej sieci, która nie ma dostępu i tak.

Naprawione:
- `DEFAULT_SERVER_URL` w `background.js`/`popup.js` to teraz pusty string — pole adresu w Ustawieniach jest puste przy pierwszym uruchomieniu, trzeba je wypełnić ręcznie (dowolnym adresem, nie tylko swoim). Rozważany był mechanizm lokalnego, zignorowanego przez git podpowiadania adresu (`config.local.js`) dla wygody -- odrzucony, bo pole miało być czyste dla każdego kto uruchamia rozszerzenie, bez żadnego automatycznego wypełniania, nawet lokalnie.
- `manifest.json` nie ma już statycznego `host_permissions` dla konkretnej domeny — każdy wpisany adres (łącznie z prawdziwym) przechodzi przez ten sam `chrome.permissions.request` przy zapisie w Ustawieniach, bez wyjątków wbudowanych w manifest.
- Reszta repo czysta: brak e-maili/danych osobowych, brak prawdziwych MAC/IP (same placeholdery), brak `console.log`, brak kluczy/tokenów, brak ścieżek systemowych.

## Status projektu wake-on-lan.php (serwer, upstream)

Małe, hobbystyczne, mało aktywne repo: pojedynczy plik PHP, ostatnia widoczna zmiana sprzed ok. 4 lat, 13 otwartych issues, 2 zalegające pull requesty, brak CONTRIBUTING.md. Wniosek: rozszerzenie nie powinno zakładać, że serwer się zmieni (np. że ktoś doda nagłówki CORS albo udokumentuje API). Ewentualny PR do tamtego repo (nagłówki CORS, README z opisem API) to zadanie "na kiedyś", nie coś na czym warto polegać w krótkim terminie — stąd decyzje projektowe tego rozszerzenia (bez zależności od CONFIG.SET, tolerancyjny parser błędów) zakładają serwer dokładnie w obecnym, nieudokumentowanym stanie.
