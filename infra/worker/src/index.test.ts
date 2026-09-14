import { describe, expect, it } from "vitest";

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
  username: string;
  name: string | null;
  passwordHash: string;
}

interface StoredSession {
  id: string;
  userId: string;
  expiresAt: number;
}

class FakeD1 {
  public readonly statements: Array<{ query: string; values: unknown[] }> = [];
  private readonly mutations = new Map<string, StoredMutation>();
  private readonly users: StoredUser[] = [];
  private readonly sessions: StoredSession[] = [];

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
      return user ? { id: user.id, username: user.username, name: user.name } as T : null;
    }
    if (query.includes("FROM users WHERE username")) {
      const username = values[0];
      const user = typeof username === "string" ? this.findUser(username) : undefined;
      return user ? { id: user.id, username: user.username, name: user.name, password_hash: user.passwordHash } as T : null;
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
    if (query.includes("INSERT OR IGNORE INTO users")) {
      // Mirrors the unique index on username: a taken name reports zero changes instead of throwing.
      const [id, username, passwordHash, name] = query.includes("password_hash, name")
        ? [values[0], values[1], values[2], values[3]]
        : [values[0], values[1], "", values[2]];
      if (typeof id !== "string" || typeof username !== "string") return { success: true, meta: { changes: 0 } };
      if (this.findUser(username) || this.users.some((candidate) => candidate.id === id)) return { success: true, meta: { changes: 0 } };
      this.users.push({
        id,
        username,
        name: typeof name === "string" ? name : null,
        passwordHash: typeof passwordHash === "string" ? passwordHash : "",
      });
      return { success: true, meta: { changes: 1 } };
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

  private findUser(username: string): StoredUser | undefined {
    return this.users.find((candidate) => candidate.username.toLowerCase() === username.toLowerCase());
  }

  public storedPasswordHash(username: string): string | undefined {
    return this.findUser(username)?.passwordHash;
  }

  public userCount(): number {
    return this.users.length;
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
      DEV_AUTH_USERNAME: "developer",
    }));

    expect(response.status).toBe(401);
  });

  it("fails closed when a user attempts to read another user's property", async () => {
    const app = createApp();
    const db = new FakeD1([{ id: "property_001", userId: "other_001", name: "Other home" }]);
    const response = await app.fetch(request("/api/properties/property_001"), bindings(db, {
      ENVIRONMENT: "development",
      DEV_AUTH_USER_ID: "user_0001",
      DEV_AUTH_USERNAME: "developer",
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
      DEV_AUTH_USERNAME: "developer",
    }));

    expect(response.status).toBe(400);
    expect(db.statements.some((statement) => statement.query.includes("INSERT INTO properties"))).toBe(false);
  });
});

describe("Worker photo binary upload", () => {
  const owner = { ENVIRONMENT: "development", DEV_AUTH_USER_ID: "user_0001", DEV_AUTH_USERNAME: "developer" } as const;
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

describe("photo annotations", () => {
  const owner = { ENVIRONMENT: "development", DEV_AUTH_USER_ID: "user_0001", DEV_AUTH_USERNAME: "developer" } as const;
  const property: StoredProperty = { id: "property_0001", userId: "user_0001", name: "Owner home" };
  const photo: StoredPhoto = { id: "photo_00001", userId: "user_0001", propertyId: property.id, r2Key: "photos/a.webp", mimeType: "image/webp", uploadStatus: "uploaded" };

  it("stores a sketch against a photo the account owns and refuses one it does not", async () => {
    // #given
    const db = new FakeD1([property], [photo]);
    const app = createApp();
    const env = bindings(db, owner);
    const annotation = {
      version: 1,
      marks: [{ id: "mark_0001", kind: "measure", start: { x: 0.1, y: 0.2 }, end: { x: 0.8, y: 0.2 }, text: "2,340 mm" }],
    };

    // #when
    const saved = await app.fetch(request("/api/photos/photo_00001/annotation", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientMutationId: "mutation_note0001", data: annotation }),
    }), env);
    const foreign = await app.fetch(request("/api/photos/photo_99999/annotation", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientMutationId: "mutation_note0002", data: annotation }),
    }), env);

    // #then
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ photo: { id: "photo_00001", annotation } });
    expect(foreign.status).toBe(404);
    expect(db.statements.some((statement) => statement.query.includes("UPDATE photos SET annotation_json"))).toBe(true);
  });

  it("rejects a sketch whose coordinates are not on the photo", async () => {
    // #given
    const db = new FakeD1([property], [photo]);
    const app = createApp();
    const env = bindings(db, owner);

    // #when
    const response = await app.fetch(request("/api/photos/photo_00001/annotation", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientMutationId: "mutation_note0003",
        data: { version: 1, marks: [{ id: "mark_0001", kind: "note", position: { x: 40, y: 0.2 }, text: "밖" }] },
      }),
    }), env);

    // #then
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });
});

