// Shared synthetic dataset for all three prototype variants.
// Fictional demo material. Frozen scenario clock: Tuesday 2026-09-08, Europe/Warsaw.
// Shapes are simplified from docs/mvp/architecture-design.md (prototype only).

export type ActorId = "marek" | "piotrek" | "kiero";

export interface Actor {
  id: ActorId;
  firstName: string;
  lastName: string;
  short: string; // how bosses are shown in the conversation
  initials: string;
  role: "boss" | "agent";
}

export type ProjectId = "banan" | "kaczmarek" | "omega";

export interface Project {
  id: ProjectId;
  alias: string;
  address: string;
  scope: string;
  stage: string;
  client: string;
  openTasks: number;
}

export type Attachment =
  | {
      id: string;
      kind: "audio";
      durationSec: number;
      transcript: string;
    }
  | {
      id: string;
      kind: "photo";
      label: string; // file name
      caption: string; // what the photo shows
      hue: number; // deterministic SVG placeholder tone
      ocrText: string | null;
    };

export type SourceStatus =
  | "wysylanie"
  | "zapisano"
  | "porzadkowanie"
  | "opracowane"
  | "blad-przetwarzania";

export interface Fragment {
  id: string;
  scope: ProjectId | "firma"; // where the fragment is linked
  quote: string; // exact part of the source that grounds a finding
  basis: string; // human-readable basis, e.g. "fragment tekstu"
}

export interface FeedbackItem {
  id: string;
  text: string;
  scope: ProjectId | "firma";
}

export interface SourceMessage {
  id: string;
  authorId: ActorId;
  sentAt: string; // ISO in Europe/Warsaw, frozen clock
  text: string;
  attachments: Attachment[];
  status: SourceStatus;
  /** Concise expandable agent feedback near the source. */
  feedback: FeedbackItem[] | null;
  fragments: Fragment[];
  replyTo: { sourceId: string; preview: string } | null;
  /** Waiting for connectivity; manual "Ponów" resumes the same source. */
  waitingOffline: boolean;
  /** Agent answers cite the sources backing the finding. */
  citesSourceIds?: string[];
  /** Image extraction still running while text results are already published. */
  imagePending?: boolean;
}

export type FindingMeaning =
  | "uzgodniony"
  | "propozycja"
  | "plan wewnętrzny"
  | "faktyczne"
  | "nieokreślone";

export interface Finding {
  id: string;
  label: string;
  value: string;
  meaning: FindingMeaning | null;
  unknownNote: string | null; // explicit visible gap, e.g. tax basis not given
  sourceIds: string[]; // evidence: sources backing the current value
  corroboration?: string; // independent confirmation note
  history?: { at: string; change: string; authorId: ActorId }[];
}

export interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
}

export interface Task {
  id: string;
  projectId: ProjectId;
  title: string;
  state: "Do zrobienia" | "W toku" | "Wykonane" | "Anulowane";
  executor: string; // executor can be a subcontractor without a Kiero account
  coordinator: ActorId | null; // null → reminders go to all bosses
  due: string;
  dueTime?: string; // known hour without duration → 5-minute calendar marker
  checklistItems?: ChecklistItem[];
  note?: string;
}

export interface WorkEvent {
  id: string;
  projectId: ProjectId;
  title: string;
  when: string;
  state: "Planowane" | "Odbyte";
  linkedTaskId?: string;
}

export const COMPANY = {
  name: "MAR-PIT Usługi Budowlane",
  timezone: "Europe/Warsaw",
  currency: "PLN",
};

export const ACTORS: Record<ActorId, Actor> = {
  marek: {
    id: "marek",
    firstName: "Marek",
    lastName: "Zawada",
    short: "Marek",
    initials: "MZ",
    role: "boss",
  },
  piotrek: {
    id: "piotrek",
    firstName: "Piotr",
    lastName: "Kacprzak",
    short: "Piotrek",
    initials: "PK",
    role: "boss",
  },
  kiero: {
    id: "kiero",
    firstName: "Kiero",
    lastName: "",
    short: "Kiero",
    initials: "K",
    role: "agent",
  },
};

