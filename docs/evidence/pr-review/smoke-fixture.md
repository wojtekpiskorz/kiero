# Smoke fixture: AI review activation content (post-fix round)

> Corrected content pushed as the fix round of the A0 activation proof. The defect-round version (sequential awaits, `as any` cast, swallowed error, slopped paragraph) lives in the PR history at `b9e6897`..`6b86ccc` and in the round-1 review comment; see `docs/evidence/pr-review/README.md` for the recorded runs.

## Sample: fetching project cards

```ts
interface ProjectCard {
  id: string;
  alias: string;
  stage: string;
}

async function fetchCard(id: string): Promise<ProjectCard> {
  const res = await fetch(`/api/projects/${id}`);
  if (!res.ok) {
    throw new Error(`Fetching project card ${id} failed: ${res.status}`);
  }
  return (await res.json()) as ProjectCard;
}

async function loadCards(ids: string[]): Promise<ProjectCard[]> {
  const results = await Promise.allSettled(ids.map(fetchCard));
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    console.warn(`Skipped ${failed.length} project card(s) that failed to load`);
  }
  return results
    .filter((r): r is PromiseFulfilledResult<ProjectCard> => r.status === "fulfilled")
    .map((r) => r.value);
}
```

## What Kiero does

Kiero gives a construction firm one shared place for its projects. Bosses send what they learn in conversation; the agent turns those messages into project knowledge they can look up later. Every piece of information keeps its source, so a firm can check where a deadline or a price came from.

## Przykład produktowy

Szef wysyła zdjęcie szkicu z budowy, a Kiero zapisuje je jako zdjęcie źródłowe powiązane z projektem.

## What the smoke test expects

- Defect round (`smoke-fixture.md` as pushed first): the advisory review flags the sequential `await` loop over independent `fetchCard` calls, the `as any` cast that erases the `ProjectCard` contract, and the caught-and-swallowed error that hides failed cards. It flags the slopped English paragraph via unslop. It does not flag the Polish product sentence.
- Fix round (this content): the same summary comment is edited in place, the three engineering findings and the slop finding disappear (defect fixed with `Promise.allSettled` plus an explicit non-`any` cast and a surfaced failure count; prose rewritten plainly), and the Polish sentence remains unchanged and unflagged.
- Both rounds: one summary comment per PR stating the reviewed head SHA; inline comments only for high-conviction findings.
