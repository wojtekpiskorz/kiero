/**
 * B1/R11 in-process boundary harness: drives the REAL installed auth
 * stack (the app's `convex/access/identity/authEntry.ts` construction on
 * top of the pinned @convex-dev/auth + @auth/core) without a Convex
 * deployment.
 *
 * What is REAL here: the app's auth entry module (its providers, OTP
 * generator, send adapter, `createOrUpdateUser` policy and session
 * config), @convex-dev/auth's store mutations and HTTP actions, the
 * Google provider from @auth/core, oauth4webapi's PKCE/OIDC validation
 * and the RS256 session token minted by the library.
 *
 * What is TEST FIXTURE (self-generated, never real credentials): the
 * Convex platform context (an in-memory store fake mirroring the
 * narrowed-surface idiom of tests/b1/cores.test.ts) and the network
 * (discovery/JWKS/token/Resend endpoints answered locally, with the
 * OAuth checks Google itself would enforce — redirect_uri, client
 * credentials and the S256 PKCE challenge — verified by the stub).
 */

import {
  createHash,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  type JsonWebKey,
} from "node:crypto";

/** base64url of a UTF-8 string (JWT encoding, no padding). */
export function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** Signs a fixture JWT the way the stack's RS256 paths do (no library
 * shortcut: raw node:crypto, so the signature check is independent of
 * the code under test). */
export function signRs256(privateKeyPem: string, payload: object): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${signer.sign(privateKeyPem).toString("base64url")}`;
}

/** Verifies a token against a public JWK; throws on any mismatch. */
export function verifyRs256(publicJwk: JsonWebKey, token: string): Record<string, unknown> {
  const [header, body, signature] = token.split(".");
  if (header === undefined || body === undefined || signature === undefined) {
    throw new Error("malformed fixture token");
  }
  const key = createPublicKey({ key: publicJwk, format: "jwk" });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${body}`);
  if (!verifier.verify(key, Buffer.from(signature, "base64url"))) {
    throw new Error("fixture token signature mismatch");
  }
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** RFC 7636 S256 code challenge of a verifier (what the token stub checks). */
export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export interface RsaFixture {
  readonly privateKeyPem: string;
  readonly publicJwk: JsonWebKey;
}

/** Self-generated RSA keypair (fixture; not a credential of any system). */
export function rsaFixture(): RsaFixture {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicJwk: publicKey.export({ format: "jwk" }) as JsonWebKey,
  };
}

type Row = Record<string, unknown> & { _id: string; _creationTime: number };

/**
 * Id prefixes per table (the fake's own minting; only internal
 * consistency matters, not the real Convex encodings).
 */
const TABLE_ID_PREFIX: Record<string, string> = {
  users: "k57",
  sessions: "rd7",
  authSessions: "js7",
  authAccounts: "oy7",
  authVerificationCodes: "cd7",
  authVerifiers: "kh7",
  authRefreshTokens: "gk7",
  authRateLimits: "kr7",
  linkAttempts: "la7",
};

interface Constraint {
  readonly field: string;
  readonly value: unknown;
  readonly op: "eq" | "neq";
}

/** The convex filter-builder surface used by the library and the app
 * callback (q.field/q.eq/q.neq; predicates record themselves as side
 * effects — the callback's return value is not read). */
interface FilterApi {
  field(name: string): { field: string };
  eq(ref: unknown, value: unknown): void;
  neq(ref: unknown, value: unknown): void;
}

/** Scan-based stand-in for the indexed/filtered query surface the
 * library and the app callback use (withIndex chains eq; filter
 * predicates record themselves via the builder). */
class MemoryQuery {
  private readonly constraints: Constraint[] = [];

  constructor(
    private readonly rows: readonly Row[],
    private readonly indexName: string | null,
  ) {}

  withIndex(_name: string, cb?: (q: IndexBuilder) => IndexBuilder): MemoryQuery {
    if (cb !== undefined) {
      cb(new IndexBuilder(this.constraints));
    }
    return this;
  }

  filter(cb: (q: FilterApi) => void): MemoryQuery {
    cb({
      field: (name: string) => ({ field: name }),
      eq: (ref: unknown, value: unknown) => {
        this.constraints.push({ field: fieldOf(ref), value, op: "eq" });
      },
      neq: (ref: unknown, value: unknown) => {
        this.constraints.push({ field: fieldOf(ref), value, op: "neq" });
      },
    });
    return this;
  }

