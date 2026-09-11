import { beforeAll, describe, expect, it } from "vitest";

import { createApp, type Env } from "./index";

interface StoredProperty {
  id: string;
  userId: string;
  name: string;
}

interface StoredPhoto {
  id: string;
  userId: string;
  propertyId: string;
  r2Key: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  uploadStatus: "pending" | "uploaded";
}

interface StoredMutation {
  status: number;
  body: string;
}

interface StoredUser {
  id: string;
  email: string;
  name: string | null;
  provider: "development" | "google";
  providerUserId: string;
}

interface StoredSession {
  id: string;
  userId: string;
  expiresAt: number;
}

interface StoredOAuthTransaction {
  stateHash: string;
  verifier: string;
  nonce: string;
  expiresAt: number;
  usedAt: number | null;
}

class FakeD1 {
  public readonly statements: Array<{ query: string; values: unknown[] }> = [];
  private readonly mutations = new Map<string, StoredMutation>();
  private readonly users: StoredUser[] = [];
  private readonly sessions: StoredSession[] = [];
  private readonly oauthTransactions = new Map<string, StoredOAuthTransaction>();

  public constructor(
    private readonly properties: StoredProperty[] = [],
    private readonly photos: StoredPhoto[] = [],
  ) {}

  prepare(query: string) {
    return {
      bind: (...values: unknown[]) => {
        this.statements.push({ query, values });
        return {
          first: async <T>(): Promise<T | null> => this.first<T>(query, values),
          all: async <T>(): Promise<{ results: T[] }> => ({ results: this.all<T>(query, values) }),
          run: async (): Promise<{ success: true }> => this.run(query, values),
        };
      },
    };
  }

  private first<T>(query: string, values: unknown[]): T | null {
    if (query.includes("FROM oauth_transactions")) {
      const stateHash = values[0];
      const transaction = typeof stateHash === "string" ? this.oauthTransactions.get(stateHash) : undefined;
      return transaction ? {
        state_hash: transaction.stateHash,
        pkce_verifier: transaction.verifier,
        nonce: transaction.nonce,
        expires_at: transaction.expiresAt,
        used_at: transaction.usedAt,
      } as T : null;
    }
    if (query.includes("FROM idempotent_mutations")) {
      const userId = values[0];
      const mutationId = values[1];
      const mutation = typeof userId === "string" && typeof mutationId === "string" ? this.mutations.get(`${userId}:${mutationId}`) : undefined;
      return mutation ? { response_status: mutation.status, response_json: mutation.body } as T : null;
    }
    if (query.includes("FROM sessions")) {
      const sessionId = values[0];
      const timestamp = values[1];
      const session = typeof sessionId === "string" && typeof timestamp === "number"
        ? this.sessions.find((candidate) => candidate.id === sessionId && candidate.expiresAt > timestamp)
        : undefined;
      const user = session ? this.users.find((candidate) => candidate.id === session.userId) : undefined;
      return user ? { id: user.id, email: user.email, name: user.name } as T : null;
    }
    if (query.includes("FROM users WHERE provider")) {
      const providerUserId = values[0];
      const user = typeof providerUserId === "string"
        ? this.users.find((candidate) => candidate.provider === "google" && candidate.providerUserId === providerUserId)
        : undefined;
      return user ? { id: user.id, email: user.email, name: user.name } as T : null;
    }
    if (query.includes("FROM photos")) {
      const photoId = values[0];
      const userId = values[1];
      const photo = this.photos.find((candidate) => candidate.id === photoId && candidate.userId === userId);
      return photo ? {
        id: photo.id,
        r2_key: photo.r2Key,
        mime_type: photo.mimeType,
        upload_status: photo.uploadStatus,
      } as T : null;
    }
    const propertyId = typeof values[0] === "string" ? values[0] : "";
    const userId = typeof values[1] === "string" ? values[1] : "";
    const property = this.properties.find((candidate) => candidate.id === propertyId && candidate.userId === userId);
    if (!property) return null;
    return {
      id: property.id,
      name: property.name,
      address: null,
      note: null,
      created_at: 1,
      updated_at: 1,
    } as T;
  }

