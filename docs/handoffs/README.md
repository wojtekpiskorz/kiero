# Kiero handoff packages

Start with the package matching the work you are doing. Both consume the accepted product decisions from the [planning map](https://github.com/wojtekpiskorz/kiero/issues/1), the [domain glossary](../../CONTEXT.md), and the [architecture contract](../mvp/architecture-design.md).

| Work | Entry point | Completion boundary |
| --- | --- | --- |
| Full user stories and UX/UI | [UX/UI package](ux-ui/README.md) | Owner-reviewed journeys, detailed stories, state coverage and complete design ready to connect to the core |
| Real core functionality with an unstyled application | [Core implementation package](../implementation/README.md) | Durable, authorized, source-backed behavior demonstrated through a barebones PWA and repeatable evidence |

The owner accepted Q212–Q216, then explicitly split the handoff into these two independent packages. Full UX/UI starts after the decision map closes. Core implementation can proceed without waiting for that design. Each track consumes the same domain operations and states. A presentation change does not require rebuilding the memory or source model; a change to meaning, permission, state transitions or data requirements must update the affected contract and consumers explicitly.

The accepted [prototype D](https://github.com/wojtekpiskorz/kiero/tree/5e3dd7e40642a4bf3221f04abea575b8cd411aff/prototype) is design evidence. Core implementation uses real persistence and provider integrations. It does not inherit the prototype's simulated AI, timers or in-memory database.

[Alpha readiness](../mvp/alpha-readiness.md) governs future tester entry. Publishing these packages, closing the decision map, completing the first text loop, and qualifying the full core are distinct milestones. None alone certifies a designed application for the four-week live alpha.

## Source authority

Current explicit owner decisions override older recommendations. Canonical resolutions are linked from the planning map. The architecture snapshot is accepted through Q211. Readiness adds Q212–Q216 and the owner's two-package/parallel-execution instruction. Research reports are dated evidence; their earlier candidate selections are superseded by subsequent decisions.

Code, identifiers, issue bodies and technical documents are English. Product interface text, agent replies and representative business examples are Polish.
