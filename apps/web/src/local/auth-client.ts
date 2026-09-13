import { credentialsSchema, type Credentials } from "@home-measure/domain";

export interface AccountUser {
  id: string;
  username: string;
  name: string | null;
}

export type AuthOutcome =
  | { ok: true; user: AccountUser }
  | { ok: false; reason: "invalid" | "taken" | "rejected" | "offline" };

/** Talks to this app's own account endpoints. The session lives in an HttpOnly cookie. */
export class AuthClient {
  public constructor(
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
    private readonly basePath = "/api",
  ) {}

  /** Returns the signed-in account, or null when the cookie is missing, expired or rejected. */
  public async currentUser(): Promise<AccountUser | null> {
    try {
      const response = await this.fetcher(`${this.basePath}/me`, { credentials: "include" });
      if (!response.ok) return null;
      const body = await response.json() as { user?: AccountUser };
      return body.user ?? null;
    } catch {
      return null;
    }
  }

  public register(credentials: Credentials): Promise<AuthOutcome> {
    return this.submit("/auth/register", credentials);
  }

  public signIn(credentials: Credentials): Promise<AuthOutcome> {
    return this.submit("/auth/login", credentials);
  }

  public async signOut(): Promise<void> {
    try {
      await this.fetcher(`${this.basePath}/auth/logout`, { method: "POST", credentials: "include" });
    } catch {
      // Signing out locally still matters when the network is gone; the cookie expires on its own.
    }
  }

  private async submit(path: string, credentials: Credentials): Promise<AuthOutcome> {
    const parsed = credentialsSchema.safeParse(credentials);
    if (!parsed.success) return { ok: false, reason: "invalid" };
    let response: Response;
    try {
      response = await this.fetcher(`${this.basePath}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
        credentials: "include",
      });
    } catch {
      return { ok: false, reason: "offline" };
    }
    if (response.status === 409) return { ok: false, reason: "taken" };
    if (response.status === 400) return { ok: false, reason: "invalid" };
    if (!response.ok) return { ok: false, reason: "rejected" };
    const body = await response.json() as { user: AccountUser };
    return { ok: true, user: body.user };
  }
}
