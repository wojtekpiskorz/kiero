/**
 * The Convex Auth entry: Kiero's sign-in providers and identity policy.
 *
 * This module configures the pinned @convex-dev/auth 0.0.95 (the accepted
 * first candidate, Q186):
 *
 * - email-code (OTP): an 8-digit code, 15-minute validity, delivered
 *   through the reusable Resend adapter (convex/integrations/email) with
 *   Polish copy; the code must be redeemed together with the SAME email
 *   address that requested it (the provider's default `authorize` check);
 * - Google OAuth: included only when the owner configured the client
 *   credential names on the deployment (see ./providerAvailability.ts);
 *   Google's stable `sub` (kept in the profile by a custom `profile`
 *   mapping) is the account identity, never the email address alone.
 *
 * `createOrUpdateUser` is REPLACED by the Kiero policy (./userPolicy.ts):
 * the library default would implicitly link accounts by verified email,
 *   which the accepted identity rules forbid — linking requires both
 *   proofs and is B2's operation. The B2 amendment below keeps that rule
 *   and adds the two explicit ceremony hooks (./linking/authHook.ts):
 *
 * - a Google sign-in that RESUMES an account records the fresh Google
 *   proof when that account's ceremony awaits it (no-op otherwise);
 * - the `method_conflict` rejection consults the linking module first:
 *   when an active ceremony proves BOTH methods, the sign-in BECOMES the
 *   explicit link commit (returning the ceremony's user id is the
 *   library's supported manual-linking mechanism — the provider account
 *   row attaches in the same transaction). Without a ceremony the
 *   original B1 rejection stands, unchanged.
 *
 * Sessions: total and inactivity lifetimes are pinned to the accepted
 * 30-day rule. The app-side live-session registry (./resolution.ts)
 * enforces revocation and inactivity on every protected read regardless
 * of upstream token validity.
 *
 * `convex/auth.ts` re-exports the returned functions (the client and the
 * platform look them up under the `auth` module path). `signIn` is the
 * R26 data-carrying wrapper around the library action: every classified
 * refusal reaches the client as `ConvexError` data, never as message
 * text a production deployment would sanitize.
 */

import { Schema } from "effect";
import { convexAuth, type ConvexAuthConfig } from "@convex-dev/auth/server";
import { Email } from "@convex-dev/auth/providers/Email";
import Google from "@auth/core/providers/google";
import { actionGeneric } from "convex/server";
import { ConvexError, v } from "convex/values";
import {
  deliverApplicationEmail,
  deliveryFailureCopy,
  EMAIL_DELIVERY_FAILED_MARKER,
} from "../../integrations/email/send";
import {
  accessRefusalData,
  type AccessRefusalData,
} from "../errorCodes";
import {
  METHOD_CONFLICT_MARKER,
  decideCreateOrUpdateUser,
  normalizeEmail,
  GoogleProfile,
  EmailCodeProfile,
  type UserPolicyInput,
  type UserPolicyUser,
} from "./userPolicy";
import {
  commitIssuanceAttempt,
  ISSUANCE_RATE_LIMITED_MARKER,
} from "./issuanceLimit";
import {
  googleLinkFromCallbackHook,
  recordGoogleProofHook,
} from "../linking/authHook";

/** One-time email code: 8 digits, valid for 15 minutes. */
const OTP_CODE_LENGTH = 8;
const OTP_MAX_AGE_SECONDS = 15 * 60;

/**
 * Cryptographically secure digits with rejection sampling: bytes >= 250
 * are rejected so the modulo mapping onto 0..9 stays uniform (no modulo
 * bias). Web Crypto only; no extra dependency.
 */
function generateOtpCode(): string {
  const digits = "0123456789";
  const maxUsableByte = Math.floor(256 / digits.length) * digits.length; // 250
  let code = "";
  while (code.length < OTP_CODE_LENGTH) {
    const bytes = new Uint8Array(OTP_CODE_LENGTH);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= maxUsableByte) {
        continue; // rejected sample, not used
      }
      code += digits[byte % digits.length] ?? "0";
      if (code.length === OTP_CODE_LENGTH) {
        break;
      }
    }
  }
  return code;
}

