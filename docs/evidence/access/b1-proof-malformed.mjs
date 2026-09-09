/** B1 live proof: malformed JWT subjects fail closed at resolution. */
import { SignJWT, importPKCS8 } from "jose";
import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";

const DEPLOYMENT = process.env.KIERO_B1_DEPLOYMENT;
const URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
const SITE = `https://${DEPLOYMENT}.eu-west-1.convex.site`;
const keyLine = readFileSync("/tmp/kiero-b1-auth-final.txt", "utf8")
  .split("\n").find((l) => l.startsWith("JWT_PRIVATE_KEY="));
const pkcs8 =
  "-----BEGIN PRIVATE KEY-----\n" +
  keyLine.replace("JWT_PRIVATE_KEY=", "").trim()
    .replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "")
    .trim().split(" ").join("\n") +
  "\n-----END PRIVATE KEY-----";
const key = await importPKCS8(pkcs8, "RS256");

const row = (label, value) => console.log(`ROW | ${label} | ${value}`);
const ok = (label, cond, detail = "") => {
  if (!cond) throw new Error(`PROOF FAILED: ${label} ${detail}`);
  row(label, `PASS ${detail}`);
};

async function mint(sub) {
  return await new SignJWT({ sub })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setIssuer(SITE)
    .setAudience("convex")
    .setExpirationTime("1h")
    .sign(key);
}

// Well-signed, well-issued token whose subject is NOT <userId>|<sessionId>.
const bad = new ConvexHttpClient(URL, { logger: false, auth: await mint("garbage-no-pipe") });
let badError = null;
try {
  await bad.query("access/identity/functions:listMySessions", {});
} catch (error) {
  badError = error instanceof Error ? error.message : String(error);
}
ok("M1 malformed subject denied", badError !== null, `message=${JSON.stringify(badError?.slice(0, 90))}`);

// Subject with a pipe but nonexistent ids: parses, then fails closed.
const ghost = new ConvexHttpClient(URL, { logger: false, auth: await mint("k57ghost|s57ghost") });
let ghostError = null;
try {
  await ghost.query("access/identity/functions:listMySessions", {});
} catch (error) {
  ghostError = error instanceof Error ? error.message : String(error);
}
ok("M2 well-formed subject with unknown ids denied", ghostError !== null,
  `message=${JSON.stringify(ghostError?.slice(0, 90))}`);
console.log("B1 MALFORMED-SUBJECT PROOFS PASSED");
