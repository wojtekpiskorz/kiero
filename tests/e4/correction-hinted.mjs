// The correction with an explicit project hint (the finding lives at
// project scope; the hint removes the model's project-binding ambiguity).
// Usage: PERSON=<proof email> PID=<project id> node tests/e4/correction-hinted.mjs
import { ConvexHttpClient } from "convex/browser";
const URL_ = "https://necessary-weasel-284.eu-west-1.convex.cloud";
const email = process.env.PERSON;
const codeOf = (s) => { let h = 0; for (const b of Buffer.from(s)) h = (h * 31 + b) % 90_000_000; return String(42_000_000 + h); };
const boot = new ConvexHttpClient(URL_, { logger: false });
try { await boot.action("auth:signIn", { provider: "email_code", params: { email } }); } catch {}
await boot.action("access/identity/probe:b1ProofSetCode", { email, code: codeOf(email) });
const signIn = await boot.action("auth:signIn", { provider: "email_code", params: { email, code: codeOf(email) } });
const A = new ConvexHttpClient(URL_, { logger: false, auth: signIn?.tokens?.token });
const sessionId = (await A.mutation("access/identity/functions:ensureSessionRegistry", {})).sessionId;
const read = async (scope) => {
  const r = await A.action("memory/findings/probe:probeMemoryCommand", {
    envelope: { operation: "memory.readCurrentFindings", input: { scope }, expectedRevisions: [] }, sessionId });
  return r?._tag === "ok" ? r.value.rows : [];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seeded = await A.action("processing/text/probe:probeSeedE3Upload", { sessionId });
const r = await A.action("sources/uploads/probe:probeAcceptSourceAsCaller", {
  envelope: { operation: "sources.acceptSource", input: { uploadId: seeded.value.uploadId, authorText: "Szerokość pomieszczenia w tym projekcie ostatecznie 3,90 metra. Wyraźna poprawka poprzedniego odczytu.", timezoneSnapshot: "Europe/Warsaw", projectHints: [process.env.PID] }, expectedRevisions: [], idempotencyKey: `idem_${globalThis.crypto.randomUUID()}` } });
if (r?._tag !== "ok") throw new Error(`accept failed: ${JSON.stringify(r).slice(0, 300)}`);
console.log("hinted correction source:", r.value.sourceId);
for (let i = 0; i < 64; i += 1) {
  const rows = await read({ _tag: "project", projectId: process.env.PID });
  const szer = rows.find((f) => f.semanticKey === "szerokosc_pomieszczenia");
  if (szer && /3,90|3\.90/.test(JSON.stringify(szer.value))) {
    console.log("CORRECTED:", JSON.stringify({ v: szer.value, rev: szer.currentRevisionId }));
    process.exit(0);
  }
  await sleep(15_000);
}
console.log("correction did not land within the budget; last:", JSON.stringify(await read({ _tag: "project", projectId: process.env.PID })));
