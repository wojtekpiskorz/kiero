/**
 * The cross-feature route-params contract (H1 review round 1): the
 * query-param keys of the conversation route, owned in ONE module instead
 * of one private definition per feature.
 *
 * The memory surface links evidence back into `/?zrodlo=<id>` (the
 * canonical source deep link) and reads `?projekt=<id>` (the project
 * scope), exactly like the conversation surface that owns the route — so
 * the keys are a shared contract two features already depend on, and a
 * drift between two copies would break deep links silently.
 */

/** The query-param project-scope key (deep-linkable project projection). */
export const PROJECT_PARAM = "projekt";

/** The query-param source deep-link key (the canonical source URL). */
export const SOURCE_PARAM = "zrodlo";

/** Reads one string search param (the last value wins). */
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
