/**
 * Sign-in provider availability (by env NAME only).
 *
 * Google OAuth is configured only when the owner-supplied client
 * credential names carry values on the deployment; the barebones UI shows
 * the Google control only then (an honest unconfigured state instead of a
 * dead button). No value is ever read into Kiero data or logs.
 */

/** Environment variable names (values are owner-supplied secrets). */
export const GOOGLE_CLIENT_ID_NAME = "AUTH_GOOGLE_ID";
export const GOOGLE_CLIENT_SECRET_NAME = "AUTH_GOOGLE_SECRET";

function present(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0;
}

/** Whether Google sign-in is configured on this deployment. */
export function googleSignInConfigured(env: {
  AUTH_GOOGLE_ID?: string;
  AUTH_GOOGLE_SECRET?: string;
}): boolean {
  return present(env.AUTH_GOOGLE_ID) && present(env.AUTH_GOOGLE_SECRET);
}

/** Production callers pass `process.env` (deploy-time snapshot). */
export function providerAvailabilityFromEnv(env: {
  AUTH_GOOGLE_ID?: string;
  AUTH_GOOGLE_SECRET?: string;
}): { readonly emailCode: boolean; readonly google: boolean } {
  return { emailCode: true, google: googleSignInConfigured(env) };
}
