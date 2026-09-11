# Permanent-deletion evidence (I4, issue #56)

Environment: leased Convex dev deployment `wojtek-piskorz-jr:kiero-dev-core:dev/i4`
(`nautical-loris-352`, regionless origin), gateway Worker `kiero-dev-gateway-i4`
(R2 binding `MEDIA_BUCKET` -> `kiero-dev-media`, jurisdiction eu). Code revision:
worktree at main `fe0fa26` plus this lane's uncommitted changes (the coordinator
owns the Git lifecycle). No secret value appears here; credentials are present
by NAME only.

Lease env (names only, all set BEFORE the recorded `dev --once` push):
`JWT_PRIVATE_KEY`, `JWKS` (key set, kid `i4-dev-key-1`), `KIERO_SERVICE_TOKEN`,
`KIERO_PROBE_ENABLED=1`, `KIERO_B1_PROOF_ENABLED=1`, `KIERO_B3_PROOF_ENABLED=1`,
`KIERO_PURGE_EXECUTOR_URL` (the deployed gateway origin).

Operational finding (hard-won, transcribed for later leases): `rtk` swallows
piped stdin, so `cat value | rtk npx convex env set NAME` silently stores an
EMPTY value. Multi-line secrets must land as
`npx convex@1.45.0 env set NAME --from-file <file>` (plain command, no rtk).
The gateway Worker secret needs the same care with `wrangler secret put`.

## Status summary

| Area | Status |
| --- | --- |
| Initiating transaction, ledger, stages, marking, executor, bridge (convex/operations/deletion) | IMPLEMENTED, 22 focused tests green (tests/i4) |
| Gateway purge route (apps/gateway/src/purge) | IMPLEMENTED, deployed live as `kiero-dev-gateway-i4` |
| Web feature /usuwanie-danych (impact preview, confirmation, cleanup status) | IMPLEMENTED, registered through A4 + the join composition |
| Live proofs on dev/i4 | **13 PASS, 1 NOT RUN** (transcript below) |
| Linked-export download refusal after purge | NOT RUN live: the export archive Worker is not deployable on this lease (I3's recorded owner-token gap); unit-proven in tests/i4/purge.test.ts (eager invalidation inside the initiating transaction) |

## Live proof transcript (sanitized, 2026-09-11)

```
$ KIERO_I4_CONVEX=nautical-loris-352 \
  KIERO_I4_GATEWAY=https://kiero-dev-gateway-i4.wojtek-524.workers.dev \
  node tests/i4/live-proof.mjs

[PASS] P0  the administrator and the member are REAL signed-in persons of one firm
[PASS] M1  the authorized media read answers 200 with the ledger bytes before the purge
[PASS] A1a the administrator's impact preview names the counts, never content
[PASS] A1b a plain member receives the typed forbidden refusal
[PASS] A2  a wrong confirmation phrase refuses as a typed conflict and commits nothing
[PASS] I1a the confirmed purge commits the content-free ledger row with six deadline-carrying stages
[PASS] I2a the company conversation no longer lists the purged source
[PASS] I2b the source detail refuses the uniform not-found
[PASS] I2c the gateway media route refuses the next read before any R2 byte
[PASS] I3  repeated delete requests return the SAME ledger record, never a second one
[PASS] C1a every purge stage reaches purged inside the window (media bytes through the gateway)
        :: media_objects:purged:1,transcripts:purged:1,findings_marking:purged:1,
           search_index:purged:1,notification_work:purged:1,exports:purged:1
[PASS] C1b the purged media stays unreadable after the byte deletion (ledger not-found)
[PASS] G1  the gateway purge route refuses a missing service credential (401)
[NOT RUN] E8 a linked available export's download refuses immediately after the purge
        :: export archive Worker not deployable on this lease (I3's recorded
           owner-token gap); unit-proven in tests/i4/purge.test.ts

Summary: {"PASS":13,"NOT RUN":1} of 14 checks
```

The real media chain (M1/C1): one image attachment uploaded through the
deployed gateway's `/uploads/*` routes into the EU bucket, accepted as a
source's evidence, read byte-exact before the purge, and really deleted from
R2 by the `/purge/media` route (the ledger-driven key list; the route's own
401 row proves its credential gate).

## Evidence still owed by other lanes' seams

- P10 quarantine-restore replay (I6): this lane's ledger contract is proven
  content-free and carried (tests/i4/seams.test.ts drives I5's
  `deletionLedgerSnapshot`/`purgedDropsOf` over a real purge row); the
  restore-time suppression replay itself is I6's issue.
- P09 export invalidation rows needing real archive bytes re-run verbatim
  once an export Worker exists on a lease.
