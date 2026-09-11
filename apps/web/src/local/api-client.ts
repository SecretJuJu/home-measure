import type { QueuedOperation } from "./entities";

export interface ApiClient {
  send(operation: QueuedOperation): Promise<void>;
}

export class ApiRequestError extends Error {
  public constructor(
    public readonly status: number,
    message = `API request failed with status ${status}`,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** Browser API client. Tests and non-browser callers can inject the ApiClient interface. */
export class HttpApiClient implements ApiClient {
  public constructor(
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
    private readonly basePath = "/api",
  ) {}

  public async send(operation: QueuedOperation): Promise<void> {
    const response = await this.fetcher(`${this.basePath}${operation.path}`, {
      method: operation.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(operation.body),
      credentials: "include",
    });
    if (!response.ok) throw new ApiRequestError(response.status);
  }
}
