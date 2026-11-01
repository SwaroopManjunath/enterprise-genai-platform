import http from 'node:http';
import https from 'node:https';
import { EgressBlockedError, UpstreamError } from '../domain/errors';
import type { HostPolicy } from './host-policy';

export interface TransportResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface PostOptions {
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  maxBytes: number;
}

/** The one door out. Everything the gateway sends to an MCP server goes through here. */
export interface Transport {
  post(url: string, options: PostOptions): Promise<TransportResponse>;
}

export const TRANSPORT = Symbol('TRANSPORT');

/**
 * POSTs through the host policy, with a hard time limit and a hard cap on the response size
 * (a server cannot make the gateway buffer gigabytes). Redirects are never followed: a redirect
 * is how an allowed host would bounce the request somewhere the policy would refuse.
 */
export class GuardedTransport implements Transport {
  constructor(private readonly policy: HostPolicy) {}

  post(rawUrl: string, options: PostOptions): Promise<TransportResponse> {
    const url = this.policy.check(rawUrl);
    const client = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        action();
      };

      const request = client.request(
        url,
        {
          method: 'POST',
          lookup: this.policy.lookup as never,
          headers: { ...options.headers, 'content-length': Buffer.byteLength(options.body) },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > options.maxBytes) {
              request.destroy();
              finish(() =>
                reject(new UpstreamError('too_large', `over ${options.maxBytes} bytes`)),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () =>
            finish(() =>
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            ),
          );
          response.on('error', (error) =>
            finish(() => reject(new UpstreamError('unreachable', error.message))),
          );
        },
      );

      const deadline = setTimeout(() => {
        request.destroy();
        finish(() =>
          reject(new UpstreamError('timeout', `no response within ${options.timeoutMs}ms`)),
        );
      }, options.timeoutMs);

      request.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'EGRESS_BLOCKED') {
          return finish(() =>
            reject(new EgressBlockedError('resolves to a private or reserved address')),
          );
        }
        finish(() => reject(new UpstreamError('unreachable', error.message)));
      });
      request.end(options.body);
    });
  }
}
