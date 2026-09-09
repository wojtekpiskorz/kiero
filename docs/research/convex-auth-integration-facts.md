# Convex authentication integration facts

Checked on 2026-09-08 against upstream documentation and source. The owner subsequently accepted Convex Auth as the first integration candidate in Q186. This research is not a completed integration proof. Kiero has no implementation lockfile yet. Documentation and repository main may differ from a published package.

## Existing Kiero contract

The accepted methods are Google sign-in and email OTP, without passwords. Adding another method requires proof of both identities; equal email addresses alone do not link accounts. Firm admission uses explicit invitations and checked membership operations. Ordinary users have one active firm in v1. GM access, membership revocation, session revocation and Calendar connections remain separate application concerns. Reauthentication follows 30 days of inactivity. Google Calendar consent and disconnection must not control the user's ability to sign into Kiero.

## Convex Auth

Convex Auth is explicitly beta. It targets client-side React applications served from a CDN, with React/Vite setup and Google OAuth and email-code flows. It does not supply the product UI or require a separate auth server. These properties fit the accepted client-rendered PWA, but do not establish production readiness. [Convex Auth overview](https://docs.convex.dev/auth/convex-auth)

The OTP guide uses a configurable email provider and binds code verification to the email address supplied at initiation. The owner selected Resend in Q209; exact provider configuration and delivery remain unproved. [OTP guide](https://github.com/get-convex/convex-auth/blob/main/docs/pages/config/otps.mdx)

The upstream `createOrUpdateUser` callback runs before account creation and token generation and delegates account-linking control to the application. Its inputs distinguish OAuth, email and verification flows and include the existing linked user when applicable. Credential providers have a documented exception: this callback runs when `createAccount` is called. `beforeSessionCreation` can reject a sign-in before the new session is stored. Session configuration distinguishes total lifetime from inactivity lifetime. None of these interfaces by themselves proves Kiero's linking, existing-token revocation or realtime revocation behavior. [Auth configuration source](https://github.com/get-convex/convex-auth/blob/main/src/server/types.ts)

## Better Auth with the Convex component

The official React guide supports a Vite SPA with auth HTTP handlers on the Convex deployment, `ConvexBetterAuthProvider`, and cross-domain client/server plugins. It specifies Convex 1.25 or newer and currently installs `better-auth@~1.6.15` with the component. The Better Auth documentation observed during this research advertises 1.7.3. These are upstream observations, not Kiero pins; resolve and test one compatible package set. The guide's password and unverified-email example configuration is not Kiero's accepted configuration. [React integration guide](https://labs.convex.dev/better-auth/framework-guides/react)

The component is a hybrid integration whose compatibility needs joint testing. No explicit beta label was found for this integration during the review; absence of a label is not a production guarantee. Better Auth provides session listing and revocation operations. Convex data must be gated by actual Convex authentication state because the Better Auth client session can appear before the Convex token has been validated. [Component authoring](https://docs.convex.dev/components/authoring), [session management](https://better-auth.com/docs/concepts/session-management), [Convex authorization guidance](https://labs.convex.dev/better-auth/basic-usage/authorization)

### Correction: disabling implicit linking does not cover email OTP

`account.accountLinking.disableImplicitLinking: true` prevents implicit same-email OAuth linking. It preserves explicit linking initiated by an authenticated user. It does not govern every route that can authenticate an existing user. [Users and accounts](https://better-auth.com/docs/concepts/users-accounts)

The stock email-OTP sign-in route verifies the email and signs into the existing user found by that email. This includes a user created through Google. Disabling OTP sign-up only prevents creation of a missing user; it does not require prior enrollment of OTP on an existing user. Therefore the OAuth flag alone does not implement Kiero's proof-of-both-methods rule. [Email OTP](https://better-auth.com/docs/plugins/email-otp)

A compliant integration needs an explicit method-enrollment policy and linking operation before a newly added method can issue a Kiero session. A generic before-hook can reject an attempt before code verification, but cannot alone perform a post-verification link. An after-hook must not be assumed to run before session creation. Custom plugins offer implementation options whose ordering and atomic behavior need exact-version inspection and tests. [Plugin interfaces](https://better-auth.com/docs/concepts/plugins)

## Calendar consent

Google recommends requesting additional permissions when the user needs the feature. Better Auth's Google integration defaults to including previously granted scopes and merges new grants into its account scope field. Reusing the login account's token storage for Calendar would couple their lifecycles. Use a separate Calendar connection and explicit permission flow, then prove that disconnecting it leaves login working. Do not assume that a separate OAuth client alone prevents all Google grant coupling. [Google sign-in best practices](https://developers.google.com/identity/siwg/best-practices), [Better Auth Google provider](https://better-auth.com/docs/authentication/google)

## Candidate recommendation and required evidence

Accepted candidate direction in Q186: evaluate Convex Auth first. The native SPA integration and pre-token account-linking callback are a plausible fit for Kiero's existing contract. Better Auth remains a researched alternative if the beta integration fails the agreed proof; it is not an automatically approved fallback. Production suitability remains unproved.

The proof must use pinned, published versions and cover Google and OTP sign-in, deliberate linking after both proofs, attempted same-email implicit linking in both directions, retry/concurrent linking, invitations and membership checks, the 30-day inactivity policy, and revocation while a client has a live token and subscriptions. It must also show that Calendar connection and disconnection preserve login. Library session deletion alone is not evidence that a previously issued token cannot read new data. Application authorization remains authoritative on reads, writes, subscriptions and background work.

No accounts, infrastructure, credentials or implementation were created for this research.
