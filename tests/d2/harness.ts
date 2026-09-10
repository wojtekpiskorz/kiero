/**
 * D2 test harness: a minimal in-memory emulation of the Convex database
 * surface the uploads ledger and the acceptance transaction use
 * (`normalizeId`, `get`, `insert`, `patch`, `query().withIndex()` with eq
 * chains, `first`/`collect`, and the mutation scheduler).
 *
 * It exists so tests/d2 can drive the REAL transaction functions
 * (prepare/begin/part/complete/finalize/reconcile and D1's extended
 * `performAcceptance`) without a deployment; the live proofs in
 * tests/d2/live-proof.mjs run the same functions against the real dev
 * deployment, Worker and R2 bucket.
 *
 * `withIndex` accumulates the callback's `eq(field, value)` pairs and
 * filters rows by exact field equality — the same prefix-equality semantics
 * the ledger's queries rely on. `patch` deletes keys set to undefined, like
 * Convex patches.
 */

import type { ResultEnvelope } from "@kiero/contracts";
import type { RequestContext } from "@kiero/runtime";

/** Narrows an envelope to its error (fails the test when it is ok). */
export function errorOf(envelope: ResultEnvelope) {
  if (envelope._tag !== "error") {
    throw new Error(`expected error envelope, got ${JSON.stringify(envelope)}`);
  }
  return envelope.error;
}

/** Narrows an envelope to its ok value (fails the test when it is an error). */
export function valueOf(envelope: ResultEnvelope): Record<string, unknown> {
  if (envelope._tag !== "ok") {
    throw new Error(`expected ok envelope, got ${JSON.stringify(envelope)}`);
  }
  return envelope.value as Record<string, unknown>;
}

export type Row = { _id: string } & Record<string, unknown>;

const ID_PATTERN = /^k[a-z0-9]{10,}$/;

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  // Fixed 24-char convex-shaped id: k + 4 base36 counter digits + filler.
  const counter = (idCounter % 36 ** 4).toString(36).padStart(4, "0");
  return `k${counter}${"t".repeat(19)}`;
}

/**
 * One accumulated index condition. (D5 append: `lte` with range semantics —
 * the outbox drain's by_delivery range query needs it; equality-only could
 * not express "pending with nextAttemptAtMs <= now".)
 */
interface IndexBuilder {
  eq(field: string, value: unknown): IndexBuilder;
  lte(field: string, value: unknown): IndexBuilder;
}

type IndexCondition = { readonly field: string; readonly op: "eq" | "lte"; readonly value: unknown };

class FakeQuery {
  private conditions: IndexCondition[] = [];

  constructor(private readonly rows: Row[]) {}

  withIndex(_name: string, fn: (q: IndexBuilder) => IndexBuilder): FakeQuery {
    const builder: IndexBuilder = {
      eq: (field: string, value: unknown): IndexBuilder => {
        this.conditions.push({ field, op: "eq", value });
        return builder;
      },
      lte: (field: string, value: unknown): IndexBuilder => {
        this.conditions.push({ field, op: "lte", value });
        return builder;
      },
    };
    fn(builder);
    return this;
  }

  async first(): Promise<Row | null> {
    return this.filtered()[0] ?? null;
  }

  /** The unique() Convex offers for indexes that guarantee at most one row. */
  async unique(): Promise<Row | null> {
    const rows = this.filtered();
    if (rows.length > 1) {
      throw new Error("unique(): more than one row matched");
    }
    return rows[0] ?? null;
  }

  async collect(): Promise<Row[]> {
    return this.filtered();
  }

  /** The take() Convex offers for bounded scans. */
  async take(limit: number): Promise<Row[]> {
    return this.filtered().slice(0, limit);
  }

  private filtered(): Row[] {
    return this.rows.filter((row) =>
      this.conditions.every(({ field, op, value }) => {
        if (op === "eq") {
          return row[field] === value;
        }
        const current = row[field];
        // lte over the number/string fields the ledger's range queries use.
        return (
          current !== undefined &&
          typeof current === typeof value &&
          (typeof current === "number" || typeof current === "string") &&
          current <= (value as typeof current)
        );
      }),
    );
  }
}

