# Fakty: zaproszenia e-mail i łączenie tożsamości

Stan na 7 września 2026. Tylko źródła pierwszej strony. Ta nota nie ratyfikuje decyzji ani nie wybiera dostawcy tożsamości.

## Fakty udokumentowane

- Po walidacji tokenu ID Google wskazuje dwa przypadki, gdy jest autorytatywne dla adresu: adres ma końcówkę `@gmail.com` albo `email_verified=true` i występuje `hd` (konto Google Workspace). Wtedy użytkownik jest znanym, prawowitym właścicielem konta. [Google: weryfikacja tokenu ID](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- Gdy adres nie jest `@gmail.com` i brak `hd`, Google nie jest autorytatywne, także gdy `email_verified=true`: Google mogło zweryfikować adres przy założeniu konta, lecz właściciel zewnętrznej skrzynki mógł się później zmienić. Google zaleca hasło lub inne dodatkowe wyzwanie. Ta sama dokumentacja nakazuje użyć `sub`, a nie e-maila, jako trwałego identyfikatora konta Google.
- Auth0 ostrzega, że niebezpieczne linkowanie umożliwia przejęcie konta, i zaleca przed linkowaniem ręcznym lub automatycznym uwierzytelnić oba konta; w ręcznym linkowaniu prosić użytkownika o poświadczenia. To zalecenie Auth0, nie wymóg ani wybór dostawcy dla Kiero. [Auth0: User Account Linking](https://auth0.com/docs/manage-users/user-accounts/user-account-linking)

## Wniosek dla proponowanej polityki Kiero

Zaproszenie przypisane do konkretnego e-maila może zostać zaakceptowane przez Google bez osobnego kodu tylko w dwóch opisanych przez Google przypadkach. Dla nie-Gmaila bez `hd` akceptacja powinna wymagać kodu jednorazowego wysłanego na zaproszony adres; zgodność samego `email_verified` nie wystarcza.

Łączenie logowania Google z logowaniem kodem e-mail nie powinno następować automatycznie po równości adresu. Kandydat polityki: przed połączeniem użytkownik potwierdza kontrolę obu tożsamości, a system zapisuje stabilne `sub` Google osobno od adresu e-mail. Sama obecność aktywnej sesji nie zastępuje wymaganego potwierdzenia. Wymagany poziom świeżości dowodu, UX i wyjątki wymagają osobnej decyzji.
