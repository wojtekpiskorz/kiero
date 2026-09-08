# Fakty architektury backendu: trwałość, AI i granice dostępu

**Stan: 8 września 2026.** Zakres to wyłącznie porównanie PostgreSQL + Drizzle + Graphile Worker z Convex dla wymagań Kiero. Nie wybiera hostingu, cen ani dostawcy modelu.

## Ustalony lokalny kontrakt

`CONTEXT.md` wymaga jednego niezmiennego oryginału wiadomości, korekt jako nowych wpisów oraz bieżących typowanych faktów z pochodzeniem i historią. Dotyczy to także rozszerzalnego katalogu, osobnych stanów nieprzeczytania i wyciszeń, odcięcia danych oraz push po cofnięciu członkostwa, asynchronicznych długich mediów i osobistych kopii Google Calendar. W checkoutcie nie ma manifestu ani lockfile: żadna dokładna wersja Drizzle, Graphile Worker ani Convex nie jest jeszcze lokalnie wybrana.

## Fakty udokumentowane

**PostgreSQL + Drizzle + Graphile Worker.** Drizzle wykonuje zapytania w transakcji i dla PostgreSQL wystawia poziom izolacji. [Drizzle: transactions](https://orm.drizzle.team/docs/transactions) `graphile_worker.add_job()` jest funkcją SQL, której można użyć z kodu aplikacji, funkcji albo triggera. [Graphile: SQL add job](https://worker.graphile.org/docs/sql-add-job) Zapis intencji domenowej i enqueue są więc atomowe *jeśli oba polecenia wykona ta sama transakcja PostgreSQL*; to wniosek z tych dwóch kontraktów, nie odrębna gwarancja Drizzle.

Worker deklaruje brak utraty jobów, wykonanie co najmniej raz i retry z exponential backoff. [Graphile: introduction](https://worker.graphile.org/docs) `job_key` służy do zastępowania, aktualizacji albo ograniczonej deduplikacji jobu; zablokowany job może jednak spowodować zaplanowanie nowego. [Graphile: job key](https://worker.graphile.org/docs/job-key) Nie jest to idempotencja wywołania LLM. Timeout po wysłaniu requestu pozostawia nieznany skutek zewnętrzny; retry może powtórzyć koszt lub request.

Payload zadania jest domyślnie `unknown`; dokumentacja zaleca runtime assertion, bo job może pochodzić spoza TypeScript lub mieć stary format. [Graphile: TypeScript](https://worker.graphile.org/docs/typescript) Projekt sam deklaruje użycie produkcyjne, ale pozostaje w 0.x i uprzedza, że minor może wymagać zmian kodu. [Graphile: project status](https://worker.graphile.org/docs/project-status)

**Convex.** Mutacje są transakcyjne, a action jest jedyną kategorią funkcji mogącą wywołać zewnętrzne API; action nie ma bezpośredniego dostępu do bazy. [Convex: functions](https://docs.convex.dev/functions/overview) Zalecany układ to mutacja zapisująca intencję i planująca action; osobne `runQuery`/`runMutation` z action są osobnymi transakcjami. [Convex: actions](https://docs.convex.dev/functions/actions) Planowanie z mutacji jest atomowe z jej zapisem. Zaplanowana mutacja ma gwarancję dokładnie jednego wykonania, zaś action z efektami zewnętrznymi jest co najwyżej raz i nie dostaje automatycznego retry. [Convex: scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions) To nadal nie ustanawia exactly-once dla LLM ani dla publikacji wyniku po niepewnym requestcie.

Convex automatycznie odświeża zależne subskrypcje, a każdy klient dostaje ten sam snapshot bazy. [Convex: realtime](https://docs.convex.dev/realtime) Jest to gotowa przewaga dla wspólnej rozmowy i stanów nieprzeczytania, lecz nie autoryzacja: publiczna funkcja ma sprawdzić dostęp w kodzie, a Convex świadomie nie oferuje RLS. [Convex: auth](https://docs.convex.dev/auth/overview) Zatem cofnięcie członkostwa musi być sprawdzane przy każdym odczycie, zapisie, subskrypcji, action i wysyłce push; auth wywołującego nie przechodzi automatycznie do funkcji zaplanowanej.

Schemat Convex po wdrożeniu waliduje przyszłe inserty i aktualizacje, a te same walidatory mogą walidować argumenty funkcji; walidację schematu można wyłączyć. [Convex: schemas](https://docs.convex.dev/database/schemas) To jest runtime boundary. W wariancie Drizzle + Graphile trzeba jawnie dodać runtime walidację wejść, wyników AI i historycznych payloadów.

W przejrzanych stronach nie znaleziono deklaracji stable/beta dla całej platformy Convex. Nie należy przenosić statusu beta osobnego Convex Auth na backend. Dla Graphile status 0.x jest udokumentowany powyżej; oba warianty wymagają przypięcia konkretnych wersji przed decyzją.

## Ocena i konieczne próby

To **osąd techniczny**, nie decyzja produktu: relacyjny PostgreSQL najprościej wyraża graf źródeł, poprawek i niezależnych potwierdzeń oraz transakcyjny outbox. Convex najwięcej usuwa własnej pracy przy realtime. Żaden wariant nie rozwiązuje poza transakcją wyniku LLM ani reguły „późniejsza korekta wygrywa ze starym replayem”.

Przed wyborem potrzebne są próby: (1) fault injection po utrwaleniu intencji, po wysłaniu LLM i przed publikacją; (2) warunkowa publikacja z oczekiwaną rewizją, która odrzuca stary rezultat po korekcie; (3) wycofanie członkostwa w trakcie subskrypcji, jobu i push; (4) ewolucja katalogu oraz stary payload jobu; (5) długie audio/zdjęcie jako asynchroniczny proces, bez obietnicy pełnego offline; (6) osobne, per-user kopie Calendar bez przekazania im prawdy domenowej.
