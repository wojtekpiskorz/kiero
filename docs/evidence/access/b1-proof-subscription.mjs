/**
 * B1 live proof: subscription denial after revocation.
 *
 * A real Convex WebSocket subscription to a protected query stays open
 * with a still-valid token; revoking the app session pushes the denial
 * to the live subscriber immediately (the watched registry row changes,
 * the query re-runs, the server error surfaces through the watch). Same
 * minimal-browser-globals pattern as the A3 subscription proof.
 */
if (typeof globalThis.window === "undefined") {
  globalThis.window = globalThis;
}
if (typeof globalThis.document === "undefined") {
  globalThis.document = { hasFocus: () => true };
}

const { ConvexReactClient } = await import("convex/react");
const { ConvexHttpClient } = await import("convex/browser");

const DEPLOYMENT = process.env.KIERO_B1_DEPLOYMENT;
const URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
const EMAIL = "b1-proof@kiero.invalid";
const FIXTURE_CODE = "31415926";

const row = (label, value) => console.log(`ROW | ${label} | ${value}`);
const ok = (label, cond, detail = "") => {
  if (!cond) throw new Error(`PROOF FAILED: ${label} ${detail}`);
  row(label, `PASS ${detail}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const anon = new ConvexHttpClient(URL, { logger: false });
await anon.action("access/identity/probe:b1ProofSetCode", { email: EMAIL, code: FIXTURE_CODE });
const fresh = await anon.action("auth:signIn", {
  provider: "email_code",
  params: { email: EMAIL, code: FIXTURE_CODE },
});
const token = fresh?.tokens?.token ?? null;
ok("S0 fresh real sign-in", typeof token === "string");

const http = new ConvexHttpClient(URL, { logger: false, auth: token });
const ensured = await http.mutation("access/identity/functions:ensureSessionRegistry", {});
ok("S1 registry provisioned", ensured?.state === "live");
const sessionId = ensured.sessionId;

const react = new ConvexReactClient(URL, { unsavedChangesWarning: false });
await react.setAuth(async () => token);

const watch = react.watchQuery("access/identity/functions:listMySessions", {});
let changed = 0;
const stop = watch.onUpdate(() => {
  changed += 1;
});

// Wait for the initial result.
let rows = undefined;
for (let i = 0; i < 100 && rows === undefined; i++) {
  rows = watch.localQueryResult();
  if (rows === undefined) {
    await sleep(100);
  }
}
ok("S2 subscription delivered the protected registry rows", Array.isArray(rows) && rows.length >= 1,
  `rows=${rows?.length} changes=${changed}`);

const revoked = await http.mutation("access/identity/functions:revokeSession", { sessionId });
ok("S3 revocation committed", revoked?._tag === "ok", `revokedAtMs=${revoked?.value?.revokedAtMs}`);

// The watched row changed; the query re-runs; localQueryResult must now throw.
let denialError = null;
for (let i = 0; i < 100 && denialError === null; i++) {
  try {
    watch.localQueryResult();
  } catch (error) {
    denialError = error instanceof Error ? error.message : String(error);
  }
  if (denialError === null) {
    await sleep(100);
  }
}
ok(
  "S4 live subscription denied after revocation (token unchanged, still valid)",
  denialError !== null,
  `message=${JSON.stringify(denialError?.slice(0, 90))}`,
);

stop();
react.close();
console.log("B1 SUBSCRIPTION PROOF PASSED");
