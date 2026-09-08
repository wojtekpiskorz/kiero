# Vendored agent skills

Repo-local review skills so every agent (local session or CI reviewer) runs the same review, instead of depending on the owner's `~/.agents/skills` installs.

## Provenance

Vendored from the verified Astroix reference:

| Skill | Upstream | Pinned at |
| --- | --- | --- |
| `thermo-nuclear-code-quality-review/` | [wojtekpiskorz/astroix](https://github.com/wojtekpiskorz/astroix) · `.agents/skills/thermo-nuclear-code-quality-review/` | `d4f1bc218261cf6c76984ca2c384df7f7b5bd80e` |
| `unslop/` | [wojtekpiskorz/astroix](https://github.com/wojtekpiskorz/astroix) · `.agents/skills/unslop/` | `d4f1bc218261cf6c76984ca2c384df7f7b5bd80e` |

Astroix itself vendored them from [cursor/plugins](https://github.com/cursor/plugins), pinned there at `6e3d2ea56d7d446b955eaae6ac4c8eef8bf504cf` (thermo-nuclear, `cursor-team-kit/skills/thermo-nuclear-code-quality-review`) and `99559f2f52047978602ef365589275831e76af07` (unslop, `pstack/skills/unslop`). Both are MIT; each skill directory carries its upstream `LICENSE` (Cursor for thermo-nuclear, Lauren Tan for unslop).

The `SKILL.md` and `LICENSE` files are byte-identical to the Astroix reference commit named above. Never edit them in place, so a refresh is always a plain diff. All Kiero-specific adaptation (how the skills are invoked, what they are pointed at, Kiero prompt wording) lives in the review prompt of `.github/workflows/ai-review.yml` and in repository instructions (`AGENTS.md`, `CONTEXT.md`), never in these directories.

## Refreshing

Recheck any later upstream change before adapting it (the Astroix reference is allowed to move; this table is not). Compare against the pinned Astroix commit:

```sh
git -C <astroix-checkout> show d4f1bc218261cf6c76984ca2c384df7f7b5bd80e:.agents/skills/<skill>/SKILL.md \
  | diff - .agents/skills/<skill>/SKILL.md
```

To adopt a change, overwrite the local copy from the new verified reference, update the pinned SHA in the table above, and note the delta in the PR description.

## Notes

- `thermo-nuclear-code-quality-review` has `disable-model-invocation: true` upstream (kept verbatim): it is invoked by an explicit review flow, not self-invoked by the model.
- The Kiero reviewer invokes both skills through the workflow prompt in `.github/workflows/ai-review.yml`; see `docs/operations/pr-review.md` for how the review operates.
