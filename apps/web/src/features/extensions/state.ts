/**
 * Extensions feature state (H2): Polish copy, the field-kind vocabulary
 * rendered from the contract's closed sets, the stable-field-id derivation
 * and the closed-error hints for the /dodatkowe surface.
 *
 * The kind labels are typed by the contract's exported kind arrays
 * (SCALAR_FIELD_KINDS / DEFINITION_FIELD_KINDS), so a vocabulary change
 * fails the build instead of rendering a raw machine kind. The field-id
 * derivation folds Polish diacritics exactly like the catalog's stable-key
 * rule (packages/domain/extensions/catalog.ts): a boss types a Polish
 * label, the surface proposes the stable id, and the boss may adjust it
 * before the definition is created (ids outlive label changes).
 */

import {
  DEFINITION_FIELD_KINDS,
  SCALAR_FIELD_KINDS,
  type DefinitionFieldKind,
  type ScalarFieldKind,
} from "@kiero/contracts";
import { sessionFailureHints } from "../conversation/state";

// ---------------------------------------------------------------------------
// Kind vocabulary (Polish, typed by the contract's closed sets)
// ---------------------------------------------------------------------------

/** Polish labels of every field kind a definition version may declare. */
export const fieldKindLabels: Record<DefinitionFieldKind, string> = {
  text: "tekst",
  quantity: "ilość",
  boolean: "tak/nie",
  enum: "wybór z opcji",
  financial: "kwota",
  temporal: "termin lub data",
  entity_ref: "odwołanie",
  list: "lista",
};

/** Polish labels of every scalar item kind (list members, object fields). */
export const scalarKindLabels: Record<ScalarFieldKind, string> = {
  text: "tekst",
  quantity: "ilość",
  boolean: "tak/nie",
  enum: "wybór z opcji",
  financial: "kwota",
  temporal: "termin lub data",
  entity_ref: "odwołanie",
};

/** The kinds the define-form's kind select offers, in a stable order. */
export const definitionFieldKindOrder = DEFINITION_FIELD_KINDS;

/** The scalar kinds a list field may declare as its item kind. */
export const scalarFieldKindOrder = SCALAR_FIELD_KINDS;

/** Polish labels of the entity-reference kinds an entity_ref may carry. */
export const entityRefKindLabels = {
  project: "projekt",
  task: "zadanie",
  event: "zdarzenie",
  contact: "kontakt",
  source: "wiadomość źródłowa",
} as const;

// ---------------------------------------------------------------------------
// Stable field-id derivation (Polish-aware, one home)
// ---------------------------------------------------------------------------

/** Polish diacritics fold, shared shape with the catalog's stable-key rule. */
const DIACRITICS: Readonly<Record<string, string>> = {
  ą: "a",
  ć: "c",
  ę: "e",
  ł: "l",
  ń: "n",
  ó: "o",
  ś: "s",
  ź: "z",
  ż: "z",
};

/**
 * Derives a stable field id from a Polish label: lowercase, diacritics
 * folded, every non-alphanumeric run collapsed to one underscore. A label
 * that yields nothing usable (or starts with a digit) keeps the boss's
 * explicit id as the authority; the derivation only PROPOSES.
 */
