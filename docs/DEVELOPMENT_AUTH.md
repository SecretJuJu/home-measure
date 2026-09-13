# Authentication boundary

Accounts belong to this app. There is no identity provider, no redirect, and no third-party
credential: a person picks a username and a password, and the Worker stores the password as a
PBKDF2 hash in its own D1 table. Domain routes require either a valid, unexpired D1-backed
`home_measure_session` cookie or the explicit development-only identity below.

## Accounts

`POST /api/auth/register` and `POST /api/auth/login` both take `{"username","password"}`.

- A username is 3–32 characters of letters, digits, `.`, `_` or `-`, compared case-insensitively.
- A password is at least 10 characters, capped at 200, and is never stored or logged in the clear.
- Registration hashes with PBKDF2-HMAC-SHA256 at 100,000 iterations (the most the Workers runtime allows) and a fresh 128-bit salt. The
  record is `pbkdf2-sha256$<iterations>$<salt>$<hash>`, so the cost can be raised later without
  invalidating existing passwords.
- A taken username answers `409 {"error":"conflict"}`. A wrong password and an unknown username both
  answer `401 {"error":"unauthorized"}` after the same hashing work, so neither reveals whether an
  account exists.

Both endpoints answer with the account and set the session cookie:

`home_measure_session=<opaque-token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`

`POST /api/auth/logout` removes the presented session when one exists and always sends the same
cookie with `Max-Age=0`.

The web app never blocks on an account. Measurements are written to IndexedDB first and queued; a
session is only what lets that queue reach the server.

## Local development only

The Worker accepts a fixed development identity only when all of these conditions hold:

1. `ENVIRONMENT` is exactly `development`.
2. `DEV_AUTH_USER_ID` is a valid stable client ID (8–128 letters, digits, `_`, or `-`).
3. `DEV_AUTH_USERNAME` satisfies the username rules above.

If any condition is absent or invalid, the request continues through the session check and is
rejected with `401` when no valid session exists. `ENVIRONMENT=production` (and an unset
environment) ignores every `DEV_AUTH_*` value. Do not put `DEV_AUTH_*` values into GitHub Actions
production secrets or deployment configuration.

In that explicitly enabled local mode the Worker creates the development identity as a `users` row
with an empty password hash, which no password can match. It must not be broadened into a
production fallback.