export const PROJECTS: Record<ProjectId, Project> = {
  banan: {
    id: "banan",
    alias: "Banan",
    address: "ul. Kraińskiego 12, Katowice",
    scope: "Remont mieszkania 68 m² — płytki i łazienka",
    stage: "Realizacja",
    client: "Bożena Nowak",
    openTasks: 1,
  },
  kaczmarek: {
    id: "kaczmarek",
    alias: "Kaczmarek",
    address: "ul. Kraińskiego 27, Katowice",
    scope: "Naprawa dachu, wymiana obróbek, montaż osłony przeciwwietrznej",
    stage: "Realizacja",
    client: "Andrzej Kaczmarek",
    openTasks: 1,
  },
  omega: {
    id: "omega",
    alias: "Omega",
    address: "ul. Sokolska 90, Katowice",
    scope: "Remont biura 40 m² — zakończony, zostały formalności",
    stage: "Zakończony",
    client: "Kancelaria Lex",
    openTasks: 1,
  },
};

export const SEED_SOURCES: SourceMessage[] = [
  {
    id: "s0",
    authorId: "marek",
    sentAt: "2026-09-03T09:10:00",
    text: "Nowa sprawa: remont mieszkania na Kraińskiego 12, klientka Bożena Nowak, 68 metrów, płytki całe mieszkanie plus łazienka do remontu. Na razie robimy wycenę. Nazwałem ją u nas „Banan”.",
    attachments: [],
    status: "opracowane",
    feedback: [
      { id: "f0a", text: "Utworzono projekt „Banan” (Kraińskiego 12)", scope: "banan" },
    ],
    fragments: [
      {
        id: "fr0",
        scope: "banan",
        quote: "remont mieszkania na Kraińskiego 12, klientka Bożena Nowak, 68 metrów",
        basis: "fragment tekstu",
      },
    ],
    replyTo: null,
    waitingOffline: false,
  },
  {
    id: "s1",
    authorId: "piotrek",
    sentAt: "2026-09-07T16:48:00",
    text: "Zdjęcia z dachu Kaczmarka, nagrywam jeszcze z góry.",
    attachments: [
      {
        id: "a1",
        kind: "audio",
        durationSec: 38,
        transcript:
          "Byłem dziś na Kraińskiego 27. Dach do naprawy — obróbki blacharskie do wymiany w całości, przy kominie trochę gnicia. Doliczyłem to do wyceny. Zdjęcia poniżej.",
      },
      {
        id: "p1",
        kind: "photo",
        label: "ZDJ_0912.jpg",
        caption: "Obróbka przy kominie",
        hue: 210,
        ocrText: null,
      },
      {
        id: "p2",
        kind: "photo",
        label: "ZDJ_0913.jpg",
        caption: "Gnicie deski przy kominie",
        hue: 28,
        ocrText: null,
      },
    ],
    status: "opracowane",
    feedback: [
      { id: "f1a", text: "Zapisano stan dachu: obróbki do wymiany, gnicie przy kominie", scope: "kaczmarek" },
    ],
    fragments: [
      {
        id: "fr1",
        scope: "kaczmarek",
        quote: "obróbki blacharskie do wymiany w całości, przy kominie trochę gnicia",
        basis: "nagranie 0:05–0:21",
      },
    ],
    replyTo: null,
    waitingOffline: false,
  },
  {
    // Mixed-project source: three fragments of one immutable message.
    id: "s2",
    authorId: "marek",
    sentAt: "2026-09-07T17:05:00",
    text: "U Kaczmarka ekipa montuje wiatrak w środę. Na Banana płytki jadą z Hurtowni Opole, dostawa w piątek do 12:00. I ogólnie: kupiłem na firmę piłę spalinową, trzeba ją ubezpieczyć.",
    attachments: [],
    status: "opracowane",
    feedback: [
      { id: "f2a", text: "Termin montażu wiatraka: środa 9.09 (uzgodniony)", scope: "kaczmarek" },
      { id: "f2b", text: "Dostawa płytek: piątek 11.09 do 12:00 (uzgodniony)", scope: "banan" },
      { id: "f2c", text: "Zakup piły spalinowej — zapisano jako wiedzę firmy", scope: "firma" },
    ],
    fragments: [
      {
        id: "fr2a",
        scope: "kaczmarek",
        quote: "ekipa montuje wiatrak w środę",
        basis: "fragment tekstu",
      },
      {
        id: "fr2b",
        scope: "banan",
        quote: "płytki jadą z Hurtowni Opole, dostawa w piątek do 12:00",
        basis: "fragment tekstu",
      },
      {
        id: "fr2c",
        scope: "firma",
        quote: "kupiłem na firmę piłę spalinową, trzeba ją ubezpieczyć",
        basis: "fragment tekstu",
      },
    ],
    replyTo: null,
    waitingOffline: false,
  },
  {
    id: "s3",
    authorId: "marek",
    sentAt: "2026-09-07T17:20:00",
    text: "Banan: z klientem umawialiśmy się na 18 tysięcy za całość robocizny.",
    attachments: [],
    status: "opracowane",
    feedback: [
      { id: "f3a", text: "Cena robocizny: 18 000 zł — zapisano; podstawa podatku niepodana", scope: "banan" },
    ],
    fragments: [
      {
        id: "fr3",
        scope: "banan",
        quote: "umawialiśmy się na 18 tysięcy za całość robocizny",
        basis: "fragment tekstu",
      },
    ],
    replyTo: null,
    waitingOffline: false,
  },
  {
    // Conflicting information — produces an open clarification, not a guess.
    id: "s7",
    authorId: "marek",
    sentAt: "2026-09-07T20:11:00",
    text: "Kaczmarek: blacharka przyjeżdża w czwartek, zamówiłem u Nowaka.",
    attachments: [],
    status: "opracowane",
    feedback: [
      { id: "f7a", text: "Dostawa blacharki: czwartek 10.09 — do potwierdzenia, Piotrek podał inny termin", scope: "kaczmarek" },
    ],
    fragments: [
      { id: "fr7", scope: "kaczmarek", quote: "blacharka przyjeżdża w czwartek", basis: "fragment tekstu" },
    ],
    replyTo: null,
    waitingOffline: false,
  },
  {
    id: "s8",
    authorId: "piotrek",
    sentAt: "2026-09-07T20:40:00",
    text: "Kaczmarek: w hurtowni mówią, że blacharka dopiero w piątek rano.",
    attachments: [],
    status: "opracowane",
    feedback: [
      { id: "f8a", text: "Sprzeczny termin dostawy blacharki — pytanie do wyjaśnienia", scope: "kaczmarek" },
    ],
    fragments: [
      { id: "fr8", scope: "kaczmarek", quote: "blacharka dopiero w piątek rano", basis: "fragment tekstu" },
    ],
    replyTo: { sourceId: "s7", preview: "Kaczmarek: blacharka przyjeżdża w czwartek…" },
    waitingOffline: false,
  },
  {
    id: "s4",
    authorId: "piotrek",
    sentAt: "2026-09-08T07:58:00",
    text: "Dobra, z ekipą potwierdziłem środę na wiatraka.",
    attachments: [],
    status: "opracowane",
    feedback: [
      { id: "f4a", text: "Niezależne potwierdzenie terminu montażu (Kaczmarek)", scope: "kaczmarek" },
    ],
    fragments: [
      {
        id: "fr4",
        scope: "kaczmarek",
        quote: "z ekipą potwierdziłem środę na wiatraka",
        basis: "fragment tekstu",
      },
    ],
    replyTo: { sourceId: "s2", preview: "U Kaczmarka ekipa montuje wiatrak w środę…" },
    waitingOffline: false,
  },
  {
    // Full agent bubble: clarification question about an ambiguous amount.
    id: "s5",
    authorId: "kiero",
    sentAt: "2026-09-08T08:15:00",
    text: "Wczoraj zapisałem cenę robocizny dla projektu Banan: 18 000 zł. Nie podałeś podstawy podatku — chodzi o kwotę netto czy brutto?",
    attachments: [],
    status: "opracowane",
    feedback: null,
    fragments: [],
    replyTo: { sourceId: "s3", preview: "Banan: z klientem umawialiśmy się na 18 tysięcy…" },
    waitingOffline: false,
  },
  {
    id: "s6",
    authorId: "marek",
    sentAt: "2026-09-08T08:22:00",
    text: "Jadę teraz na Kaczmarka, jak co dzwońcie.",
    attachments: [],
    status: "opracowane",
    feedback: [], // no memory changes: ordinary chatter stays in the conversation
    fragments: [],
    replyTo: null,
    waitingOffline: false,
  },
  {
    // Photo with OCR text — discoverable through search.
    id: "s9",
    authorId: "piotrek",
    sentAt: "2026-09-08T08:31:00",
    text: "Faktura za piłę spalinową, do ubezpieczenia i księgowości.",
    attachments: [
      {
        id: "p9",
        kind: "photo",
        label: "IMG_4481.jpg",
        caption: "Faktura — piła spalinowa",
        hue: 120,
        ocrText: "FAKTURA VAT nr 128/09/2026 — Stihl MS 211 — razem 2 149,00 zł netto, 2 643,27 zł brutto",
      },
    ],
    status: "opracowane",
    feedback: [
      { id: "f9a", text: "Odczytano fakturę: 2 643,27 zł brutto — zapisano jako wiedzę firmy", scope: "firma" },
    ],
    fragments: [
      { id: "fr9", scope: "firma", quote: "obszar zdjęcia (OCR)", basis: "obszar zdjęcia" },
    ],
    replyTo: null,
    waitingOffline: false,
  },
  {
    // Full agent bubble: clarification about the contradictory delivery date.
    id: "s10",
    authorId: "kiero",
    sentAt: "2026-09-08T08:44:00",
    text: "Blacharka dla Kaczmarka: Marek napisał wczoraj „czwartek”, Piotrek godzinę później „piątek rano”. Który termin dostawy obowiązuje?",
    attachments: [],
    status: "opracowane",
    feedback: null,
    fragments: [],
    replyTo: { sourceId: "s8", preview: "Kaczmarek: w hurtowni mówią, że blacharka dopiero…" },
    citesSourceIds: ["s7", "s8"],
    waitingOffline: false,
  },
];