export function deriveFieldId(label: string): string {
  const folded = label
    .toLowerCase()
    .split("")
    .map((character) => DIACRITICS[character] ?? character)
    .join("");
  const candidate = folded
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  if (candidate.length === 0 || /^[0-9]/.test(candidate)) {
    return "";
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Polish copy (stable product text)
// ---------------------------------------------------------------------------

/** Copy for the /dodatkowe surface (the typed-extension screens). */
export const extensionsCopy = {
  title: "Dodatkowe informacje",
  intro:
    "Katalog definicji dodatkowych informacji: wspólny dla wszystkich firm i właściwy dla Twojej. Definicja to opis struktury; zapisane wartości to ustalenia z własnymi źródłami i historią zmian.",
  // Catalog search
  searchHeading: "Przeszukaj katalog",
  searchIntro:
    "Zanim zdefiniujesz nową informację, sprawdź katalog: definicja o zbliżonej nazwie i zgodnej strukturze nadaje się do ponownego użycia.",
  searchNameLabel: "Nazwa",
  searchNamePlaceholder: "np. Grubość płytki",
  searchSubmit: "Szukaj w katalogu",
  searchSearching: "Szukanie…",
  noneOption: "(brak)",
  noCandidates: "Brak kandydatów o zbliżonej nazwie.",
  catalogHeading: "Kandydaci katalogu",
  sharedMark: "definicja wspólna",
  ownMark: "definicja firmy",
  versionLabel: (version: number): string => `wersja ${version}`,
  usageLabel: (count: number, last: string | null): string =>
    last === null
      ? `wykorzystana ${count} raz(y)`
      : `wykorzystana ${count} raz(y), ostatnio ${last}`,
  verdictLabels: {
    reuse_candidate: "nadaje się do ponownego użycia",
    name_conflict: "nazwa zajęta przez inną strukturę",
    distinct: "odrębna definicja",
  } as const,
  fieldsHeading: "Pola definicji",
  fieldIdLabel: (fieldId: string): string => `id pola: ${fieldId}`,
  fieldKindOf: (kind: DefinitionFieldKind): string => `rodzaj: ${fieldKindLabels[kind]}`,
  fieldUnitOf: (unit: string): string => `jednostka: ${unit}`,
  fieldItemKindOf: (itemKind: ScalarFieldKind): string => `elementy: ${scalarKindLabels[itemKind]}`,
  fieldOptionsOf: (options: readonly string[]): string => `opcje: ${options.join(", ")}`,
  // Define
  defineHeading: "Zdefiniuj nową informację",
  defineIntro:
    "Zmiana znaczenia lub rodzaju pola tworzy nową wersję, zachowując interpretację wcześniejszych danych. Identyfikatory pól są trwałe: etykiety mogą się zmieniać, identyfikatory nie.",
  defineNameLabel: "Nazwa definicji",
  defineFieldsLabel: "Pola definicji",
  defineAddField: "Dodaj pole",
  defineRemoveField: "Usuń pole",
  defineFieldLabelLabel: "Etykieta pola (polska)",
  defineFieldIdLabel: "Identyfikator pola (trwały)",
  defineFieldKindLabel: "Rodzaj pola",
  defineFieldUnitLabel: "Jednostka (dla ilości)",
  defineFieldItemKindLabel: "Rodzaj elementów (dla listy)",
  defineFieldOptionsLabel: "Opcje (dla wyboru), format: id:etykieta, po jednej w wierszu",
  defineSubmit: "Zdefiniuj",
  defineCreated: "Definicja zapisana.",
  defineReused: "Istniejąca definicja nadaje się do ponownego użycia.",
  // Version
  versionHeading: "Nowa wersja definicji",
  versionIntro:
    "Dodanie pola albo zmiana etykiety to wersja zgodna. Usunięcie pola, zmiana rodzaju, jednostki lub usunięcie opcji wymaga nowej definicji.",
  versionDefinitionLabel: "Definicja (z kandydatów katalogu)",
  versionNoteLabel: "Opis zmiany",
  versionNotePlaceholder: "np. dodano pole uwagi",
  versionSubmit: "Zapisz nową wersję",
  versionSaved: (version: number): string => `Wersja ${version} zapisana.`,
  // Value recording
  valueHeading: "Zapisz dodatkową informację",
  valueIntro:
    "Wartość zapisujemy jako ustalenie z podstawą: Twoja wypowiedź poniżej staje się wiadomością źródłową, a wartość przechodzi przez te same sprawdzone operacje pamięci co zmiany agenta.",
  valueStatementLabel: "Twoja wypowiedź (podstawa ustalenia)",
  valueStatementPlaceholder: "np. Płytki mają 8 mm grubości.",
  valueScopeLabel: "Zakres",
  valueScopeCompany: "wiedza firmy",
  valueKeyLabel: "Klucz ustalenia (np. grubosc_plytki)",
  valueDefinitionLabel: "Definicja i wersja (z kandydatów katalogu)",
  valueValidate: "Sprawdź wartość",
  valueValidated: "Wartość zgodna z definicją.",
  valueSubmit: "Zapisz ustalenie",
  valueSaved: "Dodatkowa informacja zapisana.",
  // Correction
  correctHeading: "Korekta dodatkowej informacji",
  correctIntro:
    "Zapisuje nowe rozstrzygnięcie z autorem, czasem i powodem. Poprzednia wartość zostaje w historii; nowa wartość może odwoływać się do nowszej wersji definicji.",
  correctFindingLabel: "Ustalenie (obecne wartości dodatkowe)",
  correctReasonLabel: "Powód korekty",
  correctReasonPlaceholder: "np. Klient zmienił grubość płytki.",
  correctSubmit: "Zapisz korektę",
  corrected: "Korekta zapisana. Historia zachowana.",
  noExtensionFindings: "Brak ustaleń dodatkowych w tym zakresie.",
} as const;

// ---------------------------------------------------------------------------
// Closed-error hints (load-bearing codes only; the server message shows else)
// ---------------------------------------------------------------------------

/** Extra Polish hints for the closed-error codes this surface can meet. */
const codeHints: Record<string, string> = {
  ...sessionFailureHints,
  extension_definition_name_conflict:
    "Definicja o tej nazwie istnieje, ale ma inną strukturę. Zmień nazwę albo użyj istniejącej definicji.",
  extension_definition_corrupt: "Definicja jest uszkodzona (brak aktualnej wersji). Zgłoś to odpowiedzialnemu za system.",
  definition_without_fields: "Definicja musi mieć co najmniej jedno pole.",
  definition_fields_exceeded: "Za dużo pól w jednej definicji.",
  duplicate_field_id: "Dwa pola z tym samym trwałym identyfikatorem.",
  quantity_field_without_unit: "Pole ilości wymaga jednostki.",
  unit_on_non_quantity_field: "Jednostkę ma tylko pole ilości.",
  list_field_requires_scalar_item_kind: "Lista wymaga rodzaju elementów (jednego rodzaju prostego).",
  item_kind_on_non_list_field: "Rodzaj elementów ma tylko pole listy.",
  enum_field_without_options: "Pole wyboru wymaga co najmniej jednej opcji.",
  enum_options_exceeded: "Za dużo opcji pola wyboru.",
  duplicate_enum_option_id: "Dwie opcje z tym samym identyfikatorem.",
  options_on_non_enum_field: "Opcje ma tylko pole wyboru.",
  field_kind_object_forbidden: "Pole obiektu nie jest dozwolone: wiele pól definicji samo jest obiektem.",
  field_kind_unknown: "Nieznany rodzaj pola.",
  version_not_next: "Nowa wersja musi następować po aktualnej.",
  version_incompatible: "Ta zmiana zmienia znaczenie istniejących danych; użyj nowej definicji.",
  field_removed: "Usunięcie pola zmienia znaczenie danych; to nowa definicja, nie wersja.",
  field_kind_changed: "Zmiana rodzaju pola zmienia znaczenie danych; to nowa definicja.",
  field_unit_changed: "Zmiana jednostki zmienia znaczenie danych; to nowa definicja.",
  field_item_kind_changed: "Zmiana rodzaju elementów zmienia znaczenie danych; to nowa definicja.",
  enum_option_removed: "Usunięcie opcji zmienia znaczenie danych; to nowa definicja.",
  version_not_found: "Nie ma takiej wersji definicji.",
  definition_not_found: "Nie ma takiej definicji.",
  value_kind_mismatch: "Wartość nie pasuje do rodzaju pola.",
  value_unit_mismatch: "Jednostka wartości nie zgadza się z definicją pola.",
  value_unit_required: "Pole ilości wymaga jednostki.",
  enum_option_unknown: "Wybrana opcja nie należy do tego pola wyboru.",
  value_field_unknown: "Przypisano pole, którego nie ma w tej wersji definicji.",
  value_field_missing: "Brakuje wartości pola wymaganego przez wersję.",
  value_shape_mismatch: "Kształt wartości nie pasuje do definicji (jedno pole przyjmuje wartość bezpośrednio; wiele pól przyjmuje obiekt).",
  list_item_kind_mismatch: "Element listy ma inny rodzaj niż deklaruje pole.",
  list_items_exceeded: "Za dużo elementów listy.",
  object_fields_exceeded: "Za dużo pól w wartości.",
  entity_reference_malformed: "Odwołanie jest uszkodzone.",
  entity_reference_not_in_company: "Odwołanie wskazuje poza firmę.",
  input_amount_invalid: "Kwota musi być liczbą, np. 1250.50.",
  input_day_invalid: "Data musi mieć format RRRR-MM-DD.",
  input_month_invalid: "Miesiąc musi mieć format RRRR-MM.",
  input_year_invalid: "Rok musi mieć format RRRR.",
  input_field_id_invalid:
    "Identyfikator pola: małe litery, cyfry i podkreślenia, zaczyna się od litery (do 64 znaków).",
  input_option_invalid: "Każda opcja musi mieć format id:etykieta.",
  input_required: "Uzupełnij wymagane pola.",
  existing_finding_requires_finding_id: "Ustalenie o tym kluczu już istnieje; użyj korekty.",
  finding_id_semantic_key_mismatch: "Klucz nie zgadza się z wybranym ustaleniem.",
  revision_mismatch: "Ustalenie zmieniło się w międzyczasie. Odśwież i spróbuj ponownie.",
  source_not_active: "Wiadomość wycofana nie może być podstawą nowego ustalenia.",
};

/** The Polish hint for a closed-error code, or the server message. */
export function failureHint(code: string | undefined, serverMessage: string): string {
  if (code === undefined) {
    return serverMessage;
  }
  return codeHints[code] ?? serverMessage;
}
