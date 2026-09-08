# Kiero UX/UI handoff

This package is the entry point for the future full UX/UI phase. It turns the accepted product decisions into a bounded design brief and a traceable feature inventory. It does not choose the final visual language or claim that the user stories are complete.

## Use this package when

- planning the complete UX/UI phase;
- writing detailed user stories and acceptance criteria;
- designing information architecture, navigation, interaction patterns, Polish copy, accessibility and responsive behavior;
- checking whether a proposed design preserves the accepted domain contracts;
- reviewing implementation work for product behavior.

Start with [product-brief.md](product-brief.md), then use [feature-and-flow-inventory.md](feature-and-flow-inventory.md) as the coverage checklist. Follow [story-and-design-workflow.md](story-and-design-workflow.md) when producing stories or designs. [agent-start-prompt.md](agent-start-prompt.md) is a ready prompt for a new agent.

## Package boundary

The accepted prototype establishes a structural direction named D, "Plac budowy": the company conversation is the main workspace, project memory stays close to it, and capture remains available in a slim bottom bar. This is reference material, not the final UX/UI. The full design phase starts after the current decision map closes.

Barebones implementation of the complete core data and behavior may proceed in parallel with design. Both tracks consume the same domain contracts. A design may change presentation, navigation, disclosure and copy. A proposed change to meaning, persistence, permissions, source identity, lifecycle or side effects requires an explicit product decision plus review of schema and all consumers.

Do not treat implementation convenience, the prototype's fixtures or its component choices as product decisions. Do not turn presentation questions in this package into requirements without owner review.

## Source hierarchy

When sources differ, use this order:

1. Current explicit owner decisions, recorded in canonical GitHub resolution comments, including the [readiness and two-package handoff](https://github.com/wojtekpiskorz/kiero/issues/13).
2. The immutable architecture package at [`efc03fecbc361d04260cf034d11aa3c3707bbda5`](https://github.com/wojtekpiskorz/kiero/commit/efc03fecbc361d04260cf034d11aa3c3707bbda5).
3. The accepted prototype at [`5e3dd7e40642a4bf3221f04abea575b8cd411aff`](https://github.com/wojtekpiskorz/kiero/commit/5e3dd7e40642a4bf3221f04abea575b8cd411aff) and its [resolution](https://github.com/wojtekpiskorz/kiero/issues/12#issuecomment-5591748524).
4. This handoff, which indexes and interprets those sources for design work.

The [alpha readiness contract](../../mvp/alpha-readiness.md) adds the accepted Q212–Q216 criteria. The [core implementation package](../../implementation/README.md) and [UX-to-core coverage](../../implementation/ux-coverage.md) identify the parallel implementation owners.

The original brainstorming transcript is discovery material only. Superseded ideas such as Telegram as the v1 channel, approval of every AI change, or requirements inferred from marketing language do not belong in the design.

## Language

Write specifications, tickets, code-facing names and agent instructions in English. Write all visible interface copy, examples, fixtures and usability tasks in Polish. Preserve the Polish domain terms in `CONTEXT.md`; introduce an English code term only with an explicit mapping.

## Completion standard for the future UX/UI package

The full design phase is complete only when every UX ID in the inventory has one of these outcomes:

- designed and linked to responsive screens and component states;
- intentionally served by a shared pattern with an exact reference;
- deferred by an explicit owner decision with impact recorded.

Every designed flow must cover success, loading, empty, error, partial, permission and recovery states that apply. It must show how the user reaches the source or history behind a claim. The resulting story set must be implementable without reading the original conversation.
