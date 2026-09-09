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
 * which the accepted identity rules forbid — linking requires both
 * proofs and is B2's operation.
 *
 * Sessions: total and inactivity lifetimes are pinned to the accepted
 * 30-day rule. The app-side live-session registry (./resolution.ts)
 * enforces revocation and inactivity on every protected read regardless
 * of upstream token validity.
 *
 * `convex/auth.ts` re-exports the returned functions (the client and the
 * platform look them up under the `auth` module path).
 */

import { Schema } from "effect";
import { convexAuth, type ConvexAuthConfig } from "@convex-dev/auth/server";
import { Email } from "@convex-dev/auth/providers/Email";
import Google from "@auth/core/providers/google";
import {
  deliverApplicationEmail,
  deliveryFailureCopy,
  EMAIL_DELIVERY_FAILED_MARKER,
} from "../../integrations/email/send";
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
  ISSUANCE_RATE_LIMITED_MARKER,
  decideIssuance,
} from "./issuanceLimit";

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
          // Fail the issuance loudly and sanitized: the machine marker
          // (client classification) plus Polish copy; no code, key or
          // provider payload anywhere. Retrying issues a fresh code (the
          // pending one is replaced, never duplicated).
          throw new Error(`${EMAIL_DELIVERY_FAILED_MARKER} ${copy}`);
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
        const limitRow = await ctx.db
          .query("authRateLimits")
          .filter((q) => q.eq(q.field("identifier"), identifier))
          .first();
        const limit = decideIssuance(
          limitRow === null
            ? null
            : { lastAttemptTime: limitRow.lastAttemptTime, attemptsLeft: limitRow.attemptsLeft },
          Date.now(),
        );
        if (!limit.allowed) {
          // No write on a blocked attempt: rewriting the row would keep
          // pushing the recovery window and starve the honest user.
          throw new Error(
            `${ISSUANCE_RATE_LIMITED_MARKER} Zbyt wiele próśb o kod na ten adres. Odczekaj kilka minut i spróbuj ponownie.`,
          );
        }
        if (limitRow === null) {
          await ctx.db.insert("authRateLimits", {
            identifier,
            lastAttemptTime: limit.next.lastAttemptTime,
            attemptsLeft: limit.next.attemptsLeft,
          });
        } else {
          await ctx.db.patch(limitRow._id, {
            lastAttemptTime: limit.next.lastAttemptTime,
            attemptsLeft: limit.next.attemptsLeft,
          });
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
        // Polish product copy: the address belongs to an identity using a
        // different sign-in method; no detail about that identity is
        // disclosed. Verified method linking is B2's operation.
        throw new Error(
          `${METHOD_CONFLICT_MARKER} Konto z tym adresem e-mail używa innej metody logowania. Zaloguj się pierwotną metodą; łączenie metod będzie dostępne później.`,
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

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth(authConfig);
