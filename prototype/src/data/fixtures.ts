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

export type ProjectId = "banan" | "kaczmarek";

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

export interface Task {
  id: string;
  projectId: ProjectId;
  title: string;
  state: "Do zrobienia" | "W toku" | "Wykonane";
  executor: string; // executor can be a subcontractor without a Kiero account
  coordinator: ActorId;
  due: string;
  hasChecklist?: boolean;
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
];

export const FINDINGS: Record<ProjectId, Finding[]> = {
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
  ],
};

export const TASKS: Task[] = [
  {
    id: "t1",
    projectId: "banan",
    title: "Przygotować wycenę łazienki",
    state: "Do zrobienia",
    executor: "Marek",
    coordinator: "marek",
    due: "2026-09-10",
    note: "Checklista (fuga, armatura, hydraulik) — widok w pełnym scenariuszu",
    hasChecklist: true,
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
];

export const EVENTS: WorkEvent[] = [
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
];

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
