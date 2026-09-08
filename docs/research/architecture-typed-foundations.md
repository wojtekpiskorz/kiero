# Typowane fundamenty architektury — ustalenia do grillingu

**Stan: 2026-09-08. Zakres:** PWA Kiero z jedną Rozmową firmy, niezmiennymi wiadomościami źródłowymi (tekst, nagranie, zdjęcia) oraz autonomicznie aktualizowaną, ustrukturyzowaną pamięcią. Nie jest to wybór dostawcy ani stacku. W checkoutcie nie ma `package.json`; poniższe wersje są stanem publicznego rejestru, nie lokalnym kontraktem.

## Fakty potwierdzone

- Rejestr npm wskazuje `effect` **3.22.1** jako `latest`, a **4.0.0-rc.112** jako `rc`; Effect 4 nadal jest prerelease. [Rejestr Effect](https://registry.npmjs.org/effect). Źródło Effect 4 ma `Schema.toStandardSchemaV1` (walidator Standard Schema v1) oraz `toStandardJSONSchemaV1`, opisane jako *experimental*; pierwsza funkcja może zwrócić `Promise` przy asynchronicznych checkach. To obserwacja bieżącego upstream `main`, nie dowód zachowania dokładnie `rc.112`. [Źródło Schema](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Schema.ts)

- `@tanstack/ai` ma `latest` **0.53.0** ([rejestr](https://registry.npmjs.org/@tanstack%2fai)); `@tanstack/ai-react` **0.24.0** ([rejestr](https://registry.npmjs.org/@tanstack%2fai-react)), `@tanstack/ai-persistence` **0.5.6** ([rejestr](https://registry.npmjs.org/@tanstack%2fai-persistence)) i `@tanstack/ai-durable-stream` **0.1.10** ([rejestr](https://registry.npmjs.org/@tanstack%2fai-durable-stream)). Są publikowane niezależnie; nie wolno zakładać jednej wspólnej wersji pakietów. W odczytanych tagach AI nie ma `rc`, a aktualna [landing page AI](https://tanstack.com/ai/latest) nie zawiera jawnego oznaczenia RC. To nie dowodzi stabilności 1.0; historycznego statusu „RC” nie należy powtarzać bez wersjonowanego komunikatu upstream. TanStack AI przyjmuje do `outputSchema` Standard JSON Schema, Standard Schema albo surowy JSON Schema; z surowego JSON Schema typ wyniku jest `unknown`. Dokumentacja deklaruje runtime validation na ścieżce serwerowej. [Structured outputs](https://tanstack.com/ai/latest/docs/structured-outputs/overview)

- W streamingu końcowy obiekt przychodzi w `structured-output.complete`; adapter może użyć natywnego jednego requestu albo fallbacku do nie-streamowanej ekstrakcji. Sam fakt streamingu nie jest publikacją domenową. [Streaming structured output](https://tanstack.com/ai/latest/docs/structured-outputs/streaming). Narzędzia definiuje się wspólnie, a implementuje po stronie klienta lub serwera; granicą uprawnień nadal musi być implementacja serwerowa Kiero. [Tools](https://tanstack.com/ai/latest/docs/tools/tools)

- TanStack AI rozdziela zapis rozmowy od wznowienia dostawy streamu: zapisany thread nie jest replayem aktywnego strumienia. Store dostaje samo `threadId`, a dokumentacja wprost pozostawia tenant/user authorization aplikacji. [Persistence internals](https://tanstack.com/ai/latest/docs/persistence/internals)

- `@tanstack/react-router` ma `latest` **1.170.33** ([rejestr](https://registry.npmjs.org/@tanstack%2freact-router)), a `@tanstack/react-start` **1.168.50** ([rejestr](https://registry.npmjs.org/@tanstack%2freact-start)); stan z 2026-09-08. Router ma aktualną dokumentację React. [React Router](https://tanstack.com/router/latest/docs/framework/react). Start jest nadal jawnie oznaczony jako **Release Candidate**, choć jego dokumentacja nazywa API feature-complete i stabilnym. [Start React overview](https://tanstack.com/start/latest/docs/framework/react/overview)

## Ocena dla Kiero i decyzje, które informują

1. **Jedna prawda pamięci.** Canonical ownerem muszą być transakcyjne rekordy domenowe Kiero: wiadomość źródłowa, fragment, przypisanie do firmy/projektu, ustalenie, korekta, wycofanie oraz relacje pochodzenia. Tylko serwerowa komenda domenowa może opublikować zmianę po sprawdzeniu firmy, członkostwa, aktywności źródeł i oczekiwanej rewizji. To realizuje lokalną definicję jednego oryginału wiadomości i odczytywalnych ustaleń bez ponownej interpretacji.

2. **TanStack AI nie może dostać drugiej własności historii.** Jego persistence może obsługiwać wyłącznie odtwarzalny widok czatu/runów albo być adapterem zapisującym do rekordów posiadanych przez Kiero. Nie należy równolegle uznać TanStack thread i tabel źródeł za dwa kanoniczne transkrypty. Dokumentacja nie dowodzi wspólnej transakcji persistence/durable stream z PostgreSQL ani atomowego zapisu `source + claim + outbox`; tej zgodności nie wolno dopowiadać.

3. **Effect jest opcjonalnym wykonawcą procesu, nie trwałością.** Może ujednolicić błędy i retry w jednym procesie, lecz po restarcie nie jest właścicielem prób, lease ani idempotencji. Trwały dispatcher zapisuje intencję i próby; wykonanie AI zwraca wyłącznie propozycję operacji do warunkowej publikacji.

4. **Granica schema wymaga małej próby wersji.** Dopiero po przypięciu dokładnych wersji sprawdzić: Effect `toStandardSchemaV1` oraz eksperymentalne `toStandardJSONSchemaV1` jako `outputSchema` i `toolDefinition`, z narzędziem serwerowym, oraz finalny `structured-output.complete` przy wybranym adapterze/modelu. Sprawdzić także błąd walidacji, zerwany stream i ponowienie przed publikacją. Nie ma tu jeszcze dowodu, że konkretna para Effect RC + AI 0.53 zachowa wszystkie te ścieżki.

5. **Frontend nie przesądza backendu.** TanStack Router ma publiczny klient React; Start może dać SSR i server functions, ale jego RC status jest osobnym ryzykiem adopcji. PWA ze wspólnym chatem nie wymaga samo przez się Starta. Decyzja: czy akceptujemy RC Starta po osobnej próbie, czy rozdzielamy stabilny klient React/Router od backendu.

Nie badano live voice ani Telegrama — są poza aktualnym kontraktem.
