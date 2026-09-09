# Fakty do alfy: długie nagrania i GLM-5.3-Flash

Stan na 7 września 2026. Tylko źródła pierwszej strony dostawców.

## ElevenLabs Scribe v2 (batch STT)

### Fakty udokumentowane

- Dla zwykłego nagrania (`use_multi_channel=false`) dokumentacja podaje maksymalnie **10 godzin**. Informacje o trybie wielokanałowym są niespójne: FAQ podaje łączny czas kanałów krótszy niż 10 godzin, a sekcja Key facts limit 1 godziny. Tryb wielokanałowy nie jest oceniany w tej nocie. [STT overview](https://elevenlabs.io/docs/overview/capabilities/speech-to-text/)
- Batch używa `POST /v1/speech-to-text`. Z `webhook=true` żądanie wraca bez transkrypcji, a wynik jest później wysyłany na skonfigurowany webhook; należy skonfigurować zdarzenie „Transcription completed” i publiczny HTTPS callback. [API reference](https://elevenlabs.io/docs/api-reference/speech-to-text/convert), [asynchroniczny STT](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/batch/webhooks)
- ElevenLabs samo dzieli pliki dłuższe niż 8 minut na cztery segmenty i transkrybuje je równolegle. To jest wewnętrzne przyspieszenie, a nie obietnica przyjęcia pliku ponad limit usługi. [STT overview](https://elevenlabs.io/docs/overview/capabilities/speech-to-text/)
- Obecne oficjalne dokumenty są niespójne co do limitu rozmiaru pliku: overview/FAQ podaje **do 3 GB**, a referencja tego endpointu **mniej niż 5,0 GB**. [FAQ](https://elevenlabs.io/docs/overview/capabilities/speech-to-text/), [API reference](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)

### Wniosek dla lokalnej decyzji

Przyjęte przez użytkownika założenie to brak produktowego limitu długości wiadomości głosowej. Proponowany sposób realizacji zachowuje jedno źródło widoczne dla użytkownika i przetwarza je asynchronicznie. Integracja musi respektować limit pojedynczego żądania STT; kandydatem jest dzielenie źródła ponad limit czasu lub rozmiaru z zachowaniem kolejności i spójnej transkrypcji. Do prób można przyjąć konserwatywnie najwyżej 3 GB na żądanie, dopóki dostawca nie wyjaśni rozbieżności. Nie jest to ustalony limit wiadomości w Kiero. Automatyczne dzielenie wewnątrz ElevenLabs po 8 minutach nie zastępuje obsługi limitu przyjęcia pliku. Wysyłka, zachowanie nagrania w PWA i scalanie transkrypcji wymagają osobnego sprawdzenia.

Nota nie wylicza miesięcznego kosztu. Dostawca rozlicza STT według czasu audio. [STT overview](https://elevenlabs.io/docs/overview/capabilities/speech-to-text/) Zasady budżetu alfy należą do rozstrzygnięcia [Grilling: warunki alfy, budżet i kryteria sukcesu](https://github.com/wojtekpiskorz/kiero/issues/3).

### Nierozstrzygnięte fakty

- Który z dwóch rozmiarów (3 GB lub <5 GB) jest egzekwowany produkcyjnie.
- Czy rekordowo długi plik jednokanałowy, mieszczący się w 10 godzinach, ma dodatkowe ograniczenia planu, transferu lub timeoutu nieopisane w dokumentacji.

## Z.ai: dokładna nazwa i cena

### Fakty udokumentowane

- **GLM-5.3-Flash istnieje** jako dokładna, aktualna nazwa modelu; oficjalny indeks Z.ai wymienia go jako stronę modelu. [Indeks dokumentacji Z.ai](https://docs.z.ai/llms.txt)
- Aktualny cennik API za 1 mln tokenów: input **$0,075**, cached input **$0,015**, output **$0,25**. Są to ceny promocyjne 50%; cennik wskazuje koniec promocji **9 września 2026, 24:00 UTC+8** (ceny listowe: $0,15 / $0,03 / $0,50). [Cennik Z.ai](https://docs.z.ai/guides/overview/pricing)

### Wniosek dla lokalnej decyzji

Przy pytaniu o koszt można użyć nazwy `GLM-5.3-Flash` i powyższych stawek tokenowych, ale nie traktować ich jako trwałych: promocja zaraz wygasa. Ten research nie ocenia jakości modelu ani nie porównuje go z innymi.
