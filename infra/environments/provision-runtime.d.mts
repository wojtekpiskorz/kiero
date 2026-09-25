/** Types for provision-runtime.mjs (consumed by tests/platform). */

export interface TargetConfig {
  readonly deployment: string;
  readonly site: string;
  readonly fixed: Readonly<Record<string, string>>;
  readonly github: { readonly environment: string; readonly mirrored: readonly string[] } | null;
}

export declare const TARGETS: { readonly dev: TargetConfig; readonly staging: TargetConfig };
export declare const OWNER_PROVIDED: readonly string[];
export declare function convexAuthKeys(): { JWT_PRIVATE_KEY: string; JWKS: string };
export declare function vapidKeys(): { WEB_PUSH_VAPID_PUBLIC_KEY: string; WEB_PUSH_VAPID_PRIVATE_KEY: string };
export interface GeneratedValues {
  readonly [name: string]: string | undefined;
  readonly JWT_PRIVATE_KEY: string;
  readonly JWKS: string;
  readonly WEB_PUSH_VAPID_PUBLIC_KEY: string;
  readonly WEB_PUSH_VAPID_PRIVATE_KEY: string;
  readonly KIERO_SERVICE_TOKEN: string;
  readonly KIERO_MEDIA_WORKER_TOKEN: string;
  readonly KIERO_CALENDAR_TOKEN_KEY: string;
  readonly KIERO_CALENDAR_REDIRECT_URI: string;
}

export declare function generatedValues(target: keyof typeof TARGETS): GeneratedValues;
