# Architecture evidence index

The [architecture ticket](https://github.com/wojtekpiskorz/kiero/issues/11) holds the canonical accepted resolution. The [design](../mvp/architecture-design.md), [evaluation plan](../mvp/ai-evaluation-plan.md) and [proof matrix](../mvp/architecture-proof-matrix.md) describe the selected implementation direction and unperformed checks.

These reports record dated upstream facts, candidate comparisons and the sequence of research. Historical recommendations and pending questions inside older reports do not override the final resolution. PostgreSQL/Drizzle, Graphile, Effect Cluster, ElevenLabs, Render and Better Auth were researched alternatives, not selected additional systems. No catalog entry, upstream example or beta/RC label proves Kiero's integration ready.

| Area | Reports |
| --- | --- |
| Typed foundations and durable execution | [Type/schema foundations](architecture-typed-foundations.md), [backend comparison](architecture-backend-facts.md), [Effect workflow](effect-workflow-facts.md), [Convex/Cloudflare fit](convex-cloudflare-fit.md), [Cloudflare/PostgreSQL alternative](cloudflare-postgres-execution-facts.md) |
| Identity | [Identity contract facts](auth-identity-facts.md), [Convex Auth candidate and linking caveats](convex-auth-integration-facts.md) |
| Media and recovery | [Delivery and recovery](media-delivery-recovery-facts.md), [normalization and audio retention](media-normalization-facts.md), [backup/recovery](backup-recovery-facts.md), [historical audio/cost comparison](alpha-audio-cost-facts.md) |
| Models and SDK | [OpenRouter integration](openrouter-integration-facts.md), [ordered model routing](openrouter-model-routing-facts.md), [STT/embedding/release candidates](stt-embedding-release-facts.md) |
| Operations and plans | [Alpha operations](alpha-operations-facts.md), [accepted services/runtime and Free-first amendment](alpha-services-runtime-facts.md) |
| Calendar | [Integration](google-calendar-integration-facts.md), [event mapping](google-calendar-event-mapping-facts.md), [reconnection](google-calendar-reconnect-facts.md) |
| Deferred formal discussion | [Training-consent facts](ai-training-consent-facts.md), retained as research; Q195 was deferred by the owner and is not a new imposed approval gate |

The original closed research tickets retain their own immutable source artifacts and historical resolutions on the map. This bundle brings the architecture-session notes together for review without changing those earlier records.