  private matches(row: Row): boolean {
    return this.constraints.every((c) =>
      c.op === "eq"
        ? row[c.field] === c.value
        : row[c.field] !== c.value,
    );
  }

  async unique(): Promise<Row | null> {
    const found = this.rows.filter((r) => this.matches(r));
    if (found.length > 1) {
      throw new Error(`non-unique result for ${this.indexName ?? "filter"} query`);
    }
    return found[0] ?? null;
  }

  async first(): Promise<Row | null> {
    return this.rows.find((r) => this.matches(r)) ?? null;
  }

  async take(n: number): Promise<Row[]> {
    return this.rows.filter((r) => this.matches(r)).slice(0, n);
  }

  async collect(): Promise<Row[]> {
    return this.rows.filter((r) => this.matches(r));
  }
}

class IndexBuilder {
  constructor(private readonly constraints: Constraint[]) {}
  eq(field: string, value: unknown): IndexBuilder {
    this.constraints.push({ field, value, op: "eq" });
    return this;
  }
}

function fieldOf(ref: unknown): string {
  if (typeof ref === "string") return ref;
  if (typeof ref === "object" && ref !== null && "field" in ref) {
    return String((ref as { field: unknown }).field);
  }
  throw new Error("unsupported fixture query reference");
}

/** In-memory Convex store fake (the platform half of the boundary). */
export class MemoryDb {
  private readonly tables = new Map<string, Map<string, Row>>();
  private readonly counters = new Map<string, number>();

  private table(name: string): Map<string, Row> {
    let t = this.tables.get(name);
    if (t === undefined) {
      t = new Map();
      this.tables.set(name, t);
    }
    return t;
  }

  insert(name: string, doc: Record<string, unknown>): string {
    const prefix = TABLE_ID_PREFIX[name] ?? "fx7";
    const n = (this.counters.get(name) ?? 0) + 1;
    this.counters.set(name, n);
    const id = `${prefix}${String(n).padStart(10, "0")}`;
    this.table(name).set(id, { ...doc, _id: id, _creationTime: Date.now() });
    return id;
  }

  get(id: string): Row | null {
    for (const t of this.tables.values()) {
      const row = t.get(id);
      if (row !== undefined) return row;
    }
    return null;
  }

  patch(id: string, patch: Record<string, unknown>): void {
    for (const t of this.tables.values()) {
      const row = t.get(id);
      if (row !== undefined) {
        t.set(id, { ...row, ...patch });
        return;
      }
    }
    throw new Error(`fixture patch: no row ${id}`);
  }

  delete(id: string): void {
    for (const t of this.tables.values()) {
      if (t.delete(id)) return;
    }
  }

  normalizeId(table: string, id: string | undefined | null): string | null {
    if (typeof id !== "string") return null;
    const prefix = TABLE_ID_PREFIX[table] ?? "fx7";
    return id.startsWith(prefix) ? id : null;
  }

  query(name: string): MemoryQuery {
    return new MemoryQuery([...this.table(name).values()], name);
  }

  /** All rows of a table, for assertions. */
  rows(name: string): Row[] {
    return [...this.table(name).values()];
  }
}

export interface StoreCall {
  readonly type: string;
  readonly args: Record<string, unknown>;
}

export interface PlatformCtx {
  readonly db: MemoryDb;
  readonly runMutation: (ref: unknown, args: unknown) => Promise<unknown>;
  readonly runAction: (ref: unknown, args: unknown) => Promise<unknown>;
  readonly runQuery: (ref: unknown, args: unknown) => Promise<unknown>;
  readonly auth: { getUserIdentity: () => Promise<unknown> };
  readonly storeCalls: StoreCall[];
}

/**
 * The fake action context: routes the library's `"auth:store"` mutation
 * calls into the REAL store handler of the app's auth entry (captured
 * for assertions). Everything between the call and the fake db is real
 * library code.
 */
export function platformCtx(
  db: MemoryDb,
  storeHandler: (ctx: unknown, args: unknown) => Promise<unknown>,
): PlatformCtx {
  const storeCalls: StoreCall[] = [];
  const runStore = async (args: unknown): Promise<unknown> => {
    const wrapped = args as { args?: { type?: string } } | undefined;
    const type = wrapped?.args?.type ?? "unknown";
    storeCalls.push({ type, args: (wrapped?.args ?? {}) as Record<string, unknown> });
    return await storeHandler(mutationCtx(db), args);
  };
  return {
    db,
    runMutation: (ref, args) => {
      if (String(ref) !== "auth:store") {
        throw new Error(`fixture ctx: unexpected mutation ${String(ref)}`);
      }
      return runStore(args);
    },
    runAction: (ref) => {
      throw new Error(`fixture ctx: unexpected action ${String(ref)}`);
    },
    runQuery: (ref) => {
      throw new Error(`fixture ctx: unexpected query ${String(ref)}`);
    },
    auth: { getUserIdentity: async () => null },
    storeCalls,
  };
}

