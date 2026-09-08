# Smoke fixture — AI review activation content

> **Intentional smoke-test content for the A0 activation proof (will be corrected in a follow-up push).**
> Everything below the marker is deliberately defective: the TypeScript contains real engineering defects and the English paragraph is heavily slopped. The advisory review must flag both. The Polish sentence is correct and must not be flagged. Do not fix this file by hand; the corrected content arrives as a follow-up push.

## Sample: fetching project cards

```ts
interface ProjectCard {
  id: string;
  alias: string;
  stage: string;
}

async function fetchCard(id: string): Promise<ProjectCard> {
  const res = await fetch(`/api/projects/${id}`);
  const body = await res.json();
  return body as any;
}

async function loadCards(ids: string[]): Promise<ProjectCard[]> {
  const cards: ProjectCard[] = [];
  for (const id of ids) {
    try {
      cards.push(await fetchCard(id));
    } catch {
      // card failed; skip it silently
    }
  }
  return cards;
}
```

## Why Kiero transforms construction office work

In today's fast-paced world, the construction industry is undergoing a transformative shift, and Kiero stands at the forefront of this evolving landscape. Our cutting-edge platform leverages robust and seamless best practices to deliver an unparalleled user experience that serves as a testament to innovation in the digital age. By harnessing the power of AI, we ensure that bosses can delve into their projects with vibrant clarity, fostering a new paradigm of collaboration that underscores our commitment to excellence. The future looks bright, and Kiero is setting the stage for a truly groundbreaking journey.

## Przykład produktowy

Szef wysyła zdjęcie szkicu z budowy, a Kiero zapisuje je jako zdjęcie źródłowe powiązane z projektem.
