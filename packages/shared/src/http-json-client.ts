import { parseSse, type SseMessage } from './sse';

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

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * Minimal JSON-over-HTTP client for calling our own services. Every call is bounded by a timeout
 * so a slow dependency cannot hold a request open, and failures are normalised into
 * DownstreamError. The bearer token is only ever sent as a header, never put in a URL or message.
 */
export class HttpJsonClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpJsonClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get<T>(path: string, token: string, headers?: Record<string, string>): Promise<T> {
    return this.request<T>('GET', path, token, undefined, headers);
  }

  post<T>(
    path: string,
    token: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    return this.request<T>('POST', path, token, body, headers);
  }

  put<T>(path: string, token: string, body: unknown, headers?: Record<string, string>): Promise<T> {
    return this.request<T>('PUT', path, token, body, headers);
  }

  delete<T>(path: string, token: string, headers?: Record<string, string>): Promise<T> {
    return this.request<T>('DELETE', path, token, undefined, headers);
  }

  async request<T>(
    method: HttpMethod,
    path: string,
    token: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const { baseUrl, timeoutMs } = this.options;

    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...headers,
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw this.transportError(error);
    }

    if (!response.ok) throw await this.httpError(response);
    return (await response.json()) as T;
  }

  /**
   * A POST whose answer arrives as server-sent events. The timeout bounds waiting for the response
   * to begin, and then each silence between events, not the whole answer, so a long answer is not
   * cut for being long. An error status before the first event is a DownstreamError exactly as for
   * `post`. Abort `signal` to hang up: the connection closes and the server stops generating.
   */
  async *postEventStream(
    path: string,
    token: string,
    body: unknown,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ): AsyncGenerator<SseMessage, void, void> {
    const { service, baseUrl, timeoutMs } = this.options;
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timedOut = false;
    let idle: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    };

    arm();
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${baseUrl.replace(/\/+$/, '')}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${token}`,
            ...headers,
          },
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch (error) {
        throw timedOut ? new DownstreamError(service, 'timeout') : this.transportError(error);
      }
      if (!response.ok) throw await this.httpError(response);
      if (!response.body) throw new DownstreamError(service, 'unreachable');

      try {
        for await (const message of parseSse(response.body)) {
          arm();
          yield message;
        }
      } catch (error) {
        if (signal?.aborted) return; // the caller hung up: not a failure
        throw timedOut ? new DownstreamError(service, 'timeout') : this.transportError(error);
      }
    } finally {
      clearTimeout(idle);
      controller.abort();
    }
  }

  private transportError(error: unknown): DownstreamError {
    // Match on the name, not `instanceof`: the timeout error can come from another realm.
    const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError';
    return new DownstreamError(this.options.service, timedOut ? 'timeout' : 'unreachable');
  }

  private async httpError(response: Response): Promise<DownstreamError> {
    const parsed = (await response.json().catch(() => ({}))) as { error?: { code?: unknown } };
    const code = typeof parsed.error?.code === 'string' ? parsed.error.code : undefined;
    const retryAfter = Number(response.headers.get('retry-after'));
    return new DownstreamError(
      this.options.service,
      'http',
      response.status,
      code,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
}