export class FakeDb {
  readonly tables = new Map<string, Row[]>();

  constructor(tableNames: readonly string[]) {
    for (const name of tableNames) {
      this.tables.set(name, []);
    }
  }

  normalizeId(table: string, id: string): string | null {
    if (!this.tables.has(table)) {
      return null;
    }
    return ID_PATTERN.test(id) ? id : null;
  }

  /** `get(id)` scans tables (Convex infers the table from the typed id). */
  async get(id: string): Promise<Row | null>;
  async get(table: string, id: string): Promise<Row | null>;
  async get(tableOrId: string, maybeId?: string): Promise<Row | null> {
    if (maybeId === undefined) {
      for (const rows of this.tables.values()) {
        const hit = rows.find((row) => row._id === tableOrId);
        if (hit !== undefined) {
          return hit;
        }
      }
      return null;
    }
    return this.rows(tableOrId).find((row) => row._id === maybeId) ?? null;
  }

  async insert(table: string, document: Record<string, unknown>): Promise<string> {
    const id = newId();
    this.rows(table).push({ ...document, _id: id });
    return id;
  }

  /** `patch(id, changes)` locates the row across tables like `get`. */
  async patch(id: string, patchValue: Record<string, unknown>): Promise<void>;
  async patch(table: string, id: string, patchValue: Record<string, unknown>): Promise<void>;
  async patch(
    tableOrId: string,
    idOrPatch: string | Record<string, unknown>,
    maybePatch?: Record<string, unknown>,
  ): Promise<void> {
    const [id, patchValue] =
      maybePatch === undefined
        ? [tableOrId, idOrPatch as Record<string, unknown>]
        : [idOrPatch as string, maybePatch];
    const row = await this.get(id);
    if (row === null) {
      throw new Error(`patch: no row ${id}`);
    }
    for (const [key, value] of Object.entries(patchValue)) {
      if (value === undefined) {
        delete row[key];
      } else {
        row[key] = value;
      }
    }
  }

  query(table: string): FakeQuery {
    return new FakeQuery(this.rows(table));
  }

  rows(table: string): Row[] {
    const rows = this.tables.get(table);
    if (rows === undefined) {
      throw new Error(`unknown table ${table}`);
    }
    return rows;
  }

  /**
   * `delete(id)` locates the row across tables like `get` and removes it.
   * (D5 append: the images ledger's record step deletes the in-progress
   * `processing` representation row once its successor exists.)
   */
  async delete(id: string): Promise<void> {
    for (const rows of this.tables.values()) {
      const index = rows.findIndex((row) => row._id === id);
      if (index !== -1) {
        rows.splice(index, 1);
        return;
      }
    }
    throw new Error(`delete: no row ${id}`);
  }
}

/** The mutation-transaction context shape the ledger and acceptance use. */
export interface FakeCtx {
  readonly db: FakeDb;
  /**
   * Convex Auth surface with a settable caller: tests install the fixture
   * actor's B1-style subject (`<userId>|<authSessionId>`) or null for
   * anonymous, exactly what the real ctx.auth reports.
   */
  readonly auth: {
    getUserIdentity(): Promise<{ subject: string } | null>;
    setSubject(subject: string | null): void;
  };
  readonly scheduled: { functionPath: string; args: unknown }[];
  readonly scheduler: {
    runAfter(ms: number, fn: unknown, args: unknown): Promise<void>;
  };
}

export function fakeCtx(tableNames: readonly string[]): FakeCtx {
  const scheduled: { functionPath: string; args: unknown }[] = [];
  let subject: string | null = null;
  return {
    db: new FakeDb(tableNames),
    auth: {
      getUserIdentity: async () => (subject === null ? null : { subject }),
      setSubject: (next: string | null) => {
        subject = next;
      },
    },
    scheduled,
    scheduler: {
      runAfter: async (_ms: number, fn: unknown, args: unknown) => {
        let functionPath = "scheduled-function";
        if (typeof fn === "object" && fn !== null && "_path" in fn) {
          const path = (fn as { _path: unknown })._path;
          if (typeof path === "string") {
            functionPath = path;
          }
        }
        scheduled.push({ functionPath, args });
      },
    },
  };
}

