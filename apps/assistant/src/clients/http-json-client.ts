/** A call to another service failed. `kind` says how; `status` and `code` come from its response. */
export class DownstreamError extends Error {
  constructor(
    readonly service: string,
    readonly kind: 'unreachable' | 'timeout' | 'http',
    readonly status?: number,
    readonly code?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(
      kind === 'http'
        ? `${service} responded ${status}${code ? ` (${code})` : ''}`
        : `${service} ${kind}`,
    );
    this.name = 'DownstreamError';
  }
}

export interface HttpJsonClientOptions {
  /** Label used in errors and logs, e.g. "retrieval". */
  service: string;
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/**
 * Minimal JSON-over-HTTP client for calling our own services. Every call is bounded by a timeout so
 * a slow dependency cannot hold a user request open, and failures are normalised into
 * DownstreamError. The bearer token is only ever sent as a header, never put in a URL or message.
 */
export class HttpJsonClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpJsonClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async post<T>(
    path: string,
    token: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const { service, baseUrl, timeoutMs } = this.options;

    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Match on the name, not `instanceof`: the timeout error can come from another realm.
      const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError';
      throw new DownstreamError(service, timedOut ? 'timeout' : 'unreachable');
    }

    if (!response.ok) {
      const parsed = (await response.json().catch(() => ({}))) as { error?: { code?: unknown } };
      const code = typeof parsed.error?.code === 'string' ? parsed.error.code : undefined;
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new DownstreamError(
        service,
        'http',
        response.status,
        code,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }
    return (await response.json()) as T;
  }
}
