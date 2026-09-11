# Development authentication boundary

Production authentication is intentionally **not** replaced by a password or a header bypass. Domain routes require either a valid, unexpired D1-backed `home_measure_session` cookie or the explicit development-only identity below.

## Local development only

The Worker accepts a fixed development identity only when all of these conditions hold:

1. `ENVIRONMENT` is exactly `development`.
2. `DEV_AUTH_USER_ID` is a valid stable client ID (8–128 letters, digits, `_`, or `-`).
3. `DEV_AUTH_EMAIL` is a valid email address.

If any condition is absent or invalid, the request continues through the session check and is rejected with `401` when no valid session exists. `ENVIRONMENT=production` (and an unset environment) ignores every `DEV_AUTH_*` value. Do not put `DEV_AUTH_*` values into GitHub Actions production secrets or deployment configuration.

This boundary is for offline/local development only. In the explicitly enabled local mode, the Worker creates the fixed development identity as a `users` row with provider `development` if it does not already exist; it never creates a session, password, or OAuth credential. It must not be broadened into a production fallback.

## Production Google OAuth

Production Google OAuth is available only when `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `OAUTH_REDIRECT_URI` are all valid. Missing or malformed values make only `/api/auth/google` and `/api/auth/google/callback` return `503 {"error":"auth_unavailable"}`; the remaining API keeps its ordinary session/development boundary.

`GET /api/auth/google` creates a D1-backed, ten-minute transaction containing a SHA-256 state hash, PKCE verifier, and OIDC nonce. The browser receives only a random 256-bit `state` and an S256 PKCE challenge. Callback processing atomically marks the transaction used before exchanging the authorization code, so a state is single-use even if the callback is replayed.

The callback verifies the Google ID token's RS256 signature against the Google JWKS and checks `iss`, `aud`/`azp`, expiry, issued-at/not-before, nonce, `sub`, verified email, and bounded name before it upserts the Google user. It then creates a 256-bit opaque D1 session and redirects to the application root with this cookie:

`home_measure_session=<opaque-token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`

`POST /api/auth/logout` removes the presented session when one exists and always sends the same cookie with `Max-Age=0`. Authentication data, authorization codes, tokens, and secrets must never be logged.