  private all<T>(query: string, values: unknown[]): T[] {
    if (!query.includes("FROM properties")) return [];
    const userId = values[0];
    return this.properties.filter((property) => property.userId === userId).map((property) => ({
      id: property.id,
      name: property.name,
      address: null,
      note: null,
      created_at: 1,
      updated_at: 1,
    }) as T);
  }

  private run(query: string, values: unknown[]): { success: true; meta: { changes: number } } {
    if (query.includes("DELETE FROM oauth_transactions")) {
      const timestamp = values[0];
      if (typeof timestamp === "number") {
        for (const [key, transaction] of this.oauthTransactions) {
          if (transaction.expiresAt <= timestamp) this.oauthTransactions.delete(key);
        }
      }
    }
    if (query.includes("INSERT INTO oauth_transactions")) {
      const [stateHash, verifier, nonce, expiresAt] = values;
      if (typeof stateHash === "string" && typeof verifier === "string" && typeof nonce === "string" && typeof expiresAt === "number") {
        this.oauthTransactions.set(stateHash, { stateHash, verifier, nonce, expiresAt, usedAt: null });
      }
    }
    if (query.includes("UPDATE oauth_transactions SET used_at")) {
      const usedAt = values[0];
      const stateHash = values[1];
      const timestamp = values[2];
      const transaction = typeof stateHash === "string" ? this.oauthTransactions.get(stateHash) : undefined;
      if (transaction && transaction.usedAt === null && typeof usedAt === "number" && typeof timestamp === "number" && transaction.expiresAt > timestamp) {
        transaction.usedAt = usedAt;
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (query.includes("INSERT OR IGNORE INTO users")) {
      const [id, email, name, providerUserId] = values;
      if (typeof id === "string" && typeof email === "string" && (typeof name === "string" || name === null) && typeof providerUserId === "string"
        && !this.users.some((candidate) => candidate.id === id)) {
        this.users.push({ id, email, name, provider: "development", providerUserId });
      }
    }
    if (query.includes("INSERT INTO users") && query.includes("'google'")) {
      const [id, email, name, providerUserId] = values;
      if (typeof id === "string" && typeof email === "string" && (typeof name === "string" || name === null) && typeof providerUserId === "string") {
        const existing = this.users.find((candidate) => candidate.provider === "google" && candidate.providerUserId === providerUserId);
        if (existing) {
          existing.email = email;
          existing.name = name;
        } else {
          this.users.push({ id, email, name, provider: "google", providerUserId });
        }
      }
    }
    if (query.includes("INSERT INTO sessions")) {
      const [id, userId, expiresAt] = values;
      if (typeof id === "string" && typeof userId === "string" && typeof expiresAt === "number") this.sessions.push({ id, userId, expiresAt });
    }
    if (query.includes("DELETE FROM sessions")) {
      const sessionId = values[0];
      if (typeof sessionId === "string") {
        const index = this.sessions.findIndex((candidate) => candidate.id === sessionId);
        if (index >= 0) this.sessions.splice(index, 1);
      }
    }
    if (query.includes("INSERT INTO idempotent_mutations")) {
      const userId = values[0];
      const mutationId = values[1];
      const status = values[2];
      const body = values[3];
      if (typeof userId === "string" && typeof mutationId === "string" && typeof status === "number" && typeof body === "string") {
        this.mutations.set(`${userId}:${mutationId}`, { status, body });
      }
    }
    if (query.includes("UPDATE photos SET upload_status")) {
      const photoId = values[1];
      const userId = values[2];
      const photo = this.photos.find((candidate) => candidate.id === photoId && candidate.userId === userId);
      if (photo) photo.uploadStatus = "uploaded";
    }
    if (query.includes("DELETE FROM photos")) {
      const photoId = values[0];
      const userId = values[1];
      const index = this.photos.findIndex((candidate) => candidate.id === photoId && candidate.userId === userId);
      if (index >= 0) this.photos.splice(index, 1);
    }
    return { success: true, meta: { changes: 1 } };
  }

  public latestOAuthTransaction(): StoredOAuthTransaction | undefined {
    return [...this.oauthTransactions.values()].at(-1);
  }
}

class FakeR2 {
  public readonly puts: Array<{ key: string; body: ArrayBuffer | ReadableStream | string | null; options?: R2PutOptions }> = [];
  public readonly deletes: string[] = [];

  public async put(key: string, body: ArrayBuffer | ReadableStream | string | null, options?: R2PutOptions): Promise<R2Object> {
    if (options) this.puts.push({ key, body, options });
    else this.puts.push({ key, body });
    return { key, version: "test", size: body instanceof ArrayBuffer ? body.byteLength : 0, etag: "test", httpEtag: '"test"', uploaded: new Date(), checksums: {} } as R2Object;
  }

  public async delete(keys: string | string[]): Promise<void> {
    this.deletes.push(...(Array.isArray(keys) ? keys : [keys]));
  }
}

function bindings(db: FakeD1, overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    DB: db as unknown as D1Database,
    PHOTO_BUCKET: new FakeR2() as unknown as R2Bucket,
    ...overrides,
  };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://example.test${path}`, init);
}

describe("Worker API authentication and validation", () => {
  it("keeps health public while rejecting unauthenticated domain requests", async () => {
    const app = createApp();
    const db = new FakeD1();

    expect((await app.fetch(request("/api/health"), bindings(db))).status).toBe(200);
    expect((await app.fetch(request("/api/properties"), bindings(db))).status).toBe(401);
  });

  it("does not activate development auth outside the explicit development environment", async () => {
    const app = createApp();
    const response = await app.fetch(request("/api/properties"), bindings(new FakeD1(), {
      ENVIRONMENT: "production",
      DEV_AUTH_USER_ID: "user_0001",
      DEV_AUTH_EMAIL: "developer@example.test",
    }));

    expect(response.status).toBe(401);
  });

  it("fails closed when a user attempts to read another user's property", async () => {
    const app = createApp();
    const db = new FakeD1([{ id: "property_001", userId: "other_001", name: "Other home" }]);
    const response = await app.fetch(request("/api/properties/property_001"), bindings(db, {
      ENVIRONMENT: "development",
      DEV_AUTH_USER_ID: "user_0001",
      DEV_AUTH_EMAIL: "developer@example.test",
    }));

    expect(response.status).toBe(404);
  });

  it("validates mutation envelopes before database writes", async () => {
    const app = createApp();
    const db = new FakeD1();
    const response = await app.fetch(request("/api/properties", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientMutationId: "mutation_001",
        data: { id: "bad", name: "Apartment" },
      }),
    }), bindings(db, {
      ENVIRONMENT: "development",
      DEV_AUTH_USER_ID: "user_0001",
      DEV_AUTH_EMAIL: "developer@example.test",
    }));

    expect(response.status).toBe(400);
    expect(db.statements.some((statement) => statement.query.includes("INSERT INTO properties"))).toBe(false);
  });
});

