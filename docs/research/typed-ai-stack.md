# Typowany stos AI i trwałe przetwarzanie źródeł w Kiero

**Stan badań: 2026-09-07.** Zakres: PWA, wspólny czat firmy/projektu, wejścia tekstowe, głosowe i fotograficzne oraz budowanie z nich historii, faktów i zadań. Dokument oddziela fakty potwierdzone w dokumentacji właścicieli od oceny dopasowania do Kiero. Nie wybiera stacku ani dostawców i nie zawiera benchmarku lub proof of concept.

## Wniosek decyzyjny

Effect i TanStack AI mogą poprawić jawność kontraktów oraz granic błędów. Same typy, streaming i retry nie ustanawiają jednak trwałości procesu ani poprawności pamięci domenowej: potrzebne są świadomie skonfigurowane mechanizmy utrwalania i sprawdzone reguły publikacji wyników. ElevenLabs jest wiarygodnym kandydatem do polskiego STT, lecz wymaga testu na rzeczywistych nagraniach budowlanych. W ocenie tego raportu PostgreSQL z relacyjnym grafem źródeł i pochodnych oraz kolejką zapisywaną w tej samej transakcji daje najbardziej bezpośrednią kontrolę nad historią pochodzenia. Convex może skrócić budowę spójnego realtime PWA, lecz zewnętrzne AI nadal działa poza transakcją, a izolacja firm pozostaje kodem aplikacji.

W obu wariantach należy utrwalać intencję przed wywołaniem AI, przypisywać operacji stabilny klucz, zapisywać surową odpowiedź i walidowany wynik, a publikację faktów wykonywać osobną transakcją warunkową. Retry oznacza możliwość ponownego wywołania modelu. Żaden z badanych elementów nie daje gwarancji dokładnie jednego wywołania LLM.

## Effect 4

