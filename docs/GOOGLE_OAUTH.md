# Google OAuth and session design

## Endpoints

| Method | Route | Behavior |
| --- | --- | --- |
| `GET` | `/api/auth/google` | Creates a ten-minute D1 transaction and redirects to Google's authorization endpoint with PKCE S256, opaque state, and nonce. |
| `GET` | `/api/auth/google/callback` | Claims state once, exchanges the code, verifies Google JWKS-backed RS256 ID token claims, upserts the user, and creates a D1 session. |
| `POST` | `/api/auth/logout` | Deletes the presented opaque session and expires the session cookie. |

## Security controls

- State, nonce, session ID, and PKCE verifier are generated with Workers Web Crypto. State, nonce, and session IDs each have 256 bits of entropy; the verifier has 512 bits.
- The URL has only opaque state and PKCE challenge. The D1 transaction stores a SHA-256 state hash, verifier, nonce, expiry, and `used_at`; callback state is claimed with an atomic conditional update.
- Google ID tokens are never trusted from decoded JSON alone. The Worker requires `RS256`, imports the matching Google JWKS RSA signing key, verifies the signature, then validates issuer, audience/authorized party, time claims, nonce, subject, and verified email.
- Sessions are opaque 256-bit values in D1, expire after 30 days, and are sent only by `HttpOnly; Secure; SameSite=Lax; Path=/` cookies. API middleware checks both the D1 session and expiry on every request.
- OAuth errors deliberately collapse into generic `oauth_failed` responses; secrets, authorization codes, tokens, and identity claims are not logged.

## Operational boundary

This repository does not deploy OAuth credentials. Configure the exact redirect URI and Worker runtime values only when the user authorizes deployment. Test clients can use an `http://localhost/api/auth/google/callback` redirect URI; non-local callback URLs must use HTTPS.