export const SEED_FINDINGS: Record<ProjectId, Finding[]> = {
  banan: [
    {
      id: "fd1",
      label: "Klient",
      value: "Bożena Nowak",
      meaning: null,
      unknownNote: null,
      sourceIds: ["s0"],
    },
    {
      id: "fd2",
      label: "Lokalizacja",
      value: "ul. Kraińskiego 12, Katowice",
      meaning: null,
      unknownNote: null,
      sourceIds: ["s0"],
    },
    {
      id: "fd3",
      label: "Zakres",
      value: "Remont mieszkania 68 m² — płytki całe mieszkanie, łazienka",
      meaning: null,
      unknownNote: null,
      sourceIds: ["s0"],
    },
    {
      id: "fd4",
      label: "Cena robocizny",
      value: "18 000 zł",
      meaning: "uzgodniony",
      unknownNote: "podstawa podatku: nie podano",
      sourceIds: ["s3"],
    },
    {
      id: "fd5",
      label: "Dostawa płytek",
      value: "piątek 11.09.2026, do 12:00",
      meaning: "uzgodniony",
      unknownNote: null,
      sourceIds: ["s2"],
    },
  ],
  kaczmarek: [
    {
      id: "fd6",
      label: "Klient",
      value: "Andrzej Kaczmarek",
      meaning: null,
      unknownNote: null,
      sourceIds: [],
    },
    {
      id: "fd7",
      label: "Lokalizacja",
      value: "ul. Kraińskiego 27, Katowice",
      meaning: null,
      unknownNote: null,
      sourceIds: [],
    },
    {
      id: "fd8",
      label: "Stan dachu",
      value: "Obróbki blacharskie do wymiany w całości, gnicie przy kominie",
      meaning: null,
      unknownNote: null,
      sourceIds: ["s1"],
    },
    {
      id: "fd9",
      label: "Montaż osłony przeciwwietrznej",
      value: "środa 9.09.2026",
      meaning: "uzgodniony",
      unknownNote: null,
      sourceIds: ["s2", "s4"],
      corroboration: "potwierdzone niezależnie przez Piotrka 8.09",
    },
    {
      id: "fd10",
      label: "Wycena naprawy dachu",
      value: "12 000–14 000 zł",
      meaning: "propozycja",
      unknownNote: null,
      sourceIds: ["s1"],
      history: [],
    },
    {
      id: "fd11",
      label: "Dostawa blacharki",
      value: "nierozstrzygnięte: czwartek 10.09 (Marek) / piątek 11.09 (Piotrek)",
      meaning: null,
      unknownNote: "sprzeczność — oczekuje na odpowiedź szefa",
      sourceIds: ["s7", "s8"],
    },
  ],
  omega: [
    {
      id: "fd12",
      label: "Klient",
      value: "Kancelaria Lex",
      meaning: null,
      unknownNote: null,
      sourceIds: [],
    },
    {
      id: "fd13",
      label: "Lokalizacja",
      value: "ul. Sokolska 90, Katowice",
      meaning: null,
      unknownNote: null,
      sourceIds: [],
    },
  ],
};