describe("Worker photo binary upload", () => {
  const owner = { ENVIRONMENT: "development", DEV_AUTH_USER_ID: "user_0001", DEV_AUTH_EMAIL: "developer@example.test" } as const;
  const ownerProperty: StoredProperty = { id: "property_001", userId: "user_0001", name: "Owner home" };
  const ownerPhoto = (): StoredPhoto => ({
    id: "photo_00001",
    userId: "user_0001",
    propertyId: ownerProperty.id,
    r2Key: "photos/property_001/photo_00001.jpg",
    mimeType: "image/jpeg",
    uploadStatus: "pending",
  });

  function uploadRequest(photoId = "photo_00001", init: RequestInit = {}): Request {
    return request(`/api/photos/${photoId}/upload`, {
      method: "PUT",
      headers: {
        "content-type": "image/jpeg",
        "x-client-mutation-id": "upload_00001",
        ...init.headers,
      },
      body: new Uint8Array([1, 2, 3]),
      ...init,
    });
  }

  it("rejects another user's photo before an R2 write", async () => {
    const bucket = new FakeR2();
    const response = await createApp().fetch(uploadRequest(), bindings(new FakeD1([ownerProperty], [{ ...ownerPhoto(), userId: "other_001" }]), { ...owner, PHOTO_BUCKET: bucket as unknown as R2Bucket }));

    expect(response.status).toBe(404);
    expect(bucket.puts).toHaveLength(0);
  });

  it("validates image MIME and conservative declared payload size", async () => {
    const app = createApp();
    const db = new FakeD1([ownerProperty], [ownerPhoto()]);
    const invalidMime = await app.fetch(uploadRequest("photo_00001", { headers: { "content-type": "image/gif", "x-client-mutation-id": "upload_00001" } }), bindings(db, owner));
    expect(invalidMime.status).toBe(400);

    const oversized = await app.fetch(uploadRequest("photo_00001", { headers: { "content-type": "image/jpeg", "content-length": String(12 * 1024 * 1024 + 1), "x-client-mutation-id": "upload_00002" } }), bindings(db, owner));
    expect(oversized.status).toBe(413);
  });

  it("writes a matching owned image once and returns the saved result for the same retry ID", async () => {
    const bucket = new FakeR2();
    const app = createApp();
    const db = new FakeD1([ownerProperty], [ownerPhoto()]);
    const env = bindings(db, { ...owner, PHOTO_BUCKET: bucket as unknown as R2Bucket });

    const first = await app.fetch(uploadRequest(), env);
    const retry = await app.fetch(uploadRequest(), env);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ photoId: "photo_00001", uploadStatus: "uploaded" });
    expect(retry.status).toBe(200);
    expect(bucket.puts).toHaveLength(1);
    expect(bucket.puts[0]?.key).toBe("photos/property_001/photo_00001.jpg");
    const metadata = bucket.puts[0]?.options?.httpMetadata;
    const contentType = metadata instanceof Headers ? metadata.get("content-type") : metadata?.contentType;
    expect(contentType).toBe("image/jpeg");
  });
});