describe("username and password accounts", () => {
  const credentials = { username: "field.owner", password: "measure-tape-2026" };

  function post(path: string, body: unknown, cookie?: string): Request {
    return request(path, {
      method: "POST",
      headers: cookie ? { "content-type": "application/json", cookie } : { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("registers an account, issues a secure session cookie, and invalidates it on logout", async () => {
    // #given
    const db = new FakeD1();
    const app = createApp();
    const env = bindings(db, { ENVIRONMENT: "production" });

    // #when
    const registered = await app.fetch(post("/api/auth/register", credentials), env);

    // #then
    const setCookie = registered.headers.get("set-cookie");
    expect(registered.status).toBe(200);
    expect(await registered.json()).toEqual({ user: { id: expect.any(String), username: "field.owner", name: null } });
    expect(setCookie).toMatch(/^home_measure_session=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/);
    expect(db.storedPasswordHash("field.owner")).toMatch(/^pbkdf2-sha256\$100000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]{43}$/);
    expect(db.storedPasswordHash("field.owner")).not.toContain(credentials.password);

    const cookie = setCookie!.split(";", 1)[0]!;
    expect((await app.fetch(request("/api/me", { headers: { cookie } }), env)).status).toBe(200);
    const logout = await app.fetch(request("/api/auth/logout", { method: "POST", headers: { cookie } }), env);
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toBe("home_measure_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
    expect((await app.fetch(request("/api/me", { headers: { cookie } }), env)).status).toBe(401);
  });

  it("signs an existing account back in and refuses a wrong password or an unknown name alike", async () => {
    // #given
    const db = new FakeD1();
    const app = createApp();
    const env = bindings(db, { ENVIRONMENT: "production" });
    await app.fetch(post("/api/auth/register", credentials), env);

    // #when
    const signedIn = await app.fetch(post("/api/auth/login", credentials), env);
    const wrongPassword = await app.fetch(post("/api/auth/login", { ...credentials, password: "measure-tape-2027" }), env);
    const unknownUser = await app.fetch(post("/api/auth/login", { ...credentials, username: "nobody.here" }), env);

    // #then
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("set-cookie")).toMatch(/^home_measure_session=[A-Za-z0-9_-]{43};/);
    expect([wrongPassword.status, unknownUser.status]).toEqual([401, 401]);
    expect(await wrongPassword.json()).toEqual({ error: "unauthorized" });
    expect(await unknownUser.json()).toEqual({ error: "unauthorized" });
  });

  it("keeps a username unique and rejects credentials that are too weak to accept", async () => {
    // #given
    const db = new FakeD1();
    const app = createApp();
    const env = bindings(db, { ENVIRONMENT: "production" });
    await app.fetch(post("/api/auth/register", credentials), env);

    // #when
    const taken = await app.fetch(post("/api/auth/register", { ...credentials, password: "another-password" }), env);
    const shortPassword = await app.fetch(post("/api/auth/register", { username: "someone.new", password: "short" }), env);
    const badUsername = await app.fetch(post("/api/auth/register", { username: "no spaces", password: "measure-tape-2026" }), env);

    // #then
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "conflict" });
    expect([shortPassword.status, badUsername.status]).toEqual([400, 400]);
    expect(db.userCount()).toBe(1);
  });

  it("treats the username as case-insensitive so one account cannot be registered twice", async () => {
    // #given
    const db = new FakeD1();
    const app = createApp();
    const env = bindings(db, { ENVIRONMENT: "production" });
    await app.fetch(post("/api/auth/register", credentials), env);

    // #when
    const upperCase = await app.fetch(post("/api/auth/register", { ...credentials, username: "Field.Owner" }), env);
    const signedIn = await app.fetch(post("/api/auth/login", { ...credentials, username: "FIELD.OWNER" }), env);

    // #then
    expect(upperCase.status).toBe(409);
    expect(signedIn.status).toBe(200);
  });

  it("refuses every data endpoint without a session", async () => {
    const app = createApp();
    const env = bindings(new FakeD1(), { ENVIRONMENT: "production" });
    expect((await app.fetch(request("/api/properties"), env)).status).toBe(401);
    expect((await app.fetch(request("/api/me"), env)).status).toBe(401);
  });
});
