/**
 * The final core composition entry, gateway half (J2, issue #61).
 *
 * The full-flow join owns this explicit cross-module composition: ONE
 * module that names the complete core HTTP surface the gateway Worker
 * must compose and validates it loudly at boot (`fullCoreGatewayOrThrow`,
 * wired in the Worker entry), so a provider silently dropped from the
 * registry, or a route the joined capture/media flow needs going
 * missing, fails the deploy instead of a boss's phone.
 *
 * DELIBERATELY PURE: this module imports NO gateway internals. The
 * validators take the composed registry as a `GatewayRegistryView`
 * parameter, which keeps this file compilable outside the Workers type
 * environment (the root test program imports it) while the Worker entry
 * passes the REAL registry (`./composition/registry.ts`). The five core
 * providers: platform (health + the checked command bridge), uploads
 * (D2's resumable channel the joined composer drives), images (D5's
 * retained-representation channel), media (D3's authorized range reads
 * the source dossier streams) and Calendar OAuth (G1's lifecycle).
 */

/** The registry slice the validation consumes (structural on purpose). */
export interface GatewayRegistryView {
  readonly providers: readonly { readonly providerId: string }[];
  readonly match: (method: string, path: string) => unknown;
}

/** The provider ids the complete core gateway composes, in order. */
export const FULL_CORE_PROVIDER_IDS: readonly string[] = [
  "platform",
  "uploads",
  "images",
  "media",
  "calendar-oauth",
];

/** The fixed route paths the joined core flow depends on. */
export const FULL_CORE_ROUTE_PATHS: readonly { readonly method: string; readonly path: string }[] =
  [
    { method: "GET", path: "/platform/health" },
    { method: "POST", path: "/platform/command" },
    { method: "POST", path: "/uploads/prepare" },
    { method: "POST", path: "/uploads/reconcile" },
    { method: "POST", path: "/images/normalize" },
    { method: "POST", path: "/images/reconcile" },
    { method: "GET", path: "/platform/calendar/oauth/start" },
    { method: "GET", path: "/platform/calendar/oauth/callback" },
  ];

/** One problem found by {@link validateFullCoreGateway}. */
export interface FullCoreGatewayProblem {
  readonly kind: "provider_missing" | "provider_order_drift" | "route_missing";
  readonly name: string;
}

/** The validated gateway composition summary (tests and evidence). */
export interface FullCoreGateway {
  readonly providerIds: readonly string[];
  readonly problems: readonly FullCoreGatewayProblem[];
}

/**
 * Validates one composed registry against the join's declared core
 * surface. Pure: same registry view, same problems.
 */
export function validateFullCoreGateway(
  registry: GatewayRegistryView,
): FullCoreGateway {
  const problems: FullCoreGatewayProblem[] = [];
  const composed = registry.providers.map((provider) => provider.providerId);
  for (const id of FULL_CORE_PROVIDER_IDS) {
    if (!composed.includes(id)) {
      problems.push({ kind: "provider_missing", name: id });
    }
  }
  if (composed.join("|") !== FULL_CORE_PROVIDER_IDS.join("|")) {
    problems.push({ kind: "provider_order_drift", name: composed.join("|") });
  }
  for (const route of FULL_CORE_ROUTE_PATHS) {
    if (registry.match(route.method, route.path) === undefined) {
      problems.push({ kind: "route_missing", name: `${route.method} ${route.path}` });
    }
  }
  return { providerIds: composed, problems };
}

/** Validates a registry and THROWS on any drift (the Worker boot gate). */
export function fullCoreGatewayOrThrow(
  registry: GatewayRegistryView,
): FullCoreGateway {
  const composition = validateFullCoreGateway(registry);
  if (composition.problems.length > 0) {
    const listed = composition.problems
      .map((problem) => `${problem.kind}: ${problem.name}`)
      .join("; ");
    throw new Error(`Full core gateway composition drift: ${listed}`);
  }
  return composition;
}
