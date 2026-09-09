/** B1 live proof: subscription denial after revocation (sanitized output). */
if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
if (typeof globalThis.document === "undefined") globalThis.document = { hasFocus: () => true };
const { ConvexReactClient } = await import("convex/react");
const { ConvexHttpClient } = await import("convex/browser");
const DEPLOYMENT = process.env.KIERO_B1_DEPLOYMENT;
const URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
const EMAIL = "b1-proof@kiero.invalid";
const FIXTURE_CODE = "31415926";
const row = (l, v) => console.log(`ROW | ${l} | ${v}`);
const ok = (l, c, d = "") => { if (!c) throw new Error(`PROOF FAILED: ${l} ${d}`); row(l, `PASS ${d}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const anon = new ConvexHttpClient(URL, { logger: false });
await anon.action("access/identity/probe:b1ProofSetCode", { email: EMAIL, code: FIXTURE_CODE });
const fresh = await anon.action("auth:signIn", { provider: "email_code", params: { email: EMAIL, code: FIXTURE_CODE } });
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
const stop = watch.onUpdate(() => { changed += 1; });
let rows = undefined;
for (let i = 0; i < 100 && rows === undefined; i++) {
  rows = watch.localQueryResult();
  if (rows === undefined) await sleep(100);
}
ok("S2 subscription delivered the protected registry rows", Array.isArray(rows) && rows.length >= 1, `rows=${rows?.length} changes=${changed}`);
const revoked = await http.mutation("access/identity/functions:revokeSession", { sessionId });
ok("S3 revocation committed", revoked?._tag === "ok", `revokedAtMs=${revoked?.value?.revokedAtMs}`);
let denialError = null;
for (let i = 0; i < 100 && denialError === null; i++) {
  try { watch.localQueryResult(); } catch (e) { denialError = e instanceof Error ? e.message : String(e); }
  if (denialError === null) await sleep(100);
}
ok("S4 live subscription denied after revocation (token unchanged, still valid)", denialError !== null, `message=${JSON.stringify(denialError?.slice(0, 80))}`);
stop(); react.close();
console.log("B1 SUBSCRIPTION PROOF PASSED");
