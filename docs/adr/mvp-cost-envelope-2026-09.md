# ADR: MVP cost envelope — Convex Free-only; the only allowed spend is AI tokens and the USD 5/month Cloudflare baseline

- **Status**: Accepted (owner decision, 2026-09-22, after a USD 20/month
  Convex charge arrived with zero users; amended the same day — the owner
  closed the cost allowlist: AI token spend and the USD 5/month Cloudflare
  baseline are the only accepted costs, and this envelope is declared
  SUFFICIENT for the MVP)
- **Deciders**: Kiero owner (Wojtek Piskorz); recorded by the implementation session
- **Amends**: the Q211 Free-first Convex revision
  (docs/research/alpha-services-runtime-facts.md) — its "move to Starter when
  metered usage is sufficient" branch is REVOKED for the pre-user phase

## Context

Q211 accepted a Free-first Convex posture with an escape hatch: start on
Free, move to Starter "when metered usage is sufficient", Professional when
its features warrant it. In practice the account sat on an **active Starter
(pay-as-you-go) subscription** while Kiero had no users at all:

- 2026-09-14 evidence (docs/evidence/staging/vps-2026-09-14.md): Convex
  reported an active Starter subscription, billing-period spend USD 4.50,
  account warning/disable thresholds USD 10/20.
- 2026-09-22: the owner received a **USD 20/month Convex bill with zero
  users** and deleted the Convex project (`kiero-dev-core` per convex.json).
  The deletion is accepted here: the pre-user deployments held only
  synthetic and evidence data, so nothing user-owned was lost.

Pre-user does not mean zero load. Scheduled jobs, telemetry heartbeats,
synthetic staging traffic and the agreed backup/export design consume
Convex resources continuously. Under the Free plan's hard caps that same
load fails loudly when the caps are hit; under Starter's pay-as-you-go it
invoices quietly. The defect was therefore not "Convex is expensive" but
"a plan tier that can invoice, combined with always-on pre-user machinery
and no owner gate between them".

Plan facts used below are DATED EVIDENCE (convex.dev/pricing, checked
2026-09-22; limits doc checked 2026-09-08 in
docs/research/alpha-services-runtime-facts.md), not lifetime prices:
Free and Starter share the same included allowances (1M function calls,
20 GB-hours action compute, 0.5 GB database storage, 1 GB file storage,
0.5 GB search storage, 1 GB database I/O, 3,000 query-GBs, 1 GB egress;
40 deployments, S16 class). Starter bills pay-as-you-go beyond them
(e.g. USD 2.20 per additional 1M calls); Professional is USD 25 per
developer per month; the EU resource-price multiplier is 1.3.

## Decision

**The MVP runs inside a CLOSED cost allowlist.** Anything not named here is
forbidden until the owner amends this ADR. "Real user" means the first
**Szef** account (CONTEXT.md) admitted outside owner/GM controls.

| # | Cost | Status | Governing rule |
| --- | --- | --- | --- |
| 1 | AI token spend (LLM/vision/STT/embeddings) | ALLOWED, metered | Existing 400/500 PLN all-in budget policy (infra/observability/cost-limits.json); must trend toward zero as pre-user synthetic lanes stop |
| 2 | Cloudflare Workers Paid baseline | ALLOWED, USD 5/month | The single permitted subscription; see rule 3 |
| 3 | Convex beyond the Free plan | FORBIDDEN pre-users | Free hard caps, or the alternatives lane (rule 4) |
| 4 | Any other subscription, tier, baseline or add-on | FORBIDDEN | Resend Free, Axiom Personal, R2 free tier, Images within the 5,000 free monthly transformations — free allowances only, never the paid tiers |

Recorded interpretation of item 1: "AI tokens" covers token spend through
BOTH accepted AI suppliers — OpenRouter-billed routes and the direct
DeepSeek chat/vision route of ADR provider-routing-2026-09.md (which
substitutes for OpenRouter-billed tokens). A new AI supplier would be a new
allowlist item, not a covered one.

1. **Convex is Free-only until the first real users exist.** Any Convex
   project provisioned from now on lands on the Free plan with no payment
   method attached and no active paid subscription; a billing threshold or
   spending state must not exist on the account. This is verified at
   provisioning (dashboard shows Free, no card) and re-verified monthly by
   the I2 cost-accounting lane; a nonzero Convex line item in the pre-user
   phase is a blocker-class finding, not a note. The Q211 Starter escape
   hatch is revoked: Starter or Professional become ELIGIBLE only after
   the first real users exist AND by an explicit owner decision that
   records the expected monthly ceiling. Eligibility never implies an
   automatic upgrade.
2. **Cloudflare costs target the USD 5/month baseline, nothing more.**
   Workers Paid is re-enabled under this ADR (it unblocks the Containers
   runtime for media conversion and the export/backup executor), but its
   metered usage — Workers requests, Container CPU/memory/disk, R2
   operations, image transformations — must stay within the included
   allowances so the Cloudflare invoice stays at the baseline. A Cloudflare
   overage is never silently absorbed: it is a loud typed failure plus an
   owner decision, the same discipline infra/backups/plan-limits.json
   already prescribes for R2.