/** The MutationCtx-shaped view of the fake store (what storeImpl and
 * the app's `createOrUpdateUser` callback see; the MemoryDb itself is
 * the db api). */
export function mutationCtx(db: MemoryDb): unknown {
  return { db, auth: { getUserIdentity: async () => null } };
}

/** The registered-function `handler` seam (Convex attaches it as
 * `_handler`; the public type hides it). */
export type RegisteredHandler = (ctx: unknown, args: unknown) => Promise<unknown>;

/** Extracts the `_handler` seam of a Convex registered function. */
export function registeredHandler(registered: unknown, name: string): RegisteredHandler {
  const handler = (registered as { _handler?: unknown })._handler;
  if (typeof handler !== "function") {
    throw new Error(`fixture harness: ${name} exposes no _handler seam`);
  }
  return handler as RegisteredHandler;
}

/** A fresh platform side for one flow: an in-memory store plus the fake
 * action ctx whose `"auth:store"` mutation calls run the REAL store
 * handler of the app's auth entry. */
export function freshPlatform(storeHandler: RegisteredHandler): {
  ctx: PlatformCtx;
  db: MemoryDb;
} {
  const db = new MemoryDb();
  return { ctx: platformCtx(db, (c, args) => storeHandler(c, args)), db };
}

/** One header lookup across the shapes init.headers can take. */
function headerValue(headers: unknown, name: string): string | null {
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (Array.isArray(entry) && entry[0]?.toLowerCase() === name) {
        return String(entry[1]);
      }
    }
    return null;
  }
  if (typeof headers === "object" && headers !== null) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === name) {
        return String(value);
      }
    }
  }
  return null;
}

/** Normalized view of one fetch call, shared by the network stubs.
 * oauth4webapi and the @auth/core customFetch wrapper may pass a raw
 * (URL, init) pair or a Request; the body may be a string, serialized
 * form data, or carried by the Request itself. */
export interface FetchEnvelope {
  readonly url: URL;
  readonly method: string;
  readonly authorization: string | null;
  /** The request body as text (a promise when only the Request carries
   * it). Empty for bodyless requests. */
  readonly body: string | Promise<string>;
}

export function fetchEnvelope(input: RequestInfo | URL, init?: RequestInit): FetchEnvelope {
  const request = typeof input === "string" || input instanceof URL ? null : input;
  const url =
    typeof input === "string"
      ? new URL(input)
      : input instanceof URL
        ? input
        : new URL(input.url);
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const authorization =
    headerValue(init?.headers, "authorization") ??
    (request !== null ? request.headers.get("authorization") : null);
  let body: string | Promise<string>;
  if (typeof init?.body === "string") {
    body = init.body;
  } else if (init?.body instanceof URLSearchParams) {
    body = init.body.toString();
  } else if (init?.body !== undefined && init.body !== null) {
    body = String(init.body);
  } else if (request !== null) {
    body = request.text();
  } else {
    body = "";
  }
  return { url, method, authorization, body };
}

/** Invokes one route of a real convex httpRouter in-process. Returns
 * null when the route is not registered (the honest "absent" state). */
export async function callRoute(
  router: {
    lookup: (
      path: string,
      method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT" | "OPTIONS" | "HEAD",
    ) => unknown;
  },
  method: "GET" | "POST",
  url: string,
  ctx: unknown,
  headers: Record<string, string> = {},
): Promise<Response | null> {
  const found = router.lookup(new URL(url).pathname, method) as
    | [handler: (ctx: unknown, request: Request) => Promise<Response>, ...unknown[]]
    | null;
  if (found === null) {
    return null;
  }
  return await found[0](ctx, new Request(url, { method, headers }));
}

/** Collects Set-Cookie values of a response into a Cookie header map. */
export function cookieHeaderFrom(response: Response): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair?.indexOf("=");
    if (pair !== undefined && eq !== undefined && eq > 0) {
      jar[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return jar;
}
