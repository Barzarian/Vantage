Add authentication to my existing Next.js market dashboard (App Router, TypeScript strict, Drizzle + Postgres, Zod, shadcn/ui, Tailwind). Use Auth.js (NextAuth v5) with the Drizzle adapter and OAuth only: Google and GitHub. No passwords, no credentials provider, no email/magic links. Today the app assumes a single user or a placeholder userId; replace that with real, enforced auth across pages, API routes, server actions, the streaming relay, and the alert worker. Don't change feature behavior beyond what auth requires.

## 1. Providers and sessions
- Providers: Google and GitHub, each enabled only if its env vars are present; the app must fail at startup if neither is configured
- Database sessions via the Drizzle adapter (not JWT-only), so sessions can be revoked server-side
- Tables: users, accounts (OAuth links), sessions, verificationTokens (required by the adapter). The OAuth `accounts` table collides with the existing brokerage `accounts` table; rename the brokerage table to `brokerage_accounts` in a migration and update all references.
- Account linking: only link providers with the same email when the provider reports that email as verified; never auto-link on an unverified email (GitHub can return unverified addresses, so fetch the primary verified email and reject sign-in if none exists)
- Sign-out and "sign out everywhere"; session list in settings with device and last-seen and revoke buttons
- Optional signup control: `ALLOWED_EMAILS` or `ALLOWED_EMAIL_DOMAINS` env allowlist to restrict who can sign in (empty means open)

## 2. Route protection
- Middleware (Edge-safe, cookie-presence check only) redirects unauthenticated users to /login with a validated `callbackUrl` (same-origin paths only, to prevent open redirects)
- Real authorization happens server-side: a `requireUser()` helper used in every server component, route handler, and server action; never trust middleware alone
- Public routes: /login, auth callback endpoints, health check; everything else protected
- /login page: shadcn card with "Continue with Google" and "Continue with GitHub" buttons, loading and error states (map Auth.js error codes to friendly messages, including OAuthAccountNotLinked and access denied by allowlist)
- Redirect signed-in users away from /login
- Unauthenticated API requests return 401 (JSON), not a redirect

## 3. Data scoping (the critical part)
- Add a `userId` foreign key (ON DELETE CASCADE) to every user-owned table that lacks one: watchlists, saved_layouts, saved_strategies, brokerage_accounts, alerts, notification_channels, push_subscriptions, and user settings. Child tables (watchlist_items, transactions, alert_events) must be scoped through their parent with joins or a denormalized userId.
- Migration plan for existing data: assign existing rows to the first user who signs in whose email matches `ADMIN_EMAIL` (or, if unset, the first user created); make the migration idempotent and explain the steps in the README
- Centralize queries in a data-access layer where every function takes `userId` as a required argument; add a lint rule or code-search test that fails if a table is queried outside this layer
- Optional defense in depth: Postgres row-level security with `SET LOCAL app.user_id` per request; implement if feasible, otherwise document why not
- Authorization failures on someone else's resource return 404, not 403

## 4. Real-time and background paths
- SSE/WebSocket relay: authenticate the connection from the session cookie, limit subscriptions per user (configurable cap), and reject cross-origin connections by checking Origin
- Alert worker: runs without a session, operates on alerts by their stored userId, and delivers only to that user's channels; add tests proving it never crosses users
- Provider keys stay server-side as before; per-user symbol subscription quotas so one account can't exhaust the vendor limit

## 5. Security hardening
- Cookies: HttpOnly, Secure in production, SameSite=Lax, `__Secure-`/`__Host-` prefixes where Auth.js allows
- CSRF: rely on Auth.js for its endpoints; for custom route handlers and server actions that mutate, verify the Origin header
- Rate limiting on sign-in initiation and callback routes, per IP (Upstash Redis or an in-DB fallback)
- Security headers (CSP, HSTS, X-Content-Type-Options, Referrer-Policy, frame-ancestors none); CSP must still allow lightweight-charts and Recharts, and the OAuth redirects
- Audit log table: sign-in, failed sign-in, provider link/unlink, session revoke, account deletion, with IP and user agent; viewable in settings
- Secrets validated at startup with Zod: AUTH_SECRET, AUTH_GOOGLE_ID/SECRET, AUTH_GITHUB_ID/SECRET, AUTH_URL; refuse to start in production if any needed value is missing or weak
- Never log tokens, OAuth secrets, or full session IDs
- Do not persist provider access/refresh tokens beyond what Auth.js requires; if the adapter stores them, request minimal scopes (openid, email, profile for Google; read:user, user:email for GitHub) and note it in the README

## 6. Settings and account management
- /settings/account: show name, email, and avatar (read-only, from the provider), connected providers with connect/disconnect (cannot remove the last sign-in method), sessions list with revoke, audit log, and delete account (typed confirmation, cascades all user data, cancels web push, revokes sessions)

## 7. Dev experience
- Seeded demo user and a dev-only sign-in bypass (`pnpm db:seed`), hard-disabled when NODE_ENV=production
- Test helper that creates a session directly in the DB for Playwright (OAuth can't be driven in CI)
- `.env.example` updated with every new variable, with a comment on how to generate AUTH_SECRET
- README: how to create Google and GitHub OAuth apps, exact callback URLs for dev and production (`/api/auth/callback/google`, `/api/auth/callback/github`), migration of existing data, and how `requireUser()` and the data-access layer must be used for new features

## 8. Tests
- Vitest: callbackUrl validation (reject //evil.com, absolute URLs, javascript:), account-linking rules (verified vs unverified email), allowlist logic, rate limiter, data-access functions reject missing userId
- Isolation tests: with two users, prove user A cannot read, update, or delete user B's watchlists, layouts, strategies, brokerage accounts, transactions, alerts, channels, or alert events (through every route handler and server action), and gets 404
- Playwright (using the session helper): unauthenticated visit redirects to /login with callbackUrl, signed-in user reaches protected pages, sign out redirects to /login, revoke another session, delete account and confirm data is gone, unauthenticated API request returns 401, and the relay rejects an unauthenticated connection

## Order of work
Verify after each step and summarize what works:
1. Schema, rename migration, Auth.js config with Google and GitHub, and env validation
2. Account linking rules, allowlist, and /login page
3. Middleware, requireUser(), and route protection
4. userId columns, data migration, and the scoped data-access layer
5. Retrofit every existing route handler, server action, relay, and the alert worker
6. Rate limiting, headers, audit log, and cookie hardening
7. Settings pages and account deletion
8. Isolation, unit, and Playwright tests, then known limitations