function base64UrlJson(value: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function textArrayBuffer(value: string): ArrayBuffer {
  const source = new TextEncoder().encode(value);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy.buffer;
}

async function signedGoogleToken(privateKey: CryptoKey, claims: Record<string, unknown>, kid = "google-test-key"): Promise<string> {
  const header = base64UrlJson({ alg: "RS256", kid, typ: "JWT" });
  const payload = base64UrlJson(claims);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, textArrayBuffer(`${header}.${payload}`));
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return `${header}.${payload}.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
}

describe("Google OAuth callback and session boundary", () => {
  let privateKey: CryptoKey;
  let publicJwk: JsonWebKey;

  beforeAll(async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    privateKey = keyPair.privateKey;
    publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  });

  function oauthEnv(db: FakeD1): Env {
    return bindings(db, {
      ENVIRONMENT: "production",
      GOOGLE_CLIENT_ID: "google-client-id.apps.exampleusercontent.com",
      GOOGLE_CLIENT_SECRET: "google-client-secret-for-tests",
      OAUTH_REDIRECT_URI: "https://example.test/api/auth/google/callback",
    });
  }

  async function start(app: ReturnType<typeof createApp>, env: Env): Promise<{ state: string; nonce: string; response: Response }> {
    const response = await app.fetch(request("/api/auth/google"), env);
    const location = response.headers.get("location");
    expect(response.status).toBe(302);
    expect(location).not.toBeNull();
    const authorizationUrl = new URL(location!);
    const state = authorizationUrl.searchParams.get("state");
    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return { state: state!, nonce: "", response };
  }

  it("uses PKCE and a D1 transaction, verifies a signed ID token, issues a secure cookie, and invalidates it on logout", async () => {
    const db = new FakeD1();
    let token = "";
    const app = createApp({
      fetch: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://oauth2.googleapis.com/token") return Response.json({ id_token: token });
        if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [{ ...publicJwk, kid: "google-test-key", use: "sig", alg: "RS256" }] });
        return new Response(null, { status: 404 });
      },
    });
    const env = oauthEnv(db);
    const authorization = await start(app, env);
    const transaction = db.latestOAuthTransaction();
    expect(transaction).toBeDefined();
    expect(authorization.response.headers.get("location")).not.toContain(transaction!.verifier);
    token = await signedGoogleToken(privateKey, {
      iss: "https://accounts.google.com",
      aud: env.GOOGLE_CLIENT_ID,
      sub: "google-subject-123",
      email: "owner@example.test",
      email_verified: true,
      nonce: transaction!.nonce,
      iat: Math.floor(Date.now() / 1_000) - 10,
      exp: Math.floor(Date.now() / 1_000) + 600,
      name: "Home Owner",
    });

    const callback = await app.fetch(request(`/api/auth/google/callback?code=authorization-code&state=${authorization.state}`), env);
    const setCookie = callback.headers.get("set-cookie");
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("https://example.test/");
    expect(setCookie).toMatch(/^home_measure_session=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/);

    expect((await app.fetch(request(`/api/auth/google/callback?code=authorization-code&state=${authorization.state}`), env)).status).toBe(400);

    const cookie = setCookie!.split(";", 1)[0]!;
    expect((await app.fetch(request("/api/me", { headers: { cookie } }), env)).status).toBe(200);
    const logout = await app.fetch(request("/api/auth/logout", { method: "POST", headers: { cookie } }), env);
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toBe("home_measure_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
    expect((await app.fetch(request("/api/me", { headers: { cookie } }), env)).status).toBe(401);
  });

  it("rejects mismatched or expired OAuth state before exchanging a code", async () => {
    const db = new FakeD1();
    let fetchCalls = 0;
    const app = createApp({ fetch: async () => { fetchCalls += 1; return new Response(null, { status: 500 }); } });
    const env = oauthEnv(db);
    await start(app, env);

    const response = await app.fetch(request(`/api/auth/google/callback?code=authorization-code&state=${"a".repeat(43)}`), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "oauth_failed" });
    expect(fetchCalls).toBe(0);

    const validState = await start(app, env);
    const transaction = db.latestOAuthTransaction();
    transaction!.expiresAt = 0;
    expect((await app.fetch(request(`/api/auth/google/callback?code=authorization-code&state=${validState.state}`), env)).status).toBe(400);
    expect(fetchCalls).toBe(0);
  });

  it("fails closed only on OAuth endpoints when OAuth runtime configuration is absent", async () => {
    const app = createApp();
    const env = bindings(new FakeD1());
    expect((await app.fetch(request("/api/auth/google"), env)).status).toBe(503);
    expect((await app.fetch(request("/api/properties"), env)).status).toBe(401);
  });

  it("rejects ID tokens with invalid claims or signatures", async () => {
    const db = new FakeD1();
    let token = "";
    const app = createApp({
      fetch: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://oauth2.googleapis.com/token") return Response.json({ id_token: token });
        return Response.json({ keys: [{ ...publicJwk, kid: "google-test-key", use: "sig", alg: "RS256" }] });
      },
    });
    const env = oauthEnv(db);
    const invalidIssuer = await start(app, env);
    const firstTransaction = db.latestOAuthTransaction()!;
    token = await signedGoogleToken(privateKey, {
      iss: "https://attacker.example.test",
      aud: env.GOOGLE_CLIENT_ID,
      sub: "google-subject-123",
      email: "owner@example.test",
      email_verified: true,
      nonce: firstTransaction.nonce,
      iat: Math.floor(Date.now() / 1_000) - 10,
      exp: Math.floor(Date.now() / 1_000) + 600,
    });
    expect((await app.fetch(request(`/api/auth/google/callback?code=code-one&state=${invalidIssuer.state}`), env)).status).toBe(400);

    const invalidSignature = await start(app, env);
    const secondTransaction = db.latestOAuthTransaction()!;
    const otherPair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    token = await signedGoogleToken(otherPair.privateKey, {
      iss: "https://accounts.google.com",
      aud: env.GOOGLE_CLIENT_ID,
      sub: "google-subject-123",
      email: "owner@example.test",
      email_verified: true,
      nonce: secondTransaction.nonce,
      iat: Math.floor(Date.now() / 1_000) - 10,
      exp: Math.floor(Date.now() / 1_000) + 600,
    });
    expect((await app.fetch(request(`/api/auth/google/callback?code=code-two&state=${invalidSignature.state}`), env)).status).toBe(400);
  });
});
