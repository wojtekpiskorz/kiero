#!/usr/bin/env node
/**
 * The staging smoke mailbox CLI (I8's "reproduce from the committed
 * instructions" leg): API-readable mailboxes for the ordinary email-code
 * sign-in flow, so the authenticated smoke runs without a human reading
 * a mailbox.
 *
 * Provider: mail.tm (public API, throwaway accounts; the address is a
 * REAL mailbox that really receives the OTP — the delivery proof stays
 * end-to-end). The account credentials are random and throwaway; they
 * are never repo material and never treated as secrets. The provider is
 * named in every output so a future adapter (e.g. a dedicated Email
 * Worker on an owned subdomain) can slot in behind the same commands.
 *
 * Commands:
 *   account [--domain <domain>] [--out <file>]
 *       Create a mailbox; print {provider,address,password} JSON.
 *   wait-code --address <a> --password <p> [--since <iso>] [--timeout <s>] [--interval <s>]
 *       Poll for the newest "Kiero — kod do logowania" mail and print
 *       CODE=<8 digits> (exit 1 on timeout).
 *   latest --address <a> --password <p>
 *       Print the newest message's subject/text (debugging aid).
 *
 * No secret values are required or printed beyond the throwaway mailbox
 * credentials themselves.
 */

const API = "https://api.mail.tm";
const OTP_SUBJECT_PREFIX = "Kiero — kod do logowania";
const CODE_PATTERN = /(\d{8})/;

function fail(message) {
  console.error(`mailbox: ${message}`);
  process.exit(1);
}

async function api(path, options = {}, retry = 0) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { "content-type": "application/json", accept: "application/json", ...(options.headers ?? {}) },
  });
  if (response.status === 429 && retry < 5) {
    await new Promise((resolve) => setTimeout(resolve, 1500 * (retry + 1)));
    return api(path, options, retry + 1);
  }
  if (!response.ok) {
    fail(`${path} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const text = await response.text();
  return text.length === 0 ? {} : JSON.parse(text);
}

function randomLocalPart() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `kiero-smoke-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}

function randomPassword() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 24);
}

async function loginToken(address, password) {
  const { token } = await api("/token", {
    method: "POST",
    body: JSON.stringify({ address, password }),
  });
  return token;
}

/** Extracts the 8-digit OTP from a Kiero login mail's text. */
export function extractLoginCode(text) {
  if (typeof text !== "string") {
    return null;
  }
  const anchored = /Twój kod do zalogowania w Kiero:\s*(\d{8})/.exec(text);
  if (anchored !== null) {
    return anchored[1];
  }
  const loose = CODE_PATTERN.exec(text.replace(/\s/g, ""));
  return loose === null ? null : loose[1];
}

async function commandAccount(args) {
  const outIndex = args.indexOf("--out");
  const domainIndex = args.indexOf("--domain");
  const domains = Array.isArray(await api("/domains?page=1")) ? await api("/domains?page=1") : [];
  const domain = domainIndex >= 0 ? args[domainIndex + 1] : domains.find((d) => d.isActive)?.domain;
  if (domain === undefined) {
    fail("no active mail.tm domain");
  }
  const address = `${randomLocalPart()}@${domain}`;
  const password = randomPassword();
  await api("/accounts", { method: "POST", body: JSON.stringify({ address, password }) });
  const record = { provider: "mail.tm", address, password, createdAt: new Date().toISOString() };
  if (outIndex >= 0) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(args[outIndex + 1], `${JSON.stringify(record, null, 2)}\n`);
  }
  console.log(JSON.stringify(record));
}

async function fetchMessages(address, password) {
  const token = await loginToken(address, password);
  const messages = await api("/messages?page=1", { headers: { authorization: `Bearer ${token}` } });
  return Array.isArray(messages) ? messages : (messages["hydra:member"] ?? []);
}

async function commandWaitCode(args) {
  const value = (flag) => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const address = value("--address") ?? fail("--address is required");
  const password = value("--password") ?? fail("--password is required");
  const sinceMs = value("--since") !== undefined ? Date.parse(value("--since")) : Date.now() - 15 * 60_000;
  const timeoutMs = (Number(value("--timeout") ?? 180)) * 1000;
  const intervalMs = (Number(value("--interval") ?? 4)) * 1000;
  const startedAt = Date.now();
  for (;;) {
    const messages = await fetchMessages(address, password);
    const newest = messages
      .filter((m) => (m.subject ?? "").startsWith(OTP_SUBJECT_PREFIX) && Date.parse(m.createdAt) >= sinceMs)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (newest !== undefined) {
      const token = await loginToken(address, password);
      const full = await api(newest["@id"] ?? `/messages/${newest.id}`, { headers: { authorization: `Bearer ${token}` } });
      const code = extractLoginCode(full.text ?? full.intro ?? "");
      if (code !== null) {
        console.log(`CODE=${code}`);
        return;
      }
    }
    if (Date.now() - startedAt > timeoutMs) {
      fail(`no login mail within ${timeoutMs / 1000}s (polled ${messages.length} messages)`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function commandLatest(args) {
  const value = (flag) => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const address = value("--address") ?? fail("--address is required");
  const password = value("--password") ?? fail("--password is required");
  const [newest] = (await fetchMessages(address, password)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (newest === undefined) {
    console.log("(no messages)");
    return;
  }
  const token = await loginToken(address, password);
  const full = await api(newest["@id"] ?? `/messages/${newest.id}`, { headers: { authorization: `Bearer ${token}` } });
  console.log(`SUBJECT=${full.subject ?? ""}`);
  console.log(`CREATED=${full.createdAt ?? ""}`);
  console.log(`TEXT=${(full.text ?? "").slice(0, 600)}`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "account") {
  await commandAccount(rest);
} else if (command === "wait-code") {
  await commandWaitCode(rest);
} else if (command === "latest") {
  await commandLatest(rest);
} else {
  fail("usage: mailbox.mjs account | wait-code | latest (see the header comment)");
}
