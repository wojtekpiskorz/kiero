# Możliwości PWA dla nagrań, zdjęć i web push

Stan źródeł: 2026-09-07

## Zakres

Raport dotyczy Kiero jako uwierzytelnionej, instalowalnej aplikacji webowej na telefon i komputer. W wersji 1 użytkownicy zaproszonych firm zapisują tekst, wiadomości głosowe i zdjęcia w szybkim kanale firmowym albo czacie projektu. Aplikacja działa online. Raport rozdziela instalację, działanie offline, pracę w tle i web push, ponieważ są to osobne możliwości przeglądarki.

To przegląd dokumentacji, bez prób na urządzeniach. Nie wykonano testów na telefonach użytkowników ani benchmarku rozpoznawania mowy. Wnioski oznaczone jako projektowe opisują konsekwencje źródeł dla Kiero, ale nie wybierają minimalnej wersji systemu ani listy wspieranych urządzeń za testerów.

## Instalacja i zgody

**Fakt.** Instalacja PWA nie włącza automatycznie offline, nagrywania ani powiadomień. Daje ikonę, osobne okno i integracje udostępnione przez dany system. Kryteria oraz sposób instalacji zależą od przeglądarki i systemu. Chromium na Androidzie może pokazać sterowany przez aplikację dialog instalacji. iOS i iPadOS wymagają ręcznego dodania strony z menu udostępniania, bez przeglądarkowego promptu instalacyjnego. Źródło Google opisuje także odrębny proces i izolowaną pamięć dla wielu instalacji tej samej aplikacji na urządzeniu Apple: [web.dev, Installation](https://web.dev/learn/pwa/installation).

**Fakt.** Na iOS i iPadOS web push działa dla aplikacji dodanej do ekranu początkowego. Aplikacja może poprosić o zgodę dopiero w reakcji na bezpośrednie działanie użytkownika, na przykład naciśnięcie przycisku subskrypcji. Użytkownik może później zmienić zgodę w ustawieniach systemu. WebKit zaleca wykrywanie funkcji zamiast rozpoznawania przeglądarki: [WebKit, Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

**Wniosek projektowy.** Onboarding powinien osobno prowadzić przez instalację oraz włączenie powiadomień i pokazywać rzeczywisty stan obu kroków. Odmowa zgody nie może blokować wejścia do Kiero. Nie należy też obiecywać web push w zwykłej karcie iOS przed instalacją na ekranie początkowym.

## Wiadomości głosowe

**Fakt.** `getUserMedia()` wymaga bezpiecznego kontekstu HTTPS i zgody użytkownika. Żądanie może zakończyć się odmową, brakiem urządzenia, błędem sprzętu lub systemu, a użytkownik może pozostawić prompt bez odpowiedzi, przez co obietnica nie rozstrzygnie się. Cofnięcie zgody lub utrata źródła może też zakończyć ścieżkę: [MDN, `MediaDevices.getUserMedia()`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

**Fakt.** Nie ma jednego bezpiecznego założenia o kontenerze i kodeku. `MediaRecorder.isTypeSupported()` sprawdza konkretny MIME type, lecz wynik `true` nie gwarantuje powodzenia przy braku zasobów: [MDN, `MediaRecorder.isTypeSupported()`](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static). Kod powinien sprawdzić obecność `MediaRecorder`, przetestować uporządkowaną listę formatów, a po uruchomieniu zapisać faktyczny `mediaRecorder.mimeType`. Serwer i późniejszy moduł STT muszą przyjmować wynik wykryty na urządzeniu, nie nazwę formatu wpisaną na stałe.

**Fakt.** `start(timeslice)` nie tworzy równych i punktualnych części. Safari może wstrzymać kamerę i mikrofon, a blokada ekranu w Chrome na Androidzie wstrzymuje zdarzenia `dataavailable`. Po powrocie może przyjść znacznie większy `Blob`. MDN odradza liczenie czasu na podstawie liczby części: [MDN, `dataavailable`](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/dataavailable_event).

**Wniosek projektowy.** Kiero powinno traktować nagrywanie jako operację pierwszoplanową, obserwować `visibilitychange`, `mute`, `unmute`, `ended`, `error` i `stop`, a po powrocie jasno pokazać, co faktycznie zapisano. Części trzeba utrwalać na bieżąco, ale nie wolno obiecywać, że nagranie będzie trwało po blokadzie ekranu lub przejściu do innej aplikacji. Limit długości powinien opierać się na niezależnym zegarze i kontrolować również rozmiar, bo opóźnione zdarzenie może dostarczyć duży fragment.

## Zdjęcia i pliki

**Fakt.** `<input type="file" accept="image/*">` może na urządzeniu mobilnym udostępnić wybór zdjęcia lub aparat. Atrybut `capture="environment"` sugeruje aparat tylny, ale ma ograniczoną zgodność i pozostaje wskazówką dla systemowego selektora: [MDN, atrybut `capture`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/capture). `accept` także jest wskazówką interfejsu, więc backend nadal musi sprawdzać typ, rozmiar i treść pliku.

**Wniosek projektowy.** Najszerszą ścieżką wersji 1 jest systemowy selektor pliku ze zdjęciami i możliwością uruchomienia aparatu. Własny podgląd z `getUserMedia()` można rozważyć później, jeśli próby wykażą, że selektor systemowy nie wystarcza. Aplikacja powinna zachować plik lokalnie do czasu potwierdzenia przyjęcia przez serwer i pokazywać stan wysyłki.

## Trwała wysyłka i ponawianie

**Fakt.** PWA ani service worker nie gwarantują dokończenia długiego uploadu po zamknięciu lub uśpieniu aplikacji. Service worker może zostać zatrzymany w trakcie operacji wejścia i wyjścia. Google opisuje produkcyjny przypadek dużych plików, w którym odporność wymagała wznawialnego protokołu serwerowego oraz zapisania URL i stanu uploadu w IndexedDB przed kolejnym krokiem: [web.dev, Building a PWA at Google, part 1](https://web.dev/articles/building-a-pwa-at-google-part-1).

**Fakt.** Jednorazowy Background Sync nie daje terminu ani nieograniczonej liczby prób. Przeglądarka wybiera czas ponowienia, może ograniczyć liczbę prób i czas zdarzenia, a `lastChance` oznacza ostatnią próbę. Specyfikacja pokazuje też brak obsługi `SyncEvent` w Safari i iOS Safari: [WICG, Web Background Synchronization](https://wicg.github.io/background-sync/spec/). To wyklucza użycie tej funkcji jako wspólnej gwarancji dokończenia wysyłki na iOS i Androidzie.

**Wniosek projektowy.** Kiero potrzebuje jednoznacznego potwierdzenia trwałego przyjęcia źródła przez serwer i ponawiania, które nie tworzy drugiej wiadomości po utracie odpowiedzi. Wybór między ponowną wysyłką całego pliku a protokołem wznawiania części zależy od limitów zdjęć/nagrań i prób na sieci testerów. Dla większych plików kandydatem jest identyfikator uploadu, numerowane części lub zakresy, odczyt zapisanego postępu i osobna finalizacja załącznika; nie jest to automatyczny wymóg każdego wejścia v1.

Proponowane zachowanie klienta to lokalne zachowanie pliku i stanu wysyłki do potwierdzenia przyjęcia. Trwałość lokalnej kopii po zamknięciu aplikacji wymaga osobnej próby, nie jest gwarancją tego raportu. W wersji online ponowienie może nastąpić po powrocie aplikacji na pierwszy plan. Background Sync może być dodatkiem tam, gdzie przejdzie wykrywanie funkcji.

## Web push, wiele urządzeń i stan odczytu

**Fakt.** Push działa przez aktywny service worker. Subskrypcja zawiera unikalny endpoint i klucze, a każda subskrypcja należy do konkretnej rejestracji service workera: [MDN, Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API). Jedno konto używane na kilku urządzeniach może więc mieć kilka rekordów subskrypcji. Push service może odświeżyć lub unieważnić subskrypcję, a standard przewiduje `pushsubscriptionchange`: [W3C, Push API](https://www.w3.org/TR/push-api/#subscription-refreshes).

**Fakt.** HTTP Web Push ma TTL. Usługa może przechować wiadomość krócej, przerwać ponawianie przed TTL, wygasić subskrypcję i odpowiedzieć `404` lub `410`. Potwierdzenie dostarczenia, jeśli jest dostępne, dotyczy dotarcia do user agenta, nie przeczytania przez człowieka: [RFC 8030](https://www.rfc-editor.org/rfc/rfc8030.html). Notifications API definiuje aktywację przez użytkownika jako `notificationclick` i osobno zamknięcie. Nie definiuje zdarzenia „przeczytano”: [WHATWG, Notifications API](https://notifications.spec.whatwg.org/#activating-a-notification).

**Wniosek projektowy.** Serwer powinien przechowywać wiele subskrypcji na użytkownika, usuwać endpointy po trwałych odpowiedziach `404` i `410` oraz pozwalać ponownie włączyć powiadomienia. Grupowanie przez 60 sekund, wyciszenie projektu i brak powiadomień o własnych wpisach muszą powstać po stronie domeny Kiero przed wysyłką do każdego aktywnego endpointu. Stan odczytu wiadomości powinien pochodzić z uwierzytelnionej akcji w aplikacji i być zapisany per użytkownik. Dostarczenie push, kliknięcie albo zamknięcie powiadomienia nie zastępuje tego stanu.

## Próby wymagane na telefonach testerów

Przed ustaleniem zakresu wspieranych wersji trzeba zebrać model telefonu, wersję systemu, przeglądarkę używaną do instalacji i tryb uruchomienia. Na każdym rzeczywistym urządzeniu należy sprawdzić:

1. instalację, ponowne uruchomienie z ikony, logowanie i trwałość sesji;
2. prośbę o mikrofon po pierwszej odmowie i po zmianie zgody w ustawieniach;
3. nagrania 10 sekund, 2 minuty i przy limicie produktu, wraz z MIME type, rozmiarem i odtwarzaniem po stronie serwera;
4. blokadę ekranu, przejście do innej aplikacji, połączenie telefoniczne, zmianę urządzenia audio, utratę sieci i ubijanie procesu podczas nagrania oraz uploadu;
5. zdjęcie z aparatu, wybór z galerii, duży plik, HEIC, JPEG i anulowanie selektora;
6. wznowienie uploadu po utracie odpowiedzi oraz kontrolę, że retry nie tworzy duplikatu;
7. web push po instalacji, przy aplikacji otwartej, zamkniętej i po restarcie telefonu, cofnięcie zgody, ponowną subskrypcję i dwa urządzenia jednego użytkownika;
8. reguły Kiero: brak własnych powiadomień, wyciszony projekt, jedna grupa po 60 sekundach i niezależny stan odczytu na dwóch urządzeniach.

## Podsumowanie do resolution

Dokumentacja potwierdza możliwość instalowalnej aplikacji webowej z tekstem, zdjęciami, nagrywaniem w pierwszym planie i web push, przy opisanych ograniczeniach platform. Nie gwarantuje ciągłego nagrywania po blokadzie, dokończenia dużego uploadu w tle ani odczytania wiadomości na podstawie push. Rekomendacje projektowe obejmują wykrywanie funkcji i formatów, trwałe potwierdzenie przyjęcia z ponawianiem bez duplikatów, wiele endpointów push na użytkownika oraz serwerowy stan odczytu. Konkretny protokół uploadu i zakres wspieranych urządzeń pozostają do ustalenia na podstawie limitów produktu i prób fizycznych.
