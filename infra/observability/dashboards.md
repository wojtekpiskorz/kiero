# Dashboard honesty requirements (I2)

Every observability dashboard built on the Kiero event stream (Axiom
dashboards once provisioned, and any in-app operations panel consuming the
telemetry state) MUST display these annotations. They are the accepted
contract from the architecture: "Dashboards state retention and blind spots
accurately; application events do not claim full native Convex logging."

## Required annotations

1. **Retention:** "Redacted application events are retained 30 days."
   Axiom-side retention is a dataset setting operating on storage blocks; it
   is not per-event deletion at an exact boundary. Convex-side rows are
   pruned by the same 30-day window (bounded batches each telemetry tick).
2. **Native Convex logs:** "Native Convex platform log history is
   unavailable on the Free plan." The event stream is explicit redacted
   application events only - it does not include Convex function executions,
   failed mutations or console output. Native log streaming arrives with
   Convex Pro and was deliberately deferred.
3. **Blind spots** (display verbatim):
   - convex platform logs (native streaming requires Pro),
   - Cloudflare Worker console logs (not exported to the sink yet),
   - provider console metrics (OpenRouter/Resend dashboards remain external).
4. **Authority:** "Diagnostics are best effort; Kiero's domain tables are
   the canonical record." A dropped or duplicated diagnostic event never
   proves anything about processing outcomes.

## Machine-readable source

The same statements are exposed by the platform health snapshot
(`observability` block from `convex/operations/telemetry/observability.ts`)
and by [retention.json](retention.json); panels should render those values
instead of hard-coding copies.
