# Fakty: ponowne połączenie i utrata kopii Google Calendar

Stan na 8 września 2026. Pięć oficjalnych stron Google, odczyt dokumentacji. Bez autoryzacji, operacji API i prób na kontach. Nota uzupełnia wcześniejsze raporty; nie zatwierdza decyzji produktu.

## Przeniesienie wpisu

Przy zmianie organizatora, na przykład przez przeniesienie wydarzenia, jeśli pierwotny organizator nie jest uczestnikiem, po stronie pierwotnego kalendarza pozostaje anulowany wpis. Gwarantowane jest tylko jego `id`. Inne szczegóły nie są pewną podstawą rozpoznania celu przeniesienia. [Google: Events](https://developers.google.com/workspace/calendar/api/v3/reference/events)

Zakres `calendar.app.created` dotyczy dodatkowych kalendarzy utworzonych przez aplikację i wydarzeń na nich. Nie daje ogólnego dostępu do wydarzeń w prywatnych kalendarzach użytkownika. **Wniosek:** nie można obiecać dalszych aktualizacji ani sprzątnięcia wpisu przeniesionego poza zarządzany kalendarz. [Google: zakresy dostępu](https://developers.google.com/workspace/calendar/api/auth)

## Ponowna zgoda i zapisany kalendarz

`calendarList.list` nie wymienia `calendar.app.created` w obsługiwanych zakresach. Lista kalendarzy wymaga osobnego zakresu listy lub szerszego dostępu. **Wniosek:** przechowywanie znanego `calendarId` pozwala projektować ponowną próbę dostępu bez odczytu całej listy. Faktyczny dostęp do kalendarza po cofnięciu i ponownej zgodzie tego samego konta trzeba sprawdzić; sam zapis ID nie gwarantuje odzyskania uprawnień. [Google: CalendarList.list](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list)

## Brak zasobu a brak uprawnień

Google dokumentuje `404 notFound` zarówno dla nieistniejącego zasobu, jak i kalendarza niedostępnego użytkownikowi. `401` oznacza nieważny lub wygasły token; dokumentacja zaleca odświeżenie i ponowną zgodę, jeśli odświeżenie zawiedzie. `500` oraz limity wymagają odpowiedniej obsługi ponowień. **Wniosek:** błąd odczytu nie jest wystarczającym dowodem usunięcia kalendarza albo osobistego ukrycia wszystkich wpisów. [Google: błędy Calendar API](https://developers.google.com/workspace/calendar/api/guides/errors)

## Konfiguracja alfy

Przy odbiorcach `External` i stanie publikacji OAuth `Testing` token odświeżania wygasa po siedmiu dniach, z wyjątkiem zgód obejmujących wyłącznie podstawowe dane tożsamości. Calendar nie mieści się w tym wyjątku. Inne przyczyny utraty dostępu pozostają możliwe także poza `Testing`; nie ma podstaw do obietnicy połączenia ważnego bezterminowo. [Google: OAuth](https://developers.google.com/identity/protocols/oauth2)

## Próby i przekazanie do architektury

- Przenieść kopię w interfejsie Google do innego kalendarza; sprawdzić reprezentację źródła i granice dostępu aplikacji.
- Cofnąć zgodę, ponownie połączyć to samo konto i sprawdzić zapisany kalendarz bez tworzenia kolejnego.
- Rozróżnić usunięcie, nieważny token, niedostępny kalendarz i przejściowy błąd bez błędnego masowego ukrywania.
- Udowodnić rozpoznawanie własnych usunięć Kiero, aby odpowiedź Google nie stawała się fałszywą decyzją użytkownika.
- Rozstrzygnąć w architekturze odzyskanie po niepewnym wyniku utworzenia kalendarza z uwzględnieniem zakresów, braku potwierdzonego ID i zakazu samoczynnego mnożenia kalendarzy. Nie zakładać dostępności `CalendarList` przy samym `app.created`.
- Sprawdzić faktyczną konfigurację OAuth alfy, w tym działanie po upływie tygodnia i ponowną zgodę po utracie dostępu.