3. **When Free caps bind, the order of response is fixed.** First find and
   remove waste: every scheduled job, heartbeat interval, synthetic traffic
   generator and export run must justify its consumption against the Free
   allowances — the 15-minute backup export schedule and synthetic staging
   traffic are the first suspects, and the research record already flagged
   export traffic (~2,880 full snapshots/month) as the likeliest first
   reason to leave Free. Second, if a genuinely required capability
   provably cannot fit the Free caps (measured usage as evidence), open an
   explicit alternatives research lane before any money moves. Candidates
   to evaluate — none selected here: self-hosted Convex (open-source
   self-hosting) on the existing VPS, a Cloudflare-native stack (D1 /
   Durable Objects on the hosting already in use), Supabase free tier, or
   plain Postgres on the existing VPS.
4. **MVP sufficiency is an owner declaration lanes must design within.**
   The owner declared this envelope (AI tokens + USD 5/month Cloudflare +
   USD 0 everything else) SUFFICIENT for the MVP. A qualification or
   implementation lane that proves a hard conflict with the envelope does
   not get to overspend it: it raises the conflict with measured evidence
   and goes to the alternatives lane or an explicit owner amendment.
5. **Durability is never silently traded for quotas.** The agreed backup
   frequency is not quietly reduced to fit Free: a cap impact is a loud
   typed failure plus an owner decision.
6. **Re-provisioning the deleted project is allowed under rules 1–5.** A
   successor project on the existing team (`wojtek-piskorz-jr`) is created
   on the Free plan and verified as such BEFORE the first deploy. All
   stale references to the deleted deployment (`VITE_CONVEX_URL`, gateway
   bindings, GitHub environment secrets, infra docs under infra/) are
   re-pointed by the provisioning lane, and
   `npm run verify:environments` preflight is re-run with evidence recorded
   under docs/evidence/staging/. Those references are not edited by this
   ADR (outside its ownership).

## Consequences

- Exactly one subscription may invoice during the MVP: Cloudflare Workers
  Paid at USD 5/month. AI tokens stay metered under the 400/500 PLN
  policy. Convex, Resend, Axiom, R2 and Images must remain on their free
  allowances; any other invoice is a blocker-class finding.
- Containers-based media qualification is back inside the reachable
  envelope (Workers Paid is paid for), but its Container compute must fit
  the included allowances — measured usage stays a proof obligation, and
  an overage triggers rule 2's loud-failure path.
- The pre-user staging deployments are gone with the deleted project until
  re-provisioning under rule 6; deployment-dependent evidence lanes pause
  in the meantime.
- The I2 monthly re-verification gains hard duties: catch any
  subscription, billing threshold or payment instrument that appears on
  the Convex account, any Cloudflare charge above the USD 5 baseline, and
  any provider invoice outside the allowlist — all before the first users
  exist, all raised as blockers.
- The backup economics remain the most probable trigger of the
  alternatives lane; the decision rule (waste first, alternatives second,
  paid upgrade last and gated) applies to it unchanged.

## Verification at provisioning (checklist for the re-creation lane)

1. Convex dashboard for the team shows no active paid subscription and no
   attached payment method; the new project reports the Free plan.
2. Deployment count stays within the Free allowance (40 deployments as of
   2026-09-22) and the S16 class.
3. All environment references resolve to the new deployment; the
   environment shape check passes in CI.
4. Cloudflare billing state confirms the USD 5 Workers Paid baseline with
   usage inside the included allowances.
5. Evidence recorded under docs/evidence/staging/ with the date and the
   observed plan states.

## Amendment 2026-09-25: pre-user background cadences

**Owner decision** (2026-09-25, after the waste review rule 3 requires): the
always-on machinery is cut to pre-user cadences. This is the explicit owner
decision rule 5 demands before backup frequency changes; it is not a silent
reduction.

| Job | Before | Pre-user |
| --- | --- | --- |
| Telemetry tick (incidents, silence, cost alerts, pruning, Axiom forward) | every minute | hourly |
| Outbox, intent, reminder and push safety nets | every 1–5 minutes | hourly |
| Deletion purge pass (24-hour deadline) | every 15 minutes | hourly |
| Google Calendar sync pass (integration deferred beyond v1) | every 5 minutes | removed |
| Backup Container run (`convex export` of the whole database) | every 15 minutes | daily, 02:00 UTC |
| Convex backup freshness tick | every 15 minutes | daily, 03:00 UTC |

Scheduled runs per deployment fall from roughly 127,000 to roughly 4,350 a
month, before the calls each run fans out to. `tests/platform/crons.test.ts`
caps the total at 5,000 and forbids anything more frequent than hourly.

Consequences:

- Backup RPO becomes one day, and the freshness limit becomes 26 hours.
  Retention windows are unchanged. The accepted alpha cadence (15 minutes,
  RPO one hour) returns with the first real users, by the same kind of
  explicit decision, before I6/I10 qualify recovery.
- Safety nets only matter after a lost scheduled hop: the real work runs
  through `ctx.scheduler` when its event happens, so user-visible latency
  does not change.
- External silence detection in Axiom tolerates 27 hours, because the daily
  backup heartbeat is the only event reaching the sink until the gateway
  prober is wired.
