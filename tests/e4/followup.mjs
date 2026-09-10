// Targeted follow-up: (D') correction through C2 of the JOIN-published
// image-grounded finding; (B') one more sanctioned vision retry for the
// image-pending source; final state capture.
import { ConvexHttpClient } from "convex/browser";
const URL_ = "https://necessary-weasel-284.eu-west-1.convex.cloud";
const email = process.env.PERSON;
const codeOf = (s) => { let h = 0; for (const b of Buffer.from(s)) h = (h * 31 + b) % 90_000_000; return String(42_000_000 + h); };
const boot = new ConvexHttpClient(URL_, { logger: false });
try { await boot.action("auth:signIn", { provider: "email_code", params: { email } }); } catch {}
await boot.action("access/identity/probe:b1ProofSetCode", { email, code: codeOf(email) });
const signIn = await boot.action("auth:signIn", { provider: "email_code", params: { email, code: codeOf(email) } });
const token = signIn?.tokens?.token;
const A = new ConvexHttpClient(URL_, { logger: false, auth: token });
const sessionId = (await A.mutation("access/identity/functions:ensureSessionRegistry", {})).sessionId;
const read = async (scope) => {
  const r = await A.action("memory/findings/probe:probeMemoryCommand", {
    envelope: { operation: "memory.readCurrentFindings", input: { scope }, expectedRevisions: [] }, sessionId });
  return r?._tag === "ok" ? r.value.rows : [];
};
const GATEWAY = "https://kiero-dev-gateway-e4.wojtek-524.workers.dev";
const gw = (path, init = {}) => fetch(`${GATEWAY}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const acceptText = async (authorText) => {
  // A text-only source rides a seeded zero-attachment upload (the gateway's
  // prepare requires >=1 media kind; E3's own proof uses this seeding path).
  const seeded = await A.action("processing/text/probe:probeSeedE3Upload", { sessionId });
  if (seeded?._tag !== "ok" || typeof seeded.value?.uploadId !== "string") {
    throw new Error(`upload seeding failed: ${JSON.stringify(seeded).slice(0, 300)}`);
  }
  const r = await A.action("sources/uploads/probe:probeAcceptSourceAsCaller", {
    envelope: { operation: "sources.acceptSource", input: { uploadId: seeded.value.uploadId, authorText, timezoneSnapshot: "Europe/Warsaw", projectHints: [] }, expectedRevisions: [], idempotencyKey: `idem_${globalThis.crypto.randomUUID()}` } });
  if (r?._tag !== "ok" || typeof r.value?.sourceId !== "string") throw new Error(`accept failed: ${JSON.stringify(r).slice(0, 300)}`);
  return r.value.sourceId;
};
const PID = process.env.PID;
const sources = ((await A.action("sources/uploads/probe:probeUploadsState", {}))?.value?.sources ?? []);
const bSource = sources[1];
console.log("B source:", bSource?.sourceId);

await A.action("processing/text/probe:probeKickReanalysis", { sourceId: bSource.sourceId });
console.log("B' kick placed; correction source accepting...");
const correctionSource = await acceptText("Szerokość pomieszczenia dla projektu ostatecznie 3,90 metra. Poprawka do wcześniejszego odczytu ze zdjęcia.");
console.log("correction source:", correctionSource);

let dOutcome = "timeout";
for (let i = 0; i < 60; i += 1) {
  const rows = await read({ _tag: "project", projectId: PID });
  const szer = rows.find((f) => f.semanticKey === "szerokosc_pomieszczenia");
  if (szer && /3,90|3\.90/.test(JSON.stringify(szer.value))) { dOutcome = `corrected to ${JSON.stringify(szer.value)} rev=${szer.currentRevisionId}`; break; }
  await sleep(15_000);
}
console.log("D' correction of the JOIN-published image-grounded finding:", dOutcome);
let bVision = "pending";
for (let i = 0; i < 50; i += 1) {
  const r = await A.action("processing/multimodal/probe:probeJoinState", { sourceId: bSource.sourceId });
  const v = r?._tag === "ok" ? r.value : null;
  if ((v?.visionOrders ?? []).some((o) => o.state === "complete")) {
    bVision = "complete";
    const groups = (v?.steps ?? []).filter((x) => x.kind === "e4_publish_group" && x.output?.outcome === "published");
    console.log("B' vision complete; published groups:", JSON.stringify(groups.map((g) => g.output)));
    const allRows = [...(await read({ _tag: "company" }))];
    for (const g of groups) if (typeof g.output?.projectId === "string") allRows.push(...(await read({ _tag: "project", projectId: g.output.projectId })));
    console.log("B' findings now:", JSON.stringify(allRows.map((f) => `${f.semanticKey}=${JSON.stringify(f.value)}`)));
    break;
  }
  await sleep(15_000);
}
if (bVision !== "complete") console.log("B' vision still pending (GLM structured-output flake persists today)");