**Fakty.** Oficjalna strona oznacza Effect 4 jako **Release Candidate** i zaleca instalację `effect@rc` ([Effect](https://effect.website/)). Typ `Effect<Success, Error, Requirements>` przenosi oczekiwane błędy i zależności do sygnatury. Defekty, czyli błędy nieoczekiwane i naruszenia niezmienników, nie trafiają do typowanego kanału błędów; runtime zachowuje je w `Cause` ([dwa rodzaje błędów](https://effect.website/docs/v4/error-management/two-error-types)). Effect oferuje schematy runtime, retry z harmonogramem, przerwania, cleanup i kontrolę współbieżności, w tym limit liczbowy oraz tryb nieograniczony ([onboarding](https://effect.website/docs/v4/onboarding), [concurrency](https://effect.website/docs/v4/concurrency/basic-concurrency)).

**Ocena dopasowania.** Effect pasuje jako warstwa orkiestracji: osobne typy błędów dla transkrypcji, vision, walidacji, konfliktu wersji i wycofanego źródła; limity współbieżności per dostawca; kontrolowane retry wyłącznie dla błędów przejściowych; testowalne zegary i zależności. Nie wolno jednak utożsamiać `Effect.retry` z trwałą kolejką. Program i jego fiber nie stanowią po restarcie dowodu wykonania. Trwały stan operacji, lease, licznik prób i wynik muszą mieszkać w backendzie/kolejce. Wprowadzenie RC do rdzenia produktu wymaga też przypięcia dokładnej wersji i testu migracji przed aktualizacją.

## TanStack AI

**Fakty.** TanStack AI ma status **RC** i opisuje się jako headless, pluggable framework przynoszący własną infrastrukturę ([strona projektu](https://tanstack.com/ai/latest)). Narzędzia mają współdzielone definicje, implementacje serwerowe lub klienckie, opcjonalne approval gates oraz schematy wejścia/wyjścia. Zod daje inferencję TypeScript i walidację runtime; surowy JSON Schema pozostawia typ `unknown`, a zwykły JSON Schema dla wyjścia narzędzia nie jest walidowany runtime ([tools](https://tanstack.com/ai/latest/docs/tools/tools), [ToolDefinition](https://tanstack.com/ai/latest/docs/reference/interfaces/ToolDefinition)).

Granica structured output zależy od ścieżki. W trybie bez streamingu `await chat({ outputSchema })` waliduje Standard Schema przed zwrotem. Przy `stream: true` walidacja jest celowo obowiązkiem konsumenta: trzeba zwalidować `structured-output.complete.value.object` albo samemu sparsować surowy tekst. Schemat przekazany do `useChat` służy do inferencji i progresywnego parsowania częściowego, nie daje sam z siebie serwerowej gwarancji ([structured outputs](https://tanstack.com/ai/latest/docs/structured-outputs/overview)).

Projekt oferuje też `@tanstack/ai-persistence` i `@tanstack/ai-durable-stream`: opisuje utrwalanie autorytatywnej rozmowy serwerowej, wznowienie strumienia po zerwaniu połączenia oraz kontynuację wykonania po restarcie procesu ([durability i persistence](https://tanstack.com/ai/latest)). Raport nie sprawdza integracji tych modułów z backendami poniżej ani ich zachowania przy awariach. Ich obecność nie zastępuje weryfikacji reguł pamięci Kiero.

**Ocena dopasowania.** TanStack AI może ujednolicić adaptery, streaming czatu i narzędzia. Dostępne bramki HITL są opcją biblioteki, nie nowym wymaganiem ręcznego zatwierdzania zmian w Kiero. Warstwa AI nie powinna być właścicielem prawdy domenowej. Kiero musi ponownie walidować każdą końcową komendę/fakt na serwerze, sprawdzić firmę, rolę, projekt, aktywność źródeł oraz oczekiwaną rewizję, a dopiero potem pisać do bazy. Typ zdolności modelu może zablokować w kompilacji obraz dla modelu tekstowego, ale nie dowodzi, że zdjęcie, pismo ręczne lub materiał zostały rozpoznane poprawnie.

## ElevenLabs STT

**Fakty.** Aktualna dokumentacja ElevenLabs prezentuje Scribe v2 i Scribe v2 Realtime, ponad 90 języków, diarization, znaczniki czasu i keyterm prompting. Polski (`pol`) jest wspierany i w tabeli producenta znajduje się w grupie „Excellent”, czyli deklarowany WER do 5% ([Speech to Text](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)). To pomiar producenta, nie wynik Kiero.

Oficjalny adapter TanStack AI udostępnia `elevenlabsTranscription`, lecz przykład zbadany 2026-09-07 wywołuje model `scribe_v1`. Ten sam adapter nie obsługuje tekstowego czatu, a wariant realtime nie przyjmuje obrazów ([adapter ElevenLabs](https://tanstack.com/ai/latest/docs/adapters/elevenlabs)). Nie ma więc podstaw do zadeklarowania zgodności dokładnej pary TanStack AI RC + `scribe_v2` bez uruchomienia jej przeciw aktualnemu API.

**Ocena dopasowania.** Przed wyborem trzeba zmierzyć polskie nagrania terenowe: hałas, kilka osób, nazwy własne, skróty, liczby, jednostki i korekty mówcy. Zachować audio, wersję modelu, parametry, transcript z timingiem i ręczną korektę jako osobne źródła. Fotografie i vision wymagają oddzielnego adaptera/modelu.

## Backend A: PostgreSQL + Drizzle + Graphile Worker

**Fakty.** Drizzle udostępnia transakcje i ustawienia izolacji PostgreSQL oraz pozwala używać parametryzowanego SQL; `sql.raw()` świadomie omija parametryzację ([transactions](https://orm.drizzle.team/docs/transactions), [SQL](https://orm.drizzle.team/docs/sql)). `graphile_worker.add_job()` jest funkcją SQL i może być wywołany przez trigger, więc zmianę domenową i enqueue można zatwierdzić lub wycofać w tej samej transakcji bazy ([adding jobs through SQL](https://worker.graphile.org/docs/sql-add-job)). Graphile Worker deklaruje dostarczenie **co najmniej raz** i ponawia błędne zadania z exponential backoff ([introduction](https://worker.graphile.org/docs), [error handling](https://worker.graphile.org/docs/error-handling)). Projekt określa się jako używany produkcyjnie, ale zachowuje numerację 0.x i ostrzega, że minor może wymagać zmian kodu ([project status](https://worker.graphile.org/docs/project-status)). Zalecana walidacja payloadu używa runtime assertion; sama deklaracja `GraphileWorker.Tasks` jedynie zakłada typ ([TypeScript](https://worker.graphile.org/docs/typescript)).

**Ocena dopasowania.** Ten wariant najlepiej eksponuje relacyjny model: `source_event`, niezmienny blob/tekst, przypisania do wielu projektów, `claim`, `claim_support`, `derivation`, korekty i unieważnienia. Unikalne klucze, foreign keys i warunkowy update mogą sprawić, że stary replay nie nadpisze nowszej ręcznej korekty. Wycofanie/reassignment powinno unieważniać tylko krawędzie zależne od danego źródła; fakt pozostaje aktywny, jeśli ma inne niezależne potwierdzenie.

Kosztem jest samodzielne zbudowanie websocket/SSE, synchronizacji klienta, web push, grupowania powiadomień przez 60 sekund, auth, storage i eksportu. PostgreSQL oferuje RLS, ale polityki wymagają projektu i testów; właściciel tabeli zwykle je omija ([Row-Level Security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)). Graphile retry może powtórzyć request do AI po niejednoznacznym timeout. Potrzebne są klucz operacji, zapis prób i deduplikacja wyniku; `job_key` nie daje idempotencji dostawcy.

## Backend B: Convex

**Fakty.** Convex automatycznie śledzi zależności zapytań i aktualizuje subskrypcje klientów spójnym snapshotem ([realtime](https://docs.convex.dev/realtime)). Schemat waliduje dokumenty i daje typy end-to-end ([schemas](https://docs.convex.dev/database/schemas)). Actions mogą wykonywać `fetch`, ale bazę czytają i zapisują pośrednio przez osobne queries/mutations; wiele takich wywołań nie jest jedną transakcją. Dokumentacja zaleca: klient zapisuje intencję mutacją, a ta planuje action ([actions](https://docs.convex.dev/functions/actions)).

Zaplanowane mutations są wykonywane dokładnie raz, natomiast actions z efektami zewnętrznymi najwyżej raz i bez automatycznego retry; ręczne ponowienie nadal musi sprawdzić stan ([scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions)). Konfigurowalne retry i wznowienie kroków zapewnia osobny **Workflow component**, który wymaga idempotentnych kroków ([workflows](https://docs.convex.dev/agents/workflows)). Auth uwierzytelnia JWT/OIDC, lecz autoryzację trzeba sprawdzać w każdej publicznej funkcji; Convex nie ma RLS ([authentication](https://docs.convex.dev/auth/overview)). Eksport może objąć dokumenty i pliki ([CLI export](https://docs.convex.dev/cli/reference/export)).

Convex File Storage wspiera upload i URL-e, ale `storage.getUrl()` tworzy bearer URL dostępny każdemu posiadaczowi; można go unieważnić tylko przez usunięcie pliku. Zmienne uprawnienia wymagają proxy przez HTTP action, z limitem odpowiedzi 20 MB, albo innego storage z wygasającymi URL-ami ([file storage](https://docs.convex.dev/file-storage/overview)).

**Ocena dopasowania.** Convex wyraźnie zmniejsza zakres realtime i synchronizacji PWA. Atomowa mutacja może zapisać źródło, rewizję i zaplanować pracę, lecz wywołanie AI oraz późniejszy zapis wyniku przecinają granicę transakcji. Model pochodzenia da się odwzorować dokumentami i indeksami, ale złożone audyty grafu, migracje, pełny eksport oraz izolację każdej funkcji trzeba udowodnić na prototypie. Grupowanie web push i per-user read state pozostają logiką Kiero.

## Propozycja techniczna do rozstrzygnięcia w grillingu

Zatwierdzony zakres zakłada autonomiczne aktualizacje pamięci przez AI. Proponowany sposób realizacji: każda wiadomość/media dostaje niezmienny identyfikator źródła, autora, firmę, opcjonalny zestaw projektów, czas biznesowy, czas przyjęcia i wersję parsera/modelu. Agent automatycznie aktualizuje fakty i zadania przez walidowane operacje backendu, bez dodawania obowiązkowego zatwierdzenia przez człowieka. Publikacja porównuje oczekiwaną rewizję: nowsza ręczna korekta wygrywa ze starszym replayem. `unknown` i konflikt są stanami domenowymi, a nie `null` do cichego nadpisania. Pochodna przechowuje krawędzie wsparcia. Wycofanie źródła uruchamia przeliczenie zależności z zachowaniem niezależnych potwierdzeń oraz audytu. Dokładny model danych i algorytm pozostają przedmiotem decyzji HITL.

## Proponowane próby dla wybranego kandydata

Poniższa lista wskazuje dowody potrzebne do oceny wybranej konfiguracji przed jej ostatecznym zatwierdzeniem. Wstępny wybór kandydata i zakres prób ustala grilling architektury. Raport nie wymaga budowy obu backendów ani przyjęcia wersji RC; próby porównawcze mają sens tylko tam, gdzie zostanie istotna nierozstrzygnięta różnica.

1. Przypiąć dokładne wersje ocenianych bibliotek i adapterów; uruchomić kompilację oraz runtime validation dla tool input/output i streamed structured output. Jeśli wybrano moduły persistence/durability, uwzględnić je w tej samej próbie.
2. Jeśli kandydatem jest Scribe v2, sprawdzić `scribe_v2` przez wybraną integrację; zmierzyć WER i błędy encji na polskim korpusie Kiero. Osobno sprawdzić vision pisma i materiałów.
3. W wybranym backendzie przeprowadzić fault injection w punktach: po zapisie intencji, po wysłaniu requestu AI, po odpowiedzi i przed publikacją. Udowodnić brak podwójnej publikacji mimo możliwego podwójnego kosztu modelu.
4. Przetestować kolejno: mieszane przypisanie projektów, nieznany projekt, sprzeczne fakty, ręczna korekta nowsza od replayu, wycofanie/reassignment oraz dwa niezależne potwierdzenia.
5. Udowodnić izolację firm dla czatu, subskrypcji, plików, jobs/actions, eksportu i powiadomień; sprawdzić cofnięcie dostępu do już wydanego URL-a.
6. Zmierzyć latency/cost przy streamingu i 60-sekundowym grupowaniu push oraz wykonać restore/export drill. Budżet i progi tierów pozostają otwarte.

**Podsumowanie do resolution:** Effect 4 i TanStack AI są obecnie RC i wspierają typowane kontrakty. TanStack AI oferuje również moduły persistence/durability; integracja, idempotencja i poprawność pamięci nadal wymagają sprawdzenia w konkretnej konfiguracji. ElevenLabs deklaruje bardzo dobrą obsługę polskiego, ale aktualny przykład adaptera używa `scribe_v1`, więc integracja `scribe_v2` wymaga próby. PostgreSQL + Drizzle + Graphile umożliwia atomowy zapis stanu i enqueue, za cenę osobnego rozwiązania realtime/auth/media. Convex dostarcza realtime, schematy, scheduling, storage i eksport, ale działania AI przecinają granice transakcji, scheduled actions są at-most-once, a retry workflow jest osobnym komponentem. Wybór stacku i zakres dowodów pozostają decyzją HITL.
