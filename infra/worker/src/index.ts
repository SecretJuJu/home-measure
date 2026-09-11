import {
  checklistCreateMutationSchema,
  checklistUpdateMutationSchema,
  clientIdSchema,
  clientMutationIdSchema,
  emptyMutationSchema,
  measurementCreateMutationSchema,
  measurementUpdateMutationSchema,
  photoCreateMutationSchema,
  propertyCreateMutationSchema,
  propertyUpdateMutationSchema,
  roomCreateMutationSchema,
  roomLayoutMutationSchema,
  roomUpdateMutationSchema,
} from "@home-measure/domain";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { z } from "zod";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  PHOTO_BUCKET: R2Bucket;
  /** Google OAuth web client ID. Required only by the OAuth endpoints. */
  GOOGLE_CLIENT_ID?: string;
  /** Google OAuth web client secret. Keep this in a Worker secret, never wrangler.jsonc. */
  GOOGLE_CLIENT_SECRET?: string;
  /** Exact registered callback URL, ending in /api/auth/google/callback. */
  OAUTH_REDIRECT_URI?: string;
  /** Must be exactly `development` before the development identity is considered. */
  ENVIRONMENT?: string;
  /** Development-only identity. It is ignored outside ENVIRONMENT=development. */
  DEV_AUTH_USER_ID?: string;
  DEV_AUTH_EMAIL?: string;
  DEV_AUTH_NAME?: string;
}

interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

interface AppEnv {
  Bindings: Env;
  Variables: {
    authUser: AuthUser;
  };
}

interface PropertyRow extends Record<string, unknown> {
  id: string;
  name: string;
  address: string | null;
  note: string | null;
  created_at: number;
  updated_at: number;
}

interface RoomRow extends Record<string, unknown> {
  id: string;
  property_id: string;
  name: string;
  type: string;
  layout_json: string;
  created_at: number;
  updated_at: number;
}

interface StoredMutationRow extends Record<string, unknown> {
  response_status: number;
  response_json: string;
}

interface MutationResult {
  status: 200 | 201;
  body: Record<string, unknown>;
}

interface PhotoRow extends Record<string, unknown> {
  id: string;
  r2_key: string;
  mime_type: string;
  upload_status: "pending" | "uploaded";
}

interface OAuthTransactionRow extends Record<string, unknown> {
  state_hash: string;
  pkce_verifier: string;
  nonce: string;
  expires_at: number;
  used_at: number | null;
}

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  postLoginUri: string;
}

interface GoogleIdTokenClaims {
  sub: string;
  email: string;
  name: string | null;
}

export interface OAuthDependencies {
  /** Injectable only to make the external Google calls testable. */
  fetch?: typeof fetch;
}

const sessionCookieName = "home_measure_session";
const oauthStateBytes = 32;
const oauthVerifierBytes = 64;
const oauthTransactionLifetimeMs = 10 * 60 * 1000;
const sessionLifetimeSeconds = 30 * 24 * 60 * 60;
const googleAuthorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
const googleTokenEndpoint = "https://oauth2.googleapis.com/token";
const googleJwksEndpoint = "https://www.googleapis.com/oauth2/v3/certs";
const maxPhotoUploadBytes = 12 * 1024 * 1024;
const allowedPhotoMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

function jsonError(status: number, code: "invalid_request" | "unauthorized" | "not_found" | "conflict" | "internal_error" | "auth_unavailable" | "oauth_failed"): Response {
  return Response.json({ error: code }, { status });
}

function now(): number {
  return Date.now();
}

function getSessionId(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === sessionCookieName) {
      const sessionId = value.join("=");
      return /^[A-Za-z0-9_-]{43}$/.test(sessionId) ? sessionId : null;
    }
  }
  return null;
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function arrayBufferCopy(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function oauthConfig(env: Env): OAuthConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const redirectUri = env.OAUTH_REDIRECT_URI?.trim();
  if (!clientId || clientId.length > 512 || !clientSecret || clientSecret.length > 1024 || !redirectUri || redirectUri.length > 2048) return null;
  try {
    const callback = new URL(redirectUri);
    const isLocalHttp = callback.protocol === "http:" && (callback.hostname === "localhost" || callback.hostname === "127.0.0.1");
    if ((!isLocalHttp && callback.protocol !== "https:") || callback.username || callback.password
      || callback.pathname !== "/api/auth/google/callback" || callback.search || callback.hash) return null;
    return { clientId, clientSecret, redirectUri: callback.toString(), postLoginUri: new URL("/", callback).toString() };
  } catch {
    return null;
  }
}

