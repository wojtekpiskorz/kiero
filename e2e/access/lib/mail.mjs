/**
 * The B5 mail.tm mailbox helper (e2e leg): the same committed funnel as
 * tools/smoke/mailbox.mjs, generalized over every application email
 * Kiero sends (convex/integrations/email/copy.ts):
 *
 *   sign-in code      "Kiero — kod do logowania"
 *   invitation code   "Kiero — zaproszenie do firmy"
 *   method-link code  "Kiero — kod do potwierdzenia metody logowania"
 *   email-change code "Kiero — kod do zmiany adresu e-mail"
 *
 * One real throwaway mailbox per persona; credentials are test artifacts
 * only (named in evidence by address, never written into evidence docs
 * beyond the run artifacts under /tmp).
 *
 * No import side effects; every function is explicit. Retry-on-429 like
 * the committed CLI (mail.tm throttles bursts).
 */

const API = "https://api.mail.tm";

/** The subject + code-line patterns of every Kiero application email. */
export const EMAIL_KINDS = {
  sign_in_code: {
    subject: "Kiero — kod do logowania",
    codePattern: /Twój kod do zalogowania w Kiero:\s*(\d{8})/,
  },
  invitation_code: {
    subject: "Kiero — zaproszenie do firmy",
    codePattern: /Kod zaproszenia:\s*(\d{8})/,
  },
  method_link_code: {
    subject: "Kiero — kod do potwierdzenia metody logowania",
    codePattern: /Kod do potwierdzenia metody logowania w Kiero:\s*(\d{8})/,
  },
  email_change_code: {
    subject: "Kiero — kod do zmiany adresu e-mail",
    codePattern: /Kod do potwierdzenia nowego adresu e-mail w Kiero:\s*(\d{8})/,
  },
};

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
    throw new Error(`mail.tm ${path} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const text = await response.text();
  return text.length === 0 ? {} : JSON.parse(text);
}

function randomLocalPart() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `kiero-b5-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}

function randomPassword() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 24);
}

/** Creates one fresh throwaway mailbox (the committed funnel pattern). */
export async function createMailbox(outFile) {
  const domainsResponse = await api("/domains?page=1");
  const domains = Array.isArray(domainsResponse) ? domainsResponse : (domainsResponse["hydra:member"] ?? []);
  const domain = domains.find((d) => d.isActive)?.domain;
  if (domain === undefined) {
    throw new Error("no active mail.tm domain");
  }
  const address = `${randomLocalPart()}@${domain}`;
  const password = randomPassword();
  await api("/accounts", { method: "POST", body: JSON.stringify({ address, password }) });
  const record = { provider: "mail.tm", address, password, createdAt: new Date().toISOString() };
  if (outFile !== undefined) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`);
  }
  return record;
}

async function loginToken(address, password) {
  const { token } = await api("/token", { method: "POST", body: JSON.stringify({ address, password }) });
  return token;
}

async function fetchMessages(address, password) {
  const token = await loginToken(address, password);
  const messages = await api("/messages?page=1", { headers: { authorization: `Bearer ${token}` } });
  return Array.isArray(messages) ? messages : (messages["hydra:member"] ?? []);
}

/** The current message ids of a mailbox (the pre-request snapshot). */
export async function messageIds(mailbox) {
  const messages = await fetchMessages(mailbox.address, mailbox.password);
  return messages.map((m) => m.id);
}

/**
 * Waits for the newest mail of one kind and returns its 8-digit code plus
 * metadata. mail.tm latency varies 5-8+ minutes; the default timeout is
 * the patient 720s the funnel allows.
 *
 * `excludeIds` (the message ids snapshot taken BEFORE the request) is the
 * authoritative freshness filter — mail.tm timestamps truncate to whole
 * seconds, so a wall-clock `sinceMs` can miss a mail created in the same
 * second as the request. Pass both when you can.
 */
export async function waitForCode(
  mailbox,
  kind,
  { sinceMs = Date.now() - 15 * 60_000, excludeIds = [], timeoutMs = 720_000, intervalMs = 15_000 } = {},
) {
  const pattern = EMAIL_KINDS[kind];
  if (pattern === undefined) {
    throw new Error(`unknown email kind: ${kind}`);
  }
  const startedAt = Date.now();
  for (;;) {
    const messages = await fetchMessages(mailbox.address, mailbox.password);
    const newest = messages
      .filter(
        (m) =>
          (m.subject ?? "").startsWith(pattern.subject) &&
          !excludeIds.includes(m.id) &&
          Date.parse(m.createdAt) >= sinceMs - 2000,
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (newest !== undefined) {
      const token = await loginToken(mailbox.address, mailbox.password);
      const full = await api(newest["@id"] ?? `/messages/${newest.id}`, { headers: { authorization: `Bearer ${token}` } });
      const code = pattern.codePattern.exec(full.text ?? "")?.[1] ?? null;
      if (code !== null) {
        return { code, subject: full.subject ?? "", mailCreatedAt: full.createdAt ?? "", body: (full.text ?? "").slice(0, 800) };
      }
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`no "${pattern.subject}" mail within ${Math.round(timeoutMs / 1000)}s (polled ${messages.length} messages)`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Lists message subjects (a debugging aid; no bodies). */
export async function listSubjects(mailbox) {
  const messages = await fetchMessages(mailbox.address, mailbox.password);
  return messages.map((m) => `${m.createdAt ?? ""} ${m.subject ?? ""}`);
}

/**
 * The one-shot orchestration every driver uses: snapshot the mailbox,
 * run the request (an API call, or a browser click before polling), then
 * wait for the NEXT mail of the kind. Deterministic against second-level
 * mail timestamps and mail.tm latency.
 */
export async function nextCodeAfter(mailbox, kind, request, options = {}) {
  const excludeIds = await messageIds(mailbox);
  const sinceMs = Date.now();
  await request();
  return await waitForCode(mailbox, kind, { ...options, sinceMs, excludeIds });
}
