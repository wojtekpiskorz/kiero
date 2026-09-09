/** B1 live proof: malformed JWT subjects fail closed at resolution. */
import { SignJWT, importPKCS8 } from "jose";
import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";
const DEPLOYMENT = process.env.KIERO_B1_DEPLOYMENT;
const URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
const SITE = `https://${DEPLOYMENT}.eu-west-1.convex.site`;
const keyLine = readFileSync("/tmp/kiero-b1-auth-final.txt", "utf8").split("\n").find((l) => l.startsWith("JWT_PRIVATE_KEY="));
const pkcs8 = "-----BEGIN PRIVATE KEY-----\n" + keyLine.replace("JWT_PRIVATE_KEY=", "").trim().replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").trim().split(" ").join("\n") + "\n-----END PRIVATE KEY-----";
const key = await importPKCS8(pkcs8, "RS256");
const row = (l, v) => console.log(`ROW | ${l} | ${v}`);
const ok = (l, c, d = "") => { if (!c) throw new Error(`PROOF FAILED: ${l} ${d}`); row(l, `PASS ${d}`); };
async function mint(sub) {
  return await new SignJWT({ sub }).setProtectedHeader({ alg: "RS256" }).setIssuedAt()
    .setIssuer(SITE).setAudience("convex").setExpirationTime("1h").sign(key);
}
const bad = new ConvexHttpClient(URL, { logger: false, auth: await mint("garbage-no-pipe") });
let badError = null;
try { await bad.query("access/identity/functions:listMySessions", {}); } catch (e) { badError = e instanceof Error ? e.message : String(e); }
ok("M1 malformed subject denied", badError !== null, `message=${JSON.stringify(badError?.slice(0, 80))}`);
const ghost = new ConvexHttpClient(URL, { logger: false, auth: await mint("k57ghost|s57ghost") });
let ghostError = null;
try { await ghost.query("access/identity/functions:listMySessions", {}); } catch (e) { ghostError = e instanceof Error ? e.message : String(e); }
ok("M2 well-formed subject with unknown ids denied", ghostError !== null, `message=${JSON.stringify(ghostError?.slice(0, 80))}`);
console.log("B1 MALFORMED-SUBJECT PROOFS PASSED");
