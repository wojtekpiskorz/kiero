/**
 * Polish copy for the web push settings screen (F3). CONTEXT.md terms:
 * Firma, Szef, Przypomnienie o zadaniu, Godziny ciszy. Barebones scope:
 * plain semantic text, no styling.
 */

export const notificationsCopy = {
  title: "Powiadomienia",
  intro:
    "Włącz powiadomienia push na tym urządzeniu, żeby dostawać nowe wpisy, pytania agenta i przypomnienia o zadaniach.",
  connectionUnconfigured: "Aplikacja nie ma skonfigurowanego backendu - powiadomienia są niedostępne.",
  connectionMisconfigured: "Adres backendu jest nieprawidłowy - aplikacja działa bez połączenia.",
  checkingSession: "Sprawdzamy ustawienia powiadomień…",
  sessionEndedNotice: "Sesja się zakończyła. Zaloguj się ponownie.",
  serverNotConfigured:
    "Ten serwer nie ma jeszcze skonfigurowanych kluczy push. Powiadomienia zostaną włączone po konfiguracji.",
  permissionLabel: "Uprawnienie przeglądarki",
  permissionGranted: "Udzielone",
  permissionDenied: "Odrzucone",
  permissionDefault: "Nie pytano jeszcze",
  permissionUnavailable: "To środowisko nie obsługuje powiadomień",
  permissionDeniedRecovery:
    "Uprawnienie zostało odrzucone. Możesz je przywrócić w ustawieniach przeglądarki dla tej strony (ikona zamka lub menu ustawień), a potem wrócić tutaj i włączyć powiadomienia. Aplikacja działa normalnie bez powiadomień.",
  devicesHeading: "Urządzenia z powiadomieniami",
  noDevices: "Żadne urządzenie nie ma włączonych powiadomień.",
  thisDevice: "to urządzenie",
  deviceEnabled: (label: string): string => `Włączone: ${label}`,
  deviceDisabled: (label: string): string => `Wyłączone: ${label}`,
  enableButton: "Włącz na tym urządzeniu",
  removeButton: "Usuń to urządzenie",
  enabling: "Włączamy…",
  registeredNotice: "Powiadomienia włączone na tym urządzeniu.",
  removedNotice: "Powiadomienia usunięte na tym urządzeniu.",
  deniedNotice: "Uprawnienie odrzucone. Aplikacja działa normalnie bez powiadomień.",
  unsupportedNotice: "Ta przeglądarka nie obsługuje powiadomień push.",
  removeConfirm: "Usunąć powiadomienia z tego urządzenia?",
  unexpectedFailure: "Coś się nie udało. Spróbuj ponownie.",
  privacyNote:
    "Powiadomienie pokazuje projekt lub Firmę, autora i krótki fragment. Możesz ukryć treść podglądów w ustawieniach powiadomień.",
} as const;