export const SEED_TASKS: Task[] = [
  {
    id: "t1",
    projectId: "banan",
    title: "Przygotować wycenę łazienki",
    state: "Do zrobienia",
    executor: "Marek",
    coordinator: "marek",
    due: "2026-09-10",
    checklistItems: [
      { id: "c1", label: "Policzyć metraż fugi i płytek", done: true },
      { id: "c2", label: "Zapytać hydraulika o armaturę", done: false },
      { id: "c3", label: "Ująć koszt wynajmu przecinarki", done: false },
    ],
  },
  {
    id: "t2",
    projectId: "kaczmarek",
    title: "Dokończyć wycenę z obróbkami",
    state: "W toku",
    executor: "Piotrek",
    coordinator: "piotrek",
    due: "2026-09-11",
  },
  {
    id: "t3",
    projectId: "kaczmarek",
    title: "Odbiór dachu z ekipą",
    state: "Do zrobienia",
    executor: "Ekipa Dach-Master (podwykonawca)",
    coordinator: "marek",
    due: "2026-09-09",
    dueTime: "14:00",
    note: "znana godzina bez czasu trwania — w Google jako znacznik 5 minut",
  },
  {
    // Open obligation on a closed project; no coordinator → all bosses.
    id: "t4",
    projectId: "omega",
    title: "Oddać klucze i protokół klientowi",
    state: "Do zrobienia",
    executor: "Marek",
    coordinator: null,
    due: "2026-09-01",
    note: "projekt zakończony; zadanie po terminie; brak koordynatora — przypomnienia do obu szefów",
  },
];