/** Google's raw token payload, decoded before any use (pinned schema). */
const GoogleTokenProfile = Schema.Struct({
  sub: Schema.String,
  email: Schema.String,
  email_verified: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
});

/** The users-table projection every user doc is decoded through. */
const UserRecord = Schema.Struct({
  email: Schema.String,
  googleSubject: Schema.optional(Schema.String),
});

const googleClientId = process.env.AUTH_GOOGLE_ID;
const googleClientSecret = process.env.AUTH_GOOGLE_SECRET;

const authConfig: ConvexAuthConfig = {
  providers: [
    Email({
      id: "email_code",
      maxAge: OTP_MAX_AGE_SECONDS,
      generateVerificationToken: generateOtpCode,
      async sendVerificationRequest({ identifier, token, expires }) {
        const outcome = await deliverApplicationEmail(identifier, {
          kind: "sign_in_code",
          code: token,
          expiresAtMs: expires.getTime(),
        });
        const copy = deliveryFailureCopy(outcome);
        if (copy !== null) {
          // Fail the issuance loudly and sanitized: the machine marker and
          // Polish copy stay in the message for logs, while the closed code
          // rides the ConvexError DATA (client classification reads data —
          // messages are sanitized to "Server Error" on prod deployments);
          // no code, key or provider payload anywhere. Retrying issues a
          // fresh code (the pending one is replaced, never duplicated).
          throw new ConvexError<AccessRefusalData>(
            accessRefusalData("email_delivery_failed", `${EMAIL_DELIVERY_FAILED_MARKER} ${copy}`),
          );
        }
      },
    }),
    ...(googleClientId !== undefined && googleClientSecret !== undefined
      ? [
          Google({
            clientId: googleClientId,
            clientSecret: googleClientSecret,
            // Keep Google's stable account id in the profile that reaches
            // the user policy (the library strips `id` for the account
            // lookup; the policy keys the person's Google identity on
            // `sub`, never on the email address).
            async profile(profile) {
              const decoded = Schema.decodeUnknownSync(GoogleTokenProfile)(profile);
              return {
                id: decoded.sub,
                sub: decoded.sub,
                email: decoded.email,
                emailVerified: decoded.email_verified === true,
                ...(decoded.name === undefined ? {} : { name: decoded.name }),
              };
            },
          }),
        ]
      : []),
  ],
  session: {
    // The accepted session rule (issue #4): reauthentication after 30
    // days total, expiry after 30 days of inactivity.
    totalDurationMs: 30 * 24 * 60 * 60 * 1000,
    inactiveDurationMs: 30 * 24 * 60 * 60 * 1000,
  },
  callbacks: {
    /**
     * The Kiero identity policy: create-or-resume the person by method,
     * never implicitly link by email (see ./userPolicy.ts). Every user
     * document read is decoded through the pinned UserRecord schema; no
     * unchecked access bridges the auth package boundary.
     */
    async createOrUpdateUser(ctx, args) {
      const input: UserPolicyInput =
        args.type === "oauth"
          ? { method: "google", profile: Schema.decodeUnknownSync(GoogleProfile)(args.profile) }
          : {
              method: "email_code",
              profile: Schema.decodeUnknownSync(EmailCodeProfile)(args.profile),
            };

      // Issuance throttle (email-code code requests only; the library
      // rate-limits verification failures but not sends). Checked FIRST,
      // before any user/code row is created or an email attempted, and
      // only for the issuance callback (`type === "email"`), never for
      // the verification pass. The generic callback ctx exposes only the
      // collection filter (same pattern as the users lookup below).
      if (args.type === "email") {
        const identifier = `issuance:email_code:${normalizeEmail(input.profile.email)}`;
        // B2 amendment: the row read/write is the ONE shared budget core
        // (./issuanceLimit.ts commitIssuanceAttempt); this inline adapter is
        // the generic-callback db half. A blocked attempt writes nothing
        // (rewriting the row would keep pushing the recovery window and
        // starve the honest user).
        const throttled = await commitIssuanceAttempt(
          {
            throttleRow: async (id) => {
              const row = await ctx.db
                .query("authRateLimits")
                .filter((q) => q.eq(q.field("identifier"), id))
                .first();
              return row === null
                ? null
                : {
                    id: row._id,
                    lastAttemptTime: row.lastAttemptTime,
                    attemptsLeft: row.attemptsLeft,
                  };
            },
            insertThrottleRow: async (id, row) => {
              await ctx.db.insert("authRateLimits", {
                identifier: id,
                lastAttemptTime: row.lastAttemptTime,
                attemptsLeft: row.attemptsLeft,
              });
            },
            patchThrottleRow: async (rowId, row) => {
              // normalizeId is the proved bridge back to the branded id
              // (the surface carries plain strings, like the policy).
              const id = ctx.db.normalizeId("authRateLimits", rowId);
              if (id === null) {
                throw new Error("issuance throttle: nieprawidłowy identyfikator");
              }
              await ctx.db.patch(id, {
                lastAttemptTime: row.lastAttemptTime,
                attemptsLeft: row.attemptsLeft,
              });
            },
          },
          identifier,
          Date.now(),
        );
        if (!throttled) {
          // Closed code in the DATA (classification), marker + Polish copy
          // in the message (logs; sanitized away on prod deployments).
          throw new ConvexError<AccessRefusalData>(
            accessRefusalData(
              "issuance_rate_limited",
              `${ISSUANCE_RATE_LIMITED_MARKER} Zbyt wiele próśb o kod na ten adres. Odczekaj kilka minut i spróbuj ponownie.`,
            ),
          );
        }
      }

      // Address lookups are case-insensitive at the policy boundary: the
      // stored form is normalized (see ./userPolicy.ts), so mixed-case
      // variants of one address collide in the no-implicit-linking check.
      const found: UserPolicyUser[] = [];
      if (input.profile.email.length > 0) {
        // The library's callback types expose only the generic data model,
        // so this lookup uses the collection filter (correct, typed; the
        // `email` index serves the library's own lookups). Sign-in volume
        // is tiny; B2's linking adapter moves this behind a typed seam.
        const docs = await ctx.db
          .query("users")
          .filter((q) => q.eq(q.field("email"), normalizeEmail(input.profile.email)))
          .take(2);
        for (const doc of docs) {
          const decoded = Schema.decodeUnknownSync(UserRecord)(doc);
          found.push({
            id: doc._id,
            email: decoded.email,
            googleSubject: decoded.googleSubject ?? null,
          });
        }
      }

      const decision = decideCreateOrUpdateUser({
        existingUserId: args.existingUserId,
        input,
        usersWithEmail: found,
      });

      if (decision.action === "reject") {
        // B2 amendment — the explicit linking ceremony (issue #21): before
        // the method-conflict rejection stands, the linking module decides
        // whether an active ceremony proves BOTH methods for this address.
        // Only Google-direction sign-ins reach this branch with a proof
        // that can commit (the OAuth proof is happening now); email legs
        // verify through the linking module's own code channel.
        if (input.method === "google") {
          const link = await googleLinkFromCallbackHook(ctx, {
            rawProfile: args.profile,
            usersWithEmail: found,
            nowMs: Date.now(),
          });
          if (link.committed) {
            // The ceremony committed atomically (users.googleSubject +
            // ceremony state) inside the hook; returning this user id is
            // the library's supported manual linking — the provider
            // account row attaches to the SAME account in this transaction.
            const linkedUserId = ctx.db.normalizeId("users", link.userId);
            if (linkedUserId === null) {
              throw new Error("createOrUpdateUser: nieprawidłowy identyfikator osoby");
            }
            return linkedUserId;
          }
        }
        // Polish product copy: the address belongs to an identity using a
        // different sign-in method; no detail about that identity is
        // disclosed. Verified method linking is B2's operation (account
        // settings; both proofs). Twin literal pinned by tests/b1+b2; the
        // closed code rides the ConvexError DATA (R26), the marker + copy
        // stay in the message for logs.
        throw new ConvexError<AccessRefusalData>(
          accessRefusalData(
            "method_conflict",
            `${METHOD_CONFLICT_MARKER} Konto z tym adresem e-mail używa innej metody logowania. Zaloguj się pierwotną metodą; metody połączysz w ustawieniach konta, potwierdzając obie.`,
          ),
        );
      }
      if (decision.action === "resume") {
        // The policy works with plain id strings; the Convex write surface
        // wants branded ids. normalizeId is the proved bridge (A3).
        const userId = ctx.db.normalizeId("users", decision.userId);
        if (userId === null) {
          throw new Error("createOrUpdateUser: nieprawidłowy identyfikator osoby");
        }
        if (args.profile.emailVerified === true) {
          await ctx.db.patch(userId, { emailVerificationTime: Date.now() });
        }
        // B2 amendment — record the fresh Google proof when the resumed
        // account's ceremony awaits it (no ceremony: one bounded lookup,
        // no writes). This is the google leg of an email-direction
        // ceremony; everything else is untouched.
        if (input.method === "google") {
          await recordGoogleProofHook(ctx, {
            userId: decision.userId,
            rawProfile: args.profile,
            nowMs: Date.now(),
          });
        }
        return userId;
      }
      const created = await ctx.db.insert("users", {
        email: decision.input.email,
        displayName: decision.input.displayName,
        ...(decision.input.googleSubject === undefined
          ? {}
          : { googleSubject: decision.input.googleSubject }),
        ...(decision.input.emailVerified ? { emailVerificationTime: Date.now() } : {}),
        createdAtMs: Date.now(),
      });
      // The generic insert returns a plain string; the callback contract
      // wants the branded user id. normalizeId is the proved bridge (A3).
      const createdId = ctx.db.normalizeId("users", created);
      if (createdId === null) {
        throw new Error("createOrUpdateUser: nieprawidłowy identyfikator osoby");
      }
      return createdId;
    },
  },
};

