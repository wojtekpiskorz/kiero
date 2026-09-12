/**
 * The cross-feature route-params contract (H1 review round 1): the
 * query-param keys of the conversation route, owned in ONE module instead
 * of one private definition per feature.
 *
 * Since R5 (issue #130) the canonical source deep link is the dossier
 * route `/zrodlo?zrodlo=<id>` serialized by the source-detail feature's
 * own contract module (../source-detail/source-route) — the ONLY sanctioned
 * builder of source links. The legacy `/?zrodlo=<id>` form on this route
 * redirects there. `?projekt=<id>` (the project scope) stays a shared key
 * both routes read, so a drift between two copies would break deep links
 * silently.
 */

/** The query-param project-scope key (deep-linkable project projection). */
export const PROJECT_PARAM = "projekt";

/** The query-param source deep-link key (the canonical source URL). */
export const SOURCE_PARAM = "zrodlo";

/** Reads one string search param (the first value wins, URLSearchParams.get). */
export function searchParam(name: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const value = new URLSearchParams(window.location.search).get(name);
  return value === null || value.length === 0 ? null : value;
}

/** Keeps the URL in step with the selected scope (deep-linkable). */
export function writeScopeParam(projectId: string | null): void {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  if (projectId === null) {
    url.searchParams.delete(PROJECT_PARAM);
  } else {
    url.searchParams.set(PROJECT_PARAM, projectId);
  }
  window.history.pushState({}, "", url);
}