export const SEED_EVENTS: WorkEvent[] = [
  {
    id: "e1",
    projectId: "banan",
    title: "Dostawa płytek (Hurtownia Opole)",
    when: "piątek 11.09.2026, do 12:00",
    state: "Planowane",
  },
  {
    id: "e2",
    projectId: "kaczmarek",
    title: "Montaż osłony przeciwwietrznej",
    when: "środa 9.09.2026",
    state: "Planowane",
  },
  {
    id: "e3",
    projectId: "omega",
    title: "Odbiór końcowy z klientem",
    when: "wtorek 1.09.2026",
    state: "Planowane",
  },
];

export interface Clarification {
  id: string;
  kind: "tax" | "date-conflict";
  questionSourceId: string; // the agent bubble asking the question
  projectId?: ProjectId;
  findingId?: string; // finding this resolves when answered
  status: "open" | "resolved";
  answer?: string;
  answeredBy?: ActorId;
}

export const SEED_CLARIFICATIONS: Clarification[] = [
  {
    id: "q1",
    kind: "tax",
    questionSourceId: "s5",
    projectId: "banan",
    findingId: "fd4",
    status: "open",
  },
  {
    id: "q2",
    kind: "date-conflict",
    questionSourceId: "s10",
    projectId: "kaczmarek",
    findingId: "fd11",
    status: "open",
  },
];