/** The fake context as the MutationCtx the transaction functions take. */
export function asTx(ctx: FakeCtx): never {
  return ctx as unknown as never;
}

/** The fake db as the reader surface session reads take. */
export function asReaderDb(ctx: FakeCtx): never {
  return ctx.db as unknown as never;
}

export const LEDGER_TABLES = [
  "companies",
  "users",
  "sessions",
  "authSessions",
  "memberships",
  "gmAccessGrants",
  "projects",
  "sources",
  "sourceProjectLinks",
  "processingRuns",
  "extractions",
  "uploads",
  "attachments",
  "mediaRepresentations",
  "outboxEvents",
  "durableJobs",
] as const;

/** A canonical actor fixture: user + company + active membership + session. */
export interface ActorFixture {
  readonly userId: string;
  readonly companyId: string;
  readonly sessionId: string;
  readonly membershipId: string;
}

export async function seedActor(
  ctx: FakeCtx,
  label: string,
): Promise<ActorFixture> {
  const userId = await ctx.db.insert("users", {
    email: `${label}@kiero.invalid`,
    displayName: label,
    createdAtMs: Date.now(),
  });
  const companyId = await ctx.db.insert("companies", {
    name: `Company ${label}`,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
    createdAtMs: Date.now(),
  });
  const membershipId = await ctx.db.insert("memberships", {
    companyId,
    userId,
    role: "admin",
    state: "active",
    createdAtMs: Date.now(),
  });
  const sessionId = await ctx.db.insert("sessions", {
    userId,
    startedAtMs: Date.now(),
    lastSeenAtMs: Date.now(),
    deviceLabel: `${label}-test`,
  });
  return { userId, companyId, sessionId, membershipId };
}

/**
 * A REAL-identity fixture: user + Convex Auth session (upstream
 * authSessions row with a future expiration) + the app session registry
 * row mirroring it + active membership — the chain B1's resolution walks.
 * Installing `ctx.auth.setSubject(...)` makes the fake ctx authenticate as
 * this actor exactly like the browser's forwarded credential would.
 */
export interface AuthedFixture extends ActorFixture {
  /** The B1-style subject for ctx.auth (`<userId>|<authSessionId>`). */
  readonly authSubject: string;
}

export async function seedAuthedActor(
  ctx: FakeCtx,
  label: string,
): Promise<AuthedFixture> {
  const fixture = await seedActor(ctx, label);
  const nowMs = Date.now();
  const authSessionId = await ctx.db.insert("authSessions", {
    userId: fixture.userId,
    expirationTime: nowMs + 60 * 60 * 1_000,
  });
  await ctx.db.patch("sessions", fixture.sessionId, { authSessionId });
  return { ...fixture, authSubject: `${fixture.userId}|${authSessionId}` };
}

/** Authenticates the fake ctx as one fixture actor (or nobody, for null). */
export function authenticateAs(ctx: FakeCtx, fixture: AuthedFixture | null): void {
  ctx.auth.setSubject(fixture === null ? null : fixture.authSubject);
}

/** The RequestContext the canonical resolution would produce for a fixture. */
export function contextFor(fixture: ActorFixture): RequestContext {
  // The branded ActorContext ids are the fixture's row ids; the cast keeps
  // the harness free of brand plumbing the transactions never read past
  // normalizeId (which validates the plain string form).
  return {
    actor: {
      userId: fixture.userId,
      companyId: fixture.companyId,
      membershipRole: "admin",
      isGm: false,
      sessionId: fixture.sessionId,
      via: "user",
    },
    resolvedAtMs: Date.now(),
  } as unknown as RequestContext;
}
