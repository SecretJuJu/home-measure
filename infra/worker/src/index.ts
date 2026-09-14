import {
  checklistCreateMutationSchema,
  checklistUpdateMutationSchema,
  clientIdSchema,
  clientMutationIdSchema,
  credentialsSchema,
  emptyMutationSchema,
  measurementCreateMutationSchema,
  measurementUpdateMutationSchema,
  photoCreateMutationSchema,
  propertyCreateMutationSchema,
  propertyUpdateMutationSchema,
  roomCreateMutationSchema,
  roomLayoutMutationSchema,
  roomUpdateMutationSchema,
  usernameSchema,
} from "@home-measure/domain";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { z } from "zod";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  PHOTO_BUCKET: R2Bucket;
  /** Must be exactly `development` before the development identity is considered. */
  ENVIRONMENT?: string;
  /** Development-only identity. It is ignored outside ENVIRONMENT=development. */
  DEV_AUTH_USER_ID?: string;
  DEV_AUTH_USERNAME?: string;
  DEV_AUTH_NAME?: string;
}

interface AuthUser {
  id: string;
  username: string;
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

const sessionCookieName = "home_measure_session";
const sessionTokenBytes = 32;
/**
 * The Workers runtime refuses PBKDF2 above 100,000 iterations, so that ceiling is the cost we can
 * charge per sign-in. The count is stored with each hash, so raising it stays possible later.
 */
const passwordHashIterations = 100_000;
const sessionLifetimeSeconds = 30 * 24 * 60 * 60;
const maxPhotoUploadBytes = 12 * 1024 * 1024;
const allowedPhotoMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Raised when a create targets an ID that belongs to a different account. */
class OwnedByAnotherAccount extends Error {}

function jsonError(status: number, code: "invalid_request" | "unauthorized" | "not_found" | "conflict" | "internal_error" ): Response {
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

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function sessionCookie(sessionId: string, maxAge: number): string {
  return `${sessionCookieName}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function developmentUser(env: Env): AuthUser | null {
  if (env.ENVIRONMENT !== "development") return null;
  const userId = clientIdSchema.safeParse(env.DEV_AUTH_USER_ID);
  const username = usernameSchema.safeParse(env.DEV_AUTH_USERNAME);
  if (!userId.success || !username.success) return null;
  return { id: userId.data, username: username.data, name: env.DEV_AUTH_NAME?.trim() || null };
}

/**
 * PBKDF2-HMAC-SHA256 through WebCrypto, which the Workers runtime provides natively, so signing in
 * needs nothing outside this app. The iteration count travels with the hash: raising it later keeps
 * older records verifiable.
 */
async function derivePasswordHash(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: arrayBufferCopy(salt), iterations },
    key,
    256,
  );
  return base64UrlEncode(new Uint8Array(bits));
}

async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const digest = await derivePasswordHash(password, salt, passwordHashIterations);
  return `pbkdf2-sha256$${passwordHashIterations}$${base64UrlEncode(salt)}$${digest}`;
}

async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, digest] = stored.split("$");
  if (scheme !== "pbkdf2-sha256" || !iterations || !salt || !digest) return false;
  const rounds = Number(iterations);
  const saltBytes = base64UrlDecode(salt);
  if (!Number.isSafeInteger(rounds) || rounds < 1_000 || rounds > 1_000_000 || !saltBytes) return false;
  return constantTimeEqual(await derivePasswordHash(password, saltBytes, rounds), digest);
}

async function createPasswordUser(db: D1Database, username: string, password: string): Promise<AuthUser | null> {
  const id = randomToken(sessionTokenBytes);
  const passwordHash = await hashPassword(password);
  try {
    const result = await db.prepare(
      "INSERT OR IGNORE INTO users (id, username, password_hash, name, created_at) VALUES (?, ?, ?, NULL, ?)",
    ).bind(id, username, passwordHash, now()).run();
    // The unique index turns a taken username into zero changes rather than an exception.
    if (result.meta.changes !== 1) return null;
  } catch {
    return null;
  }
  return { id, username, name: null };
}

async function verifyPassword(db: D1Database, username: string, password: string): Promise<AuthUser | null> {
  const row = await db.prepare(
    "SELECT id, username, name, password_hash FROM users WHERE username = ?",
  ).bind(username).first<AuthUser & { password_hash: string }>();
  // Hash even when the name is unknown, so a missing account and a wrong password cost the same.
  const stored = row?.password_hash ?? `pbkdf2-sha256$${passwordHashIterations}$${base64UrlEncode(new Uint8Array(16))}$${"-".repeat(43)}`;
  const matched = await passwordMatches(password, stored);
  return row && matched ? { id: row.id, username: row.username, name: row.name } : null;
}

function signedInResponse(user: AuthUser, sessionId: string): Response {
  return Response.json({ user }, {
    status: 200,
    headers: { "Set-Cookie": sessionCookie(sessionId, sessionLifetimeSeconds), "Cache-Control": "no-store" },
  });
}

async function createSession(db: D1Database, userId: string): Promise<string | null> {
  const sessionId = randomToken(sessionTokenBytes);
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
      // A development identity never signs in, so it stores a hash nothing can match.
      "INSERT OR IGNORE INTO users (id, username, password_hash, name, created_at) VALUES (?, ?, '', ?, ?)",
    ).bind(devUser.id, devUser.username, devUser.name, now()).run();
    context.set("authUser", devUser);
    await next();
    return;
  }
  const sessionId = getSessionId(context.req.raw);
  if (!sessionId) return jsonError(401, "unauthorized");
  const user = await context.env.DB.prepare(
    `SELECT users.id, users.username, users.name
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

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError((error) => {
    if (error instanceof OwnedByAnotherAccount) return jsonError(409, "conflict");
    // Clients still learn nothing, but the message reaches `wrangler tail` instead of vanishing.
    console.error("unhandled request error:", error instanceof Error ? error.message : String(error));
    return jsonError(500, "internal_error");
  });
  app.get("/api/health", (context) => context.json({ status: "ok" }));

  app.post("/api/auth/register", async (context) => {
    const input = await readJson(context.req.raw, credentialsSchema);
    if (!input) return jsonError(400, "invalid_request");
    const user = await createPasswordUser(context.env.DB, input.username, input.password);
    if (!user) return jsonError(409, "conflict");
    const sessionId = await createSession(context.env.DB, user.id);
    if (!sessionId) return jsonError(500, "internal_error");
    return signedInResponse(user, sessionId);
  });

  app.post("/api/auth/login", async (context) => {
    const input = await readJson(context.req.raw, credentialsSchema);
    if (!input) return jsonError(400, "invalid_request");
    const user = await verifyPassword(context.env.DB, input.username, input.password);
    if (!user) return jsonError(401, "unauthorized");
    const sessionId = await createSession(context.env.DB, user.id);
    if (!sessionId) return jsonError(500, "internal_error");
    return signedInResponse(user, sessionId);
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
      // A device may upload a record it already synced, so re-creating your own row refreshes it.
      // The owner check in the conflict clause keeps someone else's ID from being taken over.
      const written = await context.env.DB.prepare(
        `INSERT INTO properties (id, user_id, name, address, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, address = excluded.address,
           note = excluded.note, updated_at = excluded.updated_at
         WHERE properties.user_id = ?`,
      ).bind(input.data.id, user.id, input.data.name, input.data.address ?? null, input.data.note ?? null, timestamp, timestamp, user.id).run();
      if (written.meta.changes !== 1) throw new OwnedByAnotherAccount();
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
      const written = await context.env.DB.prepare(
        `INSERT INTO rooms (id, property_id, name, type, layout_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type,
           layout_json = excluded.layout_json, updated_at = excluded.updated_at
         WHERE rooms.property_id = ?`,
      ).bind(input.data.id, propertyId, input.data.name, input.data.type, JSON.stringify(input.data.layout), timestamp, timestamp, propertyId).run();
      if (written.meta.changes !== 1) throw new OwnedByAnotherAccount();
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
