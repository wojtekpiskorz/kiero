# Fakty: integracja Kiero z Google Calendar

Stan na 7 września 2026. Siedem stron oficjalnej dokumentacji Google. Nota wspiera decyzję o zakresie; nie zatwierdza integracji w v1. Nie wykonano autoryzacji kont, wywołań API ani testów synchronizacji.

## Fakty udokumentowane

**Osobny kalendarz i ograniczone uprawnienia.** Scope `https://www.googleapis.com/auth/calendar.app.created` pozwala tworzyć dodatkowe kalendarze oraz czytać, tworzyć, zmieniać i usuwać wydarzenia na tych kalendarzach. To podstawa wariantu z dedykowanym kalendarzem „Kiero” zamiast dostępu do całego prywatnego kalendarza użytkownika. Ograniczenie dotyczy kalendarzy utworzonych przez aplikację; nie oznacza filtra wyłącznie na wydarzenia utworzone przez Kiero. Aplikacja powinna rozpoznawać zarządzane przez siebie wpisy. Google zaleca najwęższy wystarczający scope. [Google: zakresy Calendar API](https://developers.google.com/workspace/calendar/api/auth)

**Zgoda kalendarza może być późniejsza niż logowanie.** Google obsługuje żądanie dodatkowych zakresów dopiero przy użyciu wymagającej ich funkcji. Samo logowanie przez Google nie daje dostępu do kalendarza. Praca serwera bez obecności użytkownika wymaga dostępu `offline` i odświeżania tokenów. Cofnięcie tokenu obejmującego połączone zakresy cofa je wszystkie; przy projektowaniu odłączenia integracji trzeba uwzględnić tę zależność. [Google: OAuth dla aplikacji serwerowych](https://developers.google.com/identity/protocols/oauth2/web-server)

**Wysyłanie i aktualizacja terminów są możliwe.** Calendar API udostępnia tworzenie, aktualizację, odczyt i usuwanie wydarzeń. Rozróżnia całodniowe `start.date`/`end.date` od `dateTime` ze strefą lub offsetem; koniec jest wyłączny. Pole `source.url` może wskazywać źródło w Kiero. API ma identyfikatory wydarzeń i ETag; dokumentacja zaleca ETag przy aktualizacji odczytanego zasobu, aby nie nadpisać równoległej zmiany. Usunięte wydarzenia są reprezentowane jako `cancelled`; czasem pozostaje tylko identyfikator. [Google: zasób Events](https://developers.google.com/workspace/calendar/api/v3/reference/events)

**Wykrywanie zmian to osobny mechanizm.** `watch` wysyła powiadomienia na serwer HTTPS. Powiadomienie nie zawiera treści zmiany, więc trzeba ją pobrać przez API. Kanały mogą wygasać i nie odnawiają się automatycznie; aplikacja tworzy następny kanał. Google uprzedza, że część powiadomień może zaginąć, dlatego potrzebna jest możliwość uzgodnienia stanu mimo utraconego webhooka. [Google: powiadomienia o zmianach](https://developers.google.com/workspace/calendar/api/guides/push)

**Synchronizacja przyrostowa obejmuje usunięcia.** Po pełnym odczycie aplikacja przechowuje `nextSyncToken` i używa go do pobierania kolejnych zmian, także usuniętych wpisów. Odpowiedź `410 Gone` oznacza nieważny token i konieczność ponownej pełnej synchronizacji. Dla Kiero oznacza to odbudowę lokalnego odwzorowania Google, nie usuwanie kanonicznej pamięci firmy. To ostatnie jest wnioskiem projektowym. [Google: synchronizacja przyrostowa](https://developers.google.com/workspace/calendar/api/guides/sync)

**Google Tasks to osobna integracja.** Listami zadań i zadaniami zarządza Google Tasks API, z oddzielnymi zasobami `tasklists` i `tasks`. Stworzenie wydarzenia w Calendar nie zapewnia synchronizacji listy zadań ani odhaczania wykonania. [Google: Tasks API](https://developers.google.com/workspace/tasks/reference/rest)

**Warunek istotny dla alfy.** Przy odbiorcach typu `External` i stanie publikacji OAuth `Testing` refresh token wygasa po siedmiu dniach, chyba że żądane są wyłącznie podstawowe zakresy tożsamości. Zakres kalendarza nie mieści się w tym wyjątku. Trzeba zaplanować ponowną zgodę w takiej konfiguracji albo odpowiednio przygotować konfigurację publikacji; nie jest to dowód blokady wdrożenia Kiero. [Google: ważność tokenów](https://developers.google.com/identity/protocols/oauth2) Dokumentacja Calendar wskazuje również wymagania weryfikacji dla publicznych aplikacji korzystających z określonych danych użytkowników; faktyczny proces trzeba ustalić dla wybranych zakresów i konfiguracji projektu. [Google: autoryzacja Calendar](https://developers.google.com/workspace/calendar/api/auth)

## Rekomendacja do zatwierdzenia

Najmniejszy sensowny wariant: użytkownik opcjonalnie łączy Google Calendar, a Kiero tworzy osobny kalendarz i aktualizuje w nim wybrane terminy ze swojej bazy. Każdy wpis prowadzi do Kiero. Prywatne kalendarze i ich treść pozostają poza zakresem tego wariantu. Osoba logująca się kodem e-mail również mogłaby osobno połączyć konto Google — to proponowane zachowanie produktu, nie zatwierdzona decyzja o łączeniu tożsamości.

Kiero pozostaje źródłem obowiązujących ustaleń. Dwukierunkowa synchronizacja wymaga dodatkowego kontraktu: czy przeciągnięcie wydarzenia zmienia uzgodniony termin całej firmy, co znaczy usunięcie osobistej kopii oraz jak rozstrzygać równoległe zmiany. Mechanizmy Google dostarczają dane o zmianie, lecz nie definiują tych reguł biznesowych.

## Decyzje i próby pozostające przed implementacją

- Czy integracja wchodzi do v1 i czy ma być jedno- czy dwukierunkowa.
- Które daty trafiają do kalendarza danego użytkownika: własne zadania, terminy projektów, propozycje czy tylko obowiązujące ustalenia.
- Jak odwzorować termin będący punktem czasu bez podanej długości wydarzenia, daty przybliżone oraz nierozstrzygnięty konflikt.
- Jak potraktować ręczne zmiany/usunięcia w Google nawet przy kierunku Kiero → Google; jakie przypomnienia włączyć, aby nie dublować powiadomień Kiero.
- Co zostaje w Google po odłączeniu konta lub utracie dostępu do firmy i jak ograniczyć eksportowaną treść.
- Próba na kontach testerów: zgoda, utworzenie kalendarza, aktualizacje i ponowienia bez duplikatów, cofnięcie dostępu, zmiana/usunięcie w Google, daty całodniowe i strefy czasu. Dla odczytu zmian także odnowienie kanału, utrata webhooka i odbudowa po `410`.
