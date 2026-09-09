/**
 * @kiero/gateway: Cloudflare Worker bootstrap skeleton.
 *
 * This Worker will own the authorization gateway and streamed
 * media/upload/OAuth routes (execution charter). No routes, bindings or
 * deployment exist in this bootstrap; every request receives an explicit
 * "not implemented" response instead of any fake behavior.
 */

export interface Env {
  // Bindings (R2, KV, secrets) are declared by the tickets that use them.
}

export default {
  fetch(): Response {
    return new Response(
      "Kiero gateway: bootstrap skeleton, no routes implemented.\n",
      { status: 503 },
    );
  },
} satisfies ExportedHandler<Env>;