export type CalendarCopyStatus = "zapisano" | "oczekuje" | "blad" | "ukryte-osobiscie";

export interface CalendarCopy {
  id: string;
  entity: "task" | "event";
  refId: string;
  title: string;
  when: string;
  marker5: boolean; // hour without known duration → five-minute marker
  status: CalendarCopyStatus;
  hiddenByActor: ActorId[];
}

export interface CalendarState {
  connected: boolean;
  attention: boolean; // connection needs attention (re-auth)
  scopes: Record<ProjectId, boolean>;
  copies: CalendarCopy[];
}

export const SEED_CALENDAR: CalendarState = {
  connected: true,
  attention: true,
  scopes: { banan: true, kaczmarek: true, omega: false },
  copies: [
    {
      id: "cc1",
      entity: "event",
      refId: "e1",
      title: "Dostawa płytek — Banan",
      when: "pt 11.09, 12:00",
      marker5: true,
      status: "oczekuje",
      hiddenByActor: [],
    },
    {
      id: "cc2",
      entity: "event",
      refId: "e2",
      title: "Montaż osłony — Kaczmarek",
      when: "śr 9.09 (cały dzień)",
      marker5: false,
      status: "zapisano",
      hiddenByActor: [],
    },
    {
      id: "cc3",
      entity: "task",
      refId: "t1",
      title: "Wycena łazienki — Banan (zadanie)",
      when: "czw 10.09 (cały dzień)",
      marker5: false,
      status: "blad",
      hiddenByActor: [],
    },
    {
      id: "cc4",
      entity: "task",
      refId: "t3",
      title: "Odbiór dachu — Kaczmarek (zadanie)",
      when: "śr 9.09, 14:00",
      marker5: true,
      status: "zapisano",
      hiddenByActor: ["piotrek"], // personal hide
    },
  ],
};

export interface NotificationPrefs {
  conversationMuted: boolean; // mute the shared conversation for this boss
  reminderMuted: boolean; // mute task reminders only
  snoozeUntil: string | null; // personal reminder snooze for one task
}

export const SEED_NOTIF: Record<ActorId, NotificationPrefs> = {
  marek: { conversationMuted: false, reminderMuted: false, snoozeUntil: null },
  piotrek: { conversationMuted: false, reminderMuted: true, snoozeUntil: "2026-09-09T08:00" },
  kiero: { conversationMuted: false, reminderMuted: false, snoozeUntil: null },
};

/** Which sources each boss has already seen (per-user read state). */
export const SEED_READ_BY: Record<string, ActorId[]> = {
  s0: ["marek", "piotrek"],
  s1: ["marek", "piotrek"],
  s2: ["marek", "piotrek"],
  s3: ["marek"],
  s4: ["marek"],
  s5: ["marek"],
  s6: ["marek"],
};

export const TODAY_ISO = "2026-09-08";

export function frozenNow(minuteOffset = 0): string {
  // New demo sources land on the frozen morning clock, minutes past 09:00.
  const m = 1 + minuteOffset;
  const mm = String(m).padStart(2, "0");
  return `2026-09-08T09:${mm}:00`;
}