const { auth, signIn: librarySignIn, signOut, store, isAuthenticated } = convexAuth(authConfig);

/**
 * The library action's registered handler seam (the same `_handler`
 * property tests/b1 drive; Convex attaches it to every registered
 * function). The wrapper calls the handler IN-PROCESS with its own ctx —
 * the "shared helper function" shape Convex's own tooling recommends for
 * function-to-function reuse. `ctx.runAction` cannot be used here: the
 * library action is no longer a module export, so the bundler attaches
 * no function reference to it. Pinned @convex-dev/auth 0.0.95 / convex
 * keep this seam stable.
 */
const librarySignInHandler = (
  librarySignIn as unknown as {
    readonly _handler: (ctx: unknown, args: unknown) => Promise<unknown>;
  }
)._handler;

/** True when the thrown error already carries data (ours and any library ConvexError). */
function carriesData(error: unknown): boolean {
  return (error as { readonly data?: unknown } | null | undefined)?.data !== undefined;
}

/**
 * Whether the client call is an email-code VERIFICATION (the form's second
 * step) — the only leg whose refusals the LIBRARY throws as plain errors
 * ("Could not verify code": wrong/expired code, verifier mismatch, or the
 * library's per-address verification-failure budget), unreachable for
 * structuring at their throw site.
 */