function noStoreRedirect(location: string, status: 302 | 303 = 302): Response {
  return new Response(null, {
    status,
    headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

function sessionCookie(sessionId: string, maxAge: number): string {
  return `${sessionCookieName}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJsonSegment(value: string, maxLength: number): Record<string, unknown> | null {
  if (value.length > maxLength) return null;
  const bytes = base64UrlDecode(value);
  if (!bytes) return null;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(decoded);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validGoogleAudience(value: unknown, clientId: string, authorizedParty: unknown): boolean {
  if (typeof value === "string") return value === clientId;
  if (!Array.isArray(value) || value.length === 0 || value.length > 10 || !value.every((entry) => typeof entry === "string")) return false;
  return value.includes(clientId) && typeof authorizedParty === "string" && authorizedParty === clientId;
}

function numericClaim(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

async function verifyGoogleIdToken(idToken: string, config: OAuthConfig, nonce: string, requestFetch: typeof fetch): Promise<GoogleIdTokenClaims | null> {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2] || idToken.length > 12_000) return null;
  const header = decodeJsonSegment(parts[0], 2_048);
  const claims = decodeJsonSegment(parts[1], 8_192);
  const signature = base64UrlDecode(parts[2]);
  if (!header || !claims || !signature || header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length === 0 || header.kid.length > 128) return null;

  let jwksResponse: Response;
  try {
    jwksResponse = await requestFetch(googleJwksEndpoint, { headers: { accept: "application/json" } });
  } catch {
    return null;
  }
  if (!jwksResponse.ok) return null;
  let jwks: unknown;
  try {
    jwks = await jwksResponse.json();
  } catch {
    return null;
  }
  if (!isRecord(jwks) || !Array.isArray(jwks.keys) || jwks.keys.length === 0 || jwks.keys.length > 20) return null;
  const matchingKey = jwks.keys.find((key): key is Record<string, unknown> => isRecord(key) && key.kid === header.kid);
  if (!matchingKey || matchingKey.kty !== "RSA" || typeof matchingKey.n !== "string" || typeof matchingKey.e !== "string"
    || (matchingKey.alg !== undefined && matchingKey.alg !== "RS256") || (matchingKey.use !== undefined && matchingKey.use !== "sig")) return null;
  if (matchingKey.key_ops !== undefined && (!Array.isArray(matchingKey.key_ops) || !matchingKey.key_ops.includes("verify"))) return null;

  let signatureValid: boolean;
  try {
    const key = await crypto.subtle.importKey("jwk", matchingKey as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    signatureValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      arrayBufferCopy(signature),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return null;
  }
  if (!signatureValid) return null;

  const issuedAt = numericClaim(claims.iat);
  const expiresAt = numericClaim(claims.exp);
  const notBefore = claims.nbf === undefined ? null : numericClaim(claims.nbf);
  const currentSeconds = Math.floor(now() / 1_000);
  if (issuedAt === null || expiresAt === null || (notBefore === null && claims.nbf !== undefined)
    || expiresAt <= currentSeconds || issuedAt > currentSeconds + 300 || expiresAt <= issuedAt || expiresAt - issuedAt > 7_200
    || (notBefore !== null && notBefore > currentSeconds + 60)) return null;
  if ((claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com")
    || !validGoogleAudience(claims.aud, config.clientId, claims.azp) || typeof claims.nonce !== "string" || !constantTimeEqual(claims.nonce, nonce)
    || typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.length > 255
    || !zEmail.safeParse(claims.email).success || claims.email_verified !== true) return null;
  return { sub: claims.sub, email: claims.email as string, name: typeof claims.name === "string" && claims.name.length <= 200 ? claims.name : null };
}

const zEmail = {
  safeParse(value: unknown): { success: true; data: string } | { success: false } {
    if (typeof value !== "string" || value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return { success: false };
    }
    return { success: true, data: value };
  },
};

function developmentUser(env: Env): AuthUser | null {
  if (env.ENVIRONMENT !== "development") return null;
  const userId = clientIdSchema.safeParse(env.DEV_AUTH_USER_ID);
  const email = zEmail.safeParse(env.DEV_AUTH_EMAIL);
  if (!userId.success || !email.success) return null;
  return { id: userId.data, email: email.data, name: env.DEV_AUTH_NAME?.trim() || null };
}

async function createOAuthTransaction(db: D1Database): Promise<{ state: string; verifier: string; nonce: string }> {
  const state = randomToken(oauthStateBytes);
  const verifier = randomToken(oauthVerifierBytes);
  const nonce = randomToken(oauthStateBytes);
  const timestamp = now();
  const stateHash = await sha256Base64Url(state);
  await db.prepare("DELETE FROM oauth_transactions WHERE expires_at <= ?").bind(timestamp).run();
  await db.prepare(
    `INSERT INTO oauth_transactions (state_hash, pkce_verifier, nonce, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).bind(stateHash, verifier, nonce, timestamp + oauthTransactionLifetimeMs, timestamp).run();
  return { state, verifier, nonce };
}

async function claimOAuthTransaction(db: D1Database, state: string): Promise<OAuthTransactionRow | null> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(state)) return null;
  const stateHash = await sha256Base64Url(state);
  const transaction = await db.prepare(
    `SELECT state_hash, pkce_verifier, nonce, expires_at, used_at
     FROM oauth_transactions WHERE state_hash = ?`,
  ).bind(stateHash).first<OAuthTransactionRow>();
  if (!transaction || transaction.used_at !== null || transaction.expires_at <= now() || !constantTimeEqual(transaction.state_hash, stateHash)) return null;
  const claimResult = await db.prepare(
    `UPDATE oauth_transactions SET used_at = ?
     WHERE state_hash = ? AND expires_at > ? AND used_at IS NULL`,
  ).bind(now(), stateHash, now()).run();
  return claimResult.meta.changes === 1 ? transaction : null;
}

async function exchangeAuthorizationCode(
  code: string,
  transaction: OAuthTransactionRow,
  config: OAuthConfig,
  requestFetch: typeof fetch,
): Promise<string | null> {
  let response: Response;
  try {
    response = await requestFetch(googleTokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        code_verifier: transaction.pkce_verifier,
        grant_type: "authorization_code",
      }),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  return isRecord(payload) && typeof payload.id_token === "string" && payload.id_token.length > 0 && payload.id_token.length <= 12_000
    ? payload.id_token
    : null;
}

async function upsertGoogleUser(db: D1Database, claims: GoogleIdTokenClaims): Promise<AuthUser | null> {
  const userId = randomToken(oauthStateBytes);
  try {
    await db.prepare(
      `INSERT INTO users (id, email, name, provider, provider_user_id, created_at)
       VALUES (?, ?, ?, 'google', ?, ?)
       ON CONFLICT(provider, provider_user_id) DO UPDATE SET email = excluded.email, name = excluded.name`,
    ).bind(userId, claims.email, claims.name, claims.sub, now()).run();
    return await db.prepare(
      "SELECT id, email, name FROM users WHERE provider = 'google' AND provider_user_id = ?",
    ).bind(claims.sub).first<AuthUser>();
  } catch {
    return null;
  }
}

async function createSession(db: D1Database, userId: string): Promise<string | null> {
  const sessionId = randomToken(oauthStateBytes);
  const timestamp = now();
  try {
    await db.prepare(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).bind(sessionId, userId, timestamp + sessionLifetimeSeconds * 1_000, timestamp).run();
    return sessionId;
  } catch {
    return null;
  }
}

const authenticate: MiddlewareHandler<AppEnv> = async (context, next) => {
  const devUser = developmentUser(context.env);
  if (devUser) {
    await context.env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, email, name, provider, provider_user_id, created_at)
       VALUES (?, ?, ?, 'development', ?, ?)`,
    ).bind(devUser.id, devUser.email, devUser.name, devUser.id, now()).run();
    context.set("authUser", devUser);
    await next();
    return;
  }
  const sessionId = getSessionId(context.req.raw);
  if (!sessionId) return jsonError(401, "unauthorized");
  const user = await context.env.DB.prepare(
    `SELECT users.id, users.email, users.name
     FROM sessions INNER JOIN users ON users.id = sessions.user_id
     WHERE sessions.id = ? AND sessions.expires_at > ?`,
  ).bind(sessionId, now()).first<AuthUser>();
  if (!user) return jsonError(401, "unauthorized");
  context.set("authUser", user);
  await next();
};

async function readJson<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T> | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  const result = schema.safeParse(body);
  return result.success ? result.data : null;
}

function validPathId(value: string): string | null {
  const result = clientIdSchema.safeParse(value);
  return result.success ? result.data : null;
}

async function ownsProperty(db: D1Database, propertyId: string, userId: string): Promise<boolean> {
  const result = await db.prepare("SELECT id FROM properties WHERE id = ? AND user_id = ?")
    .bind(propertyId, userId).first<{ id: string }>();
  return result !== null;
}

async function ownedRoom(db: D1Database, roomId: string, userId: string): Promise<RoomRow | null> {
  return db.prepare(
    `SELECT rooms.id, rooms.property_id, rooms.name, rooms.type, rooms.layout_json, rooms.created_at, rooms.updated_at
     FROM rooms INNER JOIN properties ON properties.id = rooms.property_id
     WHERE rooms.id = ? AND properties.user_id = ?`,
  ).bind(roomId, userId).first<RoomRow>();
}

async function roomBelongsToProperty(db: D1Database, roomId: string, propertyId: string, userId: string): Promise<boolean> {
  const result = await db.prepare(
    `SELECT rooms.id FROM rooms INNER JOIN properties ON properties.id = rooms.property_id
     WHERE rooms.id = ? AND rooms.property_id = ? AND properties.user_id = ?`,
  ).bind(roomId, propertyId, userId).first<{ id: string }>();
  return result !== null;
}

async function ownsChecklist(db: D1Database, checklistId: string, userId: string): Promise<boolean> {
  const result = await db.prepare(
    `SELECT checklist_items.id FROM checklist_items
     INNER JOIN properties ON properties.id = checklist_items.property_id
     WHERE checklist_items.id = ? AND properties.user_id = ?`,
  ).bind(checklistId, userId).first<{ id: string }>();
  return result !== null;
}

async function checklistBelongsToProperty(
  db: D1Database,
  checklistId: string,
  propertyId: string,
  userId: string,
): Promise<boolean> {
  const result = await db.prepare(
    `SELECT checklist_items.id FROM checklist_items
     INNER JOIN properties ON properties.id = checklist_items.property_id
     WHERE checklist_items.id = ? AND checklist_items.property_id = ? AND properties.user_id = ?`,
  ).bind(checklistId, propertyId, userId).first<{ id: string }>();
  return result !== null;
}

async function ownsMeasurement(db: D1Database, measurementId: string, userId: string): Promise<boolean> {
  const result = await db.prepare(
    `SELECT measurements.id FROM measurements
     INNER JOIN properties ON properties.id = measurements.property_id
     WHERE measurements.id = ? AND properties.user_id = ?`,
  ).bind(measurementId, userId).first<{ id: string }>();
  return result !== null;
}

async function ownedPhoto(db: D1Database, photoId: string, userId: string): Promise<PhotoRow | null> {
  return db.prepare(
    `SELECT photos.id, photos.r2_key, photos.mime_type, photos.upload_status FROM photos
     INNER JOIN properties ON properties.id = photos.property_id
     WHERE photos.id = ? AND photos.user_id = ? AND properties.user_id = ?`,
  ).bind(photoId, userId, userId).first<PhotoRow>();
}

function photoObjectKey(propertyId: string, photoId: string, mimeType: string): string | null {
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : null;
  return extension ? `photos/${propertyId}/${photoId}.${extension}` : null;
}

function imageContentType(request: Request): string | null {
  const value = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return value && allowedPhotoMimeTypes.has(value) ? value : null;
}

async function boundedImageBody(request: Request): Promise<ArrayBuffer | null> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length <= 0 || length > maxPhotoUploadBytes) return null;
  }
  try {
    const body = await request.arrayBuffer();
    return body.byteLength > 0 && body.byteLength <= maxPhotoUploadBytes ? body : null;
  } catch {
    return null;
  }
}

async function savedMutation(db: D1Database, userId: string, clientMutationId: string): Promise<MutationResult | null> {
  const row = await db.prepare(
    `SELECT response_status, response_json FROM idempotent_mutations
     WHERE user_id = ? AND client_mutation_id = ?`,
  ).bind(userId, clientMutationId).first<StoredMutationRow>();
  if (!row || (row.response_status !== 200 && row.response_status !== 201)) return null;
  try {
    const body: unknown = JSON.parse(row.response_json);
    return isRecord(body) ? { status: row.response_status, body } : null;
  } catch {
    return null;
  }
}

async function runMutation(
  db: D1Database,
  userId: string,
  clientMutationId: string,
  operation: () => Promise<MutationResult>,
): Promise<MutationResult> {
  const alreadySaved = await savedMutation(db, userId, clientMutationId);
  if (alreadySaved) return alreadySaved;
  const result = await operation();
  try {
    await db.prepare(
      `INSERT INTO idempotent_mutations
       (user_id, client_mutation_id, response_status, response_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(userId, clientMutationId, result.status, JSON.stringify(result.body), now()).run();
  } catch {
    const concurrentResult = await savedMutation(db, userId, clientMutationId);
    if (concurrentResult) return concurrentResult;
    throw new Error("Could not persist an idempotent mutation result");
  }
  return result;
}

async function verifyOptionalRoom(
  db: D1Database,
  roomId: string | null | undefined,
  propertyId: string,
  userId: string,
): Promise<boolean> {
  return roomId === null || roomId === undefined || roomBelongsToProperty(db, roomId, propertyId, userId);
}

function asProperty(row: PropertyRow): Record<string, unknown> {
  return {
    id: row.id, name: row.name, address: row.address, note: row.note,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function asRoom(row: RoomRow): Record<string, unknown> {
  let layout: unknown = null;
  try { layout = JSON.parse(row.layout_json); } catch { /* malformed documents stay opaque */ }
  return {
    id: row.id, propertyId: row.property_id, name: row.name, type: row.type, layout,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function createApp(dependencies: OAuthDependencies = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const requestFetch = dependencies.fetch ?? globalThis.fetch;
  app.onError(() => jsonError(500, "internal_error"));
  app.get("/api/health", (context) => context.json({ status: "ok" }));

  app.get("/api/auth/google", async (context) => {
    const config = oauthConfig(context.env);
    if (!config) return jsonError(503, "auth_unavailable");
    const transaction = await createOAuthTransaction(context.env.DB);
    const challenge = await sha256Base64Url(transaction.verifier);
    const authorizationUrl = new URL(googleAuthorizationEndpoint);
    authorizationUrl.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return noStoreRedirect(authorizationUrl.toString());
  });

  app.get("/api/auth/google/callback", async (context) => {
    const config = oauthConfig(context.env);
    if (!config) return jsonError(503, "auth_unavailable");
    const query = new URL(context.req.url).searchParams;
    const states = query.getAll("state");
    const codes = query.getAll("code");
    if (states.length !== 1 || codes.length !== 1 || !states[0] || !codes[0] || codes[0].length > 2_048) return jsonError(400, "oauth_failed");
    const transaction = await claimOAuthTransaction(context.env.DB, states[0]);
    if (!transaction) return jsonError(400, "oauth_failed");
    const idToken = await exchangeAuthorizationCode(codes[0], transaction, config, requestFetch);
    if (!idToken) return jsonError(400, "oauth_failed");
    const claims = await verifyGoogleIdToken(idToken, config, transaction.nonce, requestFetch);
    if (!claims) return jsonError(400, "oauth_failed");
    const user = await upsertGoogleUser(context.env.DB, claims);
    if (!user) return jsonError(400, "oauth_failed");
    const sessionId = await createSession(context.env.DB, user.id);
    if (!sessionId) return jsonError(400, "oauth_failed");
    const response = noStoreRedirect(config.postLoginUri, 303);
    response.headers.set("Set-Cookie", sessionCookie(sessionId, sessionLifetimeSeconds));
    return response;
  });

  app.post("/api/auth/logout", async (context) => {
    const sessionId = getSessionId(context.req.raw);
    if (sessionId) await context.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
    return new Response(null, {
      status: 204,
      headers: { "Set-Cookie": sessionCookie("", 0), "Cache-Control": "no-store" },
    });
  });

  app.use("/api/*", authenticate);
  app.get("/api/me", (context) => context.json({ user: context.get("authUser") }));

  app.get("/api/properties", async (context) => {
    const user = context.get("authUser");
    const rows = await context.env.DB.prepare(
      `SELECT id, name, address, note, created_at, updated_at FROM properties
       WHERE user_id = ? ORDER BY updated_at DESC`,
    ).bind(user.id).all<PropertyRow>();
    return context.json({ properties: rows.results.map(asProperty) });
  });

  app.post("/api/properties", async (context) => {
    const input = await readJson(context.req.raw, propertyCreateMutationSchema);
    if (!input) return jsonError(400, "invalid_request");
    const user = context.get("authUser");
    const result = await runMutation(context.env.DB, user.id, input.clientMutationId, async () => {
      const timestamp = now();
      await context.env.DB.prepare(
        `INSERT INTO properties (id, user_id, name, address, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(input.data.id, user.id, input.data.name, input.data.address ?? null, input.data.note ?? null, timestamp, timestamp).run();
      return { status: 201, body: { property: { ...input.data, address: input.data.address ?? null, note: input.data.note ?? null, createdAt: timestamp, updatedAt: timestamp } } };
    });
    return Response.json(result.body, { status: result.status });
  });

  app.get("/api/properties/:id", async (context) => {
    const propertyId = validPathId(context.req.param("id"));
    if (!propertyId) return jsonError(400, "invalid_request");
    const user = context.get("authUser");
    const property = await context.env.DB.prepare(
      `SELECT id, name, address, note, created_at, updated_at FROM properties
       WHERE id = ? AND user_id = ?`,
    ).bind(propertyId, user.id).first<PropertyRow>();
    if (!property) return jsonError(404, "not_found");
    const rooms = await context.env.DB.prepare(
      `SELECT id, property_id, name, type, layout_json, created_at, updated_at
       FROM rooms WHERE property_id = ? ORDER BY created_at`,
    ).bind(propertyId).all<RoomRow>();
    return context.json({ property: asProperty(property), rooms: rooms.results.map(asRoom) });
  });

  app.patch("/api/properties/:id", async (context) => {
    const propertyId = validPathId(context.req.param("id"));
    const input = await readJson(context.req.raw, propertyUpdateMutationSchema);
    if (!propertyId || !input) return jsonError(400, "invalid_request");
    const user = context.get("authUser");
    if (!await ownsProperty(context.env.DB, propertyId, user.id)) return jsonError(404, "not_found");
    const result = await runMutation(context.env.DB, user.id, input.clientMutationId, async () => {
      const timestamp = now();
      await context.env.DB.prepare(
        `UPDATE properties SET name = COALESCE(?, name), address = CASE WHEN ? = 1 THEN ? ELSE address END,
         note = CASE WHEN ? = 1 THEN ? ELSE note END, updated_at = ? WHERE id = ? AND user_id = ?`,
      ).bind(
        input.data.name ?? null, Object.hasOwn(input.data, "address") ? 1 : 0, input.data.address ?? null,
        Object.hasOwn(input.data, "note") ? 1 : 0, input.data.note ?? null, timestamp, propertyId, user.id,
      ).run();
      return { status: 200, body: { property: { id: propertyId, ...input.data, updatedAt: timestamp } } };
    });
    return Response.json(result.body, { status: result.status });
  });

  app.delete("/api/properties/:id", async (context) => {
    const propertyId = validPathId(context.req.param("id"));
    const input = await readJson(context.req.raw, emptyMutationSchema);
    if (!propertyId || !input) return jsonError(400, "invalid_request");
    const user = context.get("authUser");
    if (!await ownsProperty(context.env.DB, propertyId, user.id)) return jsonError(404, "not_found");
    const result = await runMutation(context.env.DB, user.id, input.clientMutationId, async () => {
      await context.env.DB.prepare("DELETE FROM properties WHERE id = ? AND user_id = ?").bind(propertyId, user.id).run();
      return { status: 200, body: { deletedId: propertyId } };
    });
    return Response.json(result.body, { status: result.status });
  });

  app.post("/api/properties/:id/rooms", async (context) => {
    const propertyId = validPathId(context.req.param("id"));
    const input = await readJson(context.req.raw, roomCreateMutationSchema);
    if (!propertyId || !input) return jsonError(400, "invalid_request");
    const user = context.get("authUser");
    if (!await ownsProperty(context.env.DB, propertyId, user.id)) return jsonError(404, "not_found");
    const result = await runMutation(context.env.DB, user.id, input.clientMutationId, async () => {
      const timestamp = now();
      await context.env.DB.prepare(
        `INSERT INTO rooms (id, property_id, name, type, layout_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(input.data.id, propertyId, input.data.name, input.data.type, JSON.stringify(input.data.layout), timestamp, timestamp).run();
      return { status: 201, body: { room: { ...input.data, propertyId, createdAt: timestamp, updatedAt: timestamp } } };
    });
    return Response.json(result.body, { status: result.status });
  });

  app.patch("/api/rooms/:id", async (context) => {
    const roomId = validPathId(context.req.param("id"));
    const input = await readJson(context.req.raw, roomUpdateMutationSchema);
    if (!roomId || !input) return jsonError(400, "invalid_request");
    const user = context.get("authUser");
    if (!await ownedRoom(context.env.DB, roomId, user.id)) return jsonError(404, "not_found");
    const result = await runMutation(context.env.DB, user.id, input.clientMutationId, async () => {
      const timestamp = now();
      await context.env.DB.prepare(
        "UPDATE rooms SET name = COALESCE(?, name), type = COALESCE(?, type), updated_at = ? WHERE id = ?",
      ).bind(input.data.name ?? null, input.data.type ?? null, timestamp, roomId).run();
      return { status: 200, body: { room: { id: roomId, ...input.data, updatedAt: timestamp } } };
    });
    return Response.json(result.body, { status: result.status });
  });

  app.delete("/api/rooms/:id", async (context) => {
    const roomId = validPathId(context.req.param("id"));
    const input = await readJson(context.req.raw, emptyMutationSchema);
    if (!roomId || !input) return jsonError(400, "invalid_request");
    const user = context.get("authUser");
    if (!await ownedRoom(context.env.DB, roomId, user.id)) return jsonError(404, "not_found");
    const result = await runMutation(context.env.DB, user.id, input.clientMutationId, async () => {
      await context.env.DB.prepare("DELETE FROM rooms WHERE id = ?").bind(roomId).run();
      return { status: 200, body: { deletedId: roomId } };
    });
    return Response.json(result.body, { status: result.status });
  });

  app.put("/api/rooms/:id/layout", async (context) => {
    const roomId = validPathId(context.req.param("id"));
    const input = await readJson(context.req.raw, roomLayoutMutationSchema);
    if (!roomId || !input) return jsonError(400, "invalid_request");
    const user = context.get("authUser");
    if (!await ownedRoom(context.env.DB, roomId, user.id)) return jsonError(404, "not_found");
    const result = await runMutation(context.env.DB, user.id, input.clientMutationId, async () => {
      const timestamp = now();
      await context.env.DB.prepare("UPDATE rooms SET layout_json = ?, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(input.data), timestamp, roomId).run();
      return { status: 200, body: { room: { id: roomId, layout: input.data, updatedAt: timestamp } } };
    });
    return Response.json(result.body, { status: result.status });
  });

  app.get("/api/properties/:id/checklist", async (context) => {
    const propertyId = validPathId(context.req.param("id"));
    if (!propertyId) return jsonError(400, "invalid_request");
    const user = context.get("authUser");
    if (!await ownsProperty(context.env.DB, propertyId, user.id)) return jsonError(404, "not_found");
    const result = await context.env.DB.prepare(
      `SELECT id, property_id, room_id, element_id, label, category, required, status, measurement_id,
       sort_order, created_at, updated_at FROM checklist_items WHERE property_id = ? ORDER BY sort_order, created_at`,
    ).bind(propertyId).all<Record<string, unknown>>();
    return context.json({ checklist: result.results });
  });

  app.post("/api/checklist", async (context) => {
    const input = await readJson(context.req.raw, checklistCreateMutationSchema);
    if (!input) return jsonError(400, "invalid_request");
    const user = context.get("authUser");
    if (!await ownsProperty(context.env.DB, input.data.propertyId, user.id)
      || !await verifyOptionalRoom(context.env.DB, input.data.roomId, input.data.propertyId, user.id)
      || (input.data.measurementId !== null && input.data.measurementId !== undefined
        && !await ownsMeasurement(context.env.DB, input.data.measurementId, user.id))) return jsonError(404, "not_found");
    const result = await runMutation(context.env.DB, user.id, input.clientMutationId, async () => {
      const timestamp = now();
      await context.env.DB.prepare(
        `INSERT INTO checklist_items
         (id, property_id, room_id, element_id, label, category, required, status, measurement_id, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        input.data.id, input.data.propertyId, input.data.roomId ?? null, input.data.elementId ?? null,
        input.data.label, input.data.category ?? null, input.data.required ? 1 : 0, input.data.status,
        input.data.measurementId ?? null, input.data.sortOrder, timestamp, timestamp,
      ).run();
      return { status: 201, body: { checklistItem: { ...input.data, createdAt: timestamp, updatedAt: timestamp } } };
    });
    return Response.json(result.body, { status: result.status });
  });

  app.patch("/api/checklist/:id", async (context) => {
    const checklistId = validPathId(context.req.param("id"));
    const input = await readJson(context.req.raw, checklistUpdateMutationSchema);
    if (!checklistId || !input) return jsonError(400, "invalid_request");
    const user = context.get("authUser");
    if (!await ownsChecklist(context.env.DB, checklistId, user.id)) return jsonError(404, "not_found");
    if (input.data.measurementId !== null && input.data.measurementId !== undefined
      && !await ownsMeasurement(context.env.DB, input.data.measurementId, user.id)) return jsonError(404, "not_found");
    const result = await runMutation(context.env.DB, user.id, input.clientMutationId, async () => {
      const timestamp = now();
      const data = input.data;
      await context.env.DB.prepare(
        `UPDATE checklist_items SET label = COALESCE(?, label), category = CASE WHEN ? = 1 THEN ? ELSE category END,
         required = COALESCE(?, required), status = COALESCE(?, status),
         measurement_id = CASE WHEN ? = 1 THEN ? ELSE measurement_id END,
         sort_order = COALESCE(?, sort_order), element_id = CASE WHEN ? = 1 THEN ? ELSE element_id END,
         updated_at = ? WHERE id = ?`,
      ).bind(
        data.label ?? null, Object.hasOwn(data, "category") ? 1 : 0, data.category ?? null,
        data.required === undefined ? null : data.required ? 1 : 0, data.status ?? null,
        Object.hasOwn(data, "measurementId") ? 1 : 0, data.measurementId ?? null, data.sortOrder ?? null,
        Object.hasOwn(data, "elementId") ? 1 : 0, data.elementId ?? null, timestamp, checklistId,
      ).run();
      return { status: 200, body: { checklistItem: { id: checklistId, ...data, updatedAt: timestamp } } };
    });
    return Response.json(result.body, { status: result.status });
  });

  app.post("/api/measurements", async (context) => {
    const input = await readJson(context.req.raw, measurementCreateMutationSchema);
    if (!input) return jsonError(400, "invalid_request");
    const user = context.get("authUser");
    if (!await ownsProperty(context.env.DB, input.data.propertyId, user.id)
      || !await verifyOptionalRoom(context.env.DB, input.data.roomId, input.data.propertyId, user.id)
      || (input.data.checklistItemId !== null && input.data.checklistItemId !== undefined
        && !await checklistBelongsToProperty(context.env.DB, input.data.checklistItemId, input.data.propertyId, user.id))) return jsonError(404, "not_found");
    const result = await runMutation(context.env.DB, user.id, input.clientMutationId, async () => {
      const timestamp = now();
      await context.env.DB.prepare(
        `INSERT INTO measurements
         (id, property_id, room_id, element_id, checklist_item_id, type, value, unit, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        input.data.id, input.data.propertyId, input.data.roomId ?? null, input.data.elementId ?? null,
        input.data.checklistItemId ?? null, input.data.type, input.data.value ?? null, input.data.unit,
        input.data.note ?? null, timestamp, timestamp,
      ).run();
      if (input.data.checklistItemId && input.data.value !== null && input.data.value !== undefined) {
        await context.env.DB.prepare(
          "UPDATE checklist_items SET status = 'complete', measurement_id = ?, updated_at = ? WHERE id = ?",
        ).bind(input.data.id, timestamp, input.data.checklistItemId).run();
      }
      return { status: 201, body: { measurement: { ...input.data, createdAt: timestamp, updatedAt: timestamp } } };
    });
    return Response.json(result.body, { status: result.status });
  });

  app.patch("/api/measurements/:id", async (context) => {
    const measurementId = validPathId(context.req.param("id"));
    const input = await readJson(context.req.raw, measurementUpdateMutationSchema);
    if (!measurementId || !input) return jsonError(400, "invalid_request");
    const user = context.get("authUser");
    if (!await ownsMeasurement(context.env.DB, measurementId, user.id)) return jsonError(404, "not_found");
    if (input.data.checklistItemId !== null && input.data.checklistItemId !== undefined
      && !await ownsChecklist(context.env.DB, input.data.checklistItemId, user.id)) return jsonError(404, "not_found");
    const result = await runMutation(context.env.DB, user.id, input.clientMutationId, async () => {
      const timestamp = now();
      const data = input.data;
      await context.env.DB.prepare(
        `UPDATE measurements SET element_id = CASE WHEN ? = 1 THEN ? ELSE element_id END,
         checklist_item_id = CASE WHEN ? = 1 THEN ? ELSE checklist_item_id END, type = COALESCE(?, type),
         value = CASE WHEN ? = 1 THEN ? ELSE value END, unit = COALESCE(?, unit),
         note = CASE WHEN ? = 1 THEN ? ELSE note END, updated_at = ? WHERE id = ?`,
      ).bind(
        Object.hasOwn(data, "elementId") ? 1 : 0, data.elementId ?? null,
        Object.hasOwn(data, "checklistItemId") ? 1 : 0, data.checklistItemId ?? null, data.type ?? null,
        Object.hasOwn(data, "value") ? 1 : 0, data.value ?? null, data.unit ?? null,
        Object.hasOwn(data, "note") ? 1 : 0, data.note ?? null, timestamp, measurementId,
      ).run();
      return { status: 200, body: { measurement: { id: measurementId, ...data, updatedAt: timestamp } } };
    });
    return Response.json(result.body, { status: result.status });
  });

  app.post("/api/photos", async (context) => {
    const input = await readJson(context.req.raw, photoCreateMutationSchema);
    if (!input) return jsonError(400, "invalid_request");
    const user = context.get("authUser");
    if (!await ownsProperty(context.env.DB, input.data.propertyId, user.id)
      || !await verifyOptionalRoom(context.env.DB, input.data.roomId, input.data.propertyId, user.id)
      || (input.data.checklistItemId !== null && input.data.checklistItemId !== undefined
        && !await checklistBelongsToProperty(context.env.DB, input.data.checklistItemId, input.data.propertyId, user.id))) return jsonError(404, "not_found");
    const expectedR2Key = photoObjectKey(input.data.propertyId, input.data.id, input.data.mimeType);
    if (!expectedR2Key || input.data.r2Key !== expectedR2Key) return jsonError(400, "invalid_request");
    const result = await runMutation(context.env.DB, user.id, input.clientMutationId, async () => {
      const timestamp = now();
      await context.env.DB.prepare(
        `INSERT INTO photos
         (id, user_id, property_id, room_id, element_id, checklist_item_id, r2_key, mime_type, width, height, note, upload_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).bind(
        input.data.id, user.id, input.data.propertyId, input.data.roomId ?? null, input.data.elementId ?? null,
        input.data.checklistItemId ?? null, input.data.r2Key, input.data.mimeType, input.data.width ?? null,
        input.data.height ?? null, input.data.note ?? null, timestamp,
      ).run();
      return { status: 201, body: { photo: { ...input.data, uploadStatus: "pending", createdAt: timestamp } } };
    });
    return Response.json(result.body, { status: result.status });
  });

  app.put("/api/photos/:id/upload", async (context) => {
    const photoId = validPathId(context.req.param("id"));
    const uploadMutationId = clientMutationIdSchema.safeParse(context.req.header("x-client-mutation-id"));
    const mimeType = imageContentType(context.req.raw);
    if (!photoId || !uploadMutationId.success || !mimeType) return jsonError(400, "invalid_request");
    const user = context.get("authUser");
    const photo = await ownedPhoto(context.env.DB, photoId, user.id);
    if (!photo) return jsonError(404, "not_found");
    if (photo.mime_type !== mimeType) return jsonError(400, "invalid_request");
    const body = await boundedImageBody(context.req.raw);
    if (!body) return jsonError(413, "invalid_request");
    const result = await runMutation(context.env.DB, user.id, uploadMutationId.data, async () => {
      if (photo.upload_status !== "uploaded") {
        // R2 and D1 do not share a transaction. Rewriting this deterministic key is safe if D1 acknowledgement failed after R2 accepted it.
        await context.env.PHOTO_BUCKET.put(photo.r2_key, body, { httpMetadata: { contentType: mimeType } });
        await context.env.DB.prepare(
          "UPDATE photos SET upload_status = 'uploaded', uploaded_at = ? WHERE id = ? AND user_id = ?",
        ).bind(now(), photoId, user.id).run();
      }
      return { status: 200, body: { photoId, uploadStatus: "uploaded" } };
    });
    return Response.json(result.body, { status: result.status });
  });

  app.delete("/api/photos/:id", async (context) => {
    const photoId = validPathId(context.req.param("id"));
    const input = await readJson(context.req.raw, emptyMutationSchema);
    if (!photoId || !input) return jsonError(400, "invalid_request");
    const user = context.get("authUser");
    const photo = await ownedPhoto(context.env.DB, photoId, user.id);
    if (!photo) return jsonError(404, "not_found");
    const result = await runMutation(context.env.DB, user.id, input.clientMutationId, async () => {
      // Delete from R2 before metadata. If D1 is temporarily unavailable, retry safely deletes the same deterministic object again.
      await context.env.PHOTO_BUCKET.delete(photo.r2_key);
      await context.env.DB.prepare("DELETE FROM photos WHERE id = ? AND user_id = ?").bind(photoId, user.id).run();
      return { status: 200, body: { deletedId: photoId } };
    });
    return Response.json(result.body, { status: result.status });
  });

  app.notFound(() => jsonError(404, "not_found"));
  return app;
}

const app = createApp();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await app.fetch(request, env);
    const url = new URL(request.url);
    if (response.status === 404 && !url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    return response;
  },
};
