# Fakty: odwzorowanie terminów Kiero w Google Calendar

Stan na 7 września 2026. Uzupełnienie wcześniejszej noty o integracji: pięć oficjalnych stron Google, bez autoryzacji, operacji API i testów na kontach. Nota nie zatwierdza polityki produktu.

## Termin bez czasu trwania

`events.insert` wymaga obu pól: `start` i `end`. Początek jest włączny, koniec wyłączny. Data całodniowa używa `date`, a data z godziną `dateTime` wraz z offsetem lub strefą. [Google: Events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)

`endTimeUnspecified` oznacza nieokreślony koniec, ale reprezentacja nadal zawiera `end` dla kompatybilności. Pole nie ma oznaczenia `writable` i nie występuje w tabeli pól `insert`. Nie stanowi to potwierdzenia, że aplikacja może tworzyć wydarzenia bez końca. [Google: Events](https://developers.google.com/workspace/calendar/api/v3/reference/events), [Google: Events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)

**Nie potwierdzono obsługi zerowej długości (`start = end`) w przejrzanej dokumentacji.** Nie ma również podstaw do deklarowania, że jest zabroniona. Odwzorowanie samego deadline’u wymaga próby API i wyglądu w klientach Google; dokumentacja nie wybiera reprezentacji produktu.

## Dostępność i przypomnienia

`transparency=transparent` oznacza wolny czas; domyślne `opaque` blokuje czas. To zapisywalne ustawienie wydarzenia odpowiadające opcji w interfejsie Google. `reminders.useDefault=false` bez `overrides` oznacza brak przypomnień tego wydarzenia. Sama zmiana przypomnień nie aktualizuje pola `updated`. [Google: Events](https://developers.google.com/workspace/calendar/api/v3/reference/events)

Użytkownik może ustawić domyślne przypomnienia kalendarza i zmienić je dla pojedynczego wydarzenia. API pozwala ustawić własny zestaw przy tworzeniu lub aktualizacji, albo przywrócić dziedziczenie przez `useDefault=true`. Przypomnienia są osobiste; ustawienia jednej osoby nie sterują przypomnieniami innych. [Google: przypomnienia](https://developers.google.com/workspace/calendar/api/concepts/reminders)

Powiadomienia o zmianach, dzienna agenda i przypomnienia przed terminem to odrębne funkcje. Użytkownik zarządza powiadomieniami kalendarza; API opisuje je w `CalendarList`. Wyłączenie przypomnień wydarzenia nie jest gwarancją wyłączenia wszystkich wiadomości Google. Zakresy dostępu potrzebne do zmiany `CalendarList` wymagają osobnej weryfikacji przed taką implementacją. [Google: przypomnienia](https://developers.google.com/workspace/calendar/api/concepts/reminders)

## Ręczne zmiany i synchronizacja w jedną stronę

Rola `owner` obejmuje prawa `writer`: odczyt i zapis wydarzeń. Samo utworzenie dedykowanego kalendarza aplikacji nie jest opisanym mechanizmem blokowania użytkownikowi zmian. Właściciel może również zmieniać udostępnienie kalendarza. [Google: udostępnianie](https://developers.google.com/workspace/calendar/api/concepts/sharing)

Pole wydarzenia `locked` jest tylko do odczytu. API udostępnia odczyt, zmianę i usuwanie; `patch` zachowuje niewskazane pola, a pełne `update` wymaga zachowania ich przez klienta. Dokumentacja zaleca ETag dla bezpiecznej aktualizacji odczytanego zasobu. [Google: Events](https://developers.google.com/workspace/calendar/api/v3/reference/events)

**Wniosek projektowy:** technicznie można wykrywać rozbieżności i odtwarzać dane Kiero albo zachowywać wybrane osobiste zmiany. Automatyczne odtworzenie usuniętego wpisu, respektowanie usunięcia jako ukrycia czy zgłoszenie konfliktu są odrębnymi politykami. Jednokierunkowy zapis nie rozstrzyga ich sam. Wpisów dodanych przez użytkownika nie należy utożsamiać z wpisami zarządzanymi przez Kiero.

## Odłączenie i utrata OAuth

Cofnięcie upoważnienia unieważnia wydane tokeny dostępu i odświeżania projektu; pełny skutek może pojawić się z opóźnieniem. [Google: cofnięcie OAuth](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke)

**Wniosek:** Kiero nie może obiecać późniejszego sprzątnięcia kalendarza po utracie uprawnień. Planowane usunięcie zarządzanych wydarzeń wymaga działającej autoryzacji przed odłączeniem; po zewnętrznym cofnięciu zgody może być potrzebna ponowna autoryzacja albo działanie użytkownika w Google. Nie zakładamy automatycznego usunięcia wydarzeń przez samo cofnięcie OAuth.

Przed implementacją potrzebne są próby: deadline bez długości; edycja i usunięcie przez właściciela; zachowanie osobistych przypomnień podczas aktualizacji; równoległa zmiana; odłączenie z działającym tokenem oraz po jego cofnięciu. Nie wykonano żadnej z tych prób.