function isEmailCodeVerification(args: {
  readonly provider?: string;
  readonly params?: { readonly code?: unknown };
}): boolean {
  return args.provider === "email_code" && typeof args.params?.code === "string";
}

/**
 * The exported sign-in action (R26): the library's `auth:signIn` wrapped
 * so every refusal reaches the client as STRUCTURED `ConvexError` data.
 *
 * Our own refusals (issuance budget, method conflict, delivery failure)
 * already throw ConvexErrors with the closed code in data — inside the
 * library's store mutation or verification callback — and pass through
 * untouched. The library's own verification refusal throws a plain Error
 * whose message production sanitizes to "Server Error"; on that one leg
 * the wrapper re-issues the refusal with the closed code in data, keeping
 * the library's stable message for logs. Every other failure (Google
 * redirects, token refresh, genuine crashes) propagates unchanged.
 */
export const signIn = actionGeneric({
  args: {
    provider: v.optional(v.string()),
    params: v.optional(v.any()),
    verifier: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      return await librarySignInHandler(ctx, args);
    } catch (error) {
      if (carriesData(error) || !isEmailCodeVerification(args)) {
        throw error;
      }
      // The library's stable literal, kept verbatim for logs; the closed
      // code rides the data field the client classifies on.
      throw new ConvexError<AccessRefusalData>(
        accessRefusalData("code_wrong_or_expired", "Could not verify code"),
      );
    }
  },
});

export { auth, signOut, store, isAuthenticated };
