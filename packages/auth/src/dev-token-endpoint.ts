import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestIssuer } from './test-issuer';

export interface DevClient {
  secret: string;
  /** The audience this client's own API tokens carry: what an incoming assertion must be for. */
  audience: string;
  /**
   * App roles granted to this client's own (app-only) tokens, for the client-credentials grant:
   * the identity of a service acting as itself, such as `indexer` for the ingestion pipeline.
   */
  roles?: string[];
}

/**
 * Tenant claim on app-only tokens. A service identity belongs to the platform, not to a customer;
 * APIs that let a service act for a tenant take that tenant explicitly (and check the service's
 * role) instead of reading it from the token.
 */
export const SERVICE_TENANT = 'platform-services';

export interface DevTokenEndpointOptions {
  issuer: TestIssuer;
  /** Services allowed to obtain tokens, keyed by client id. */
  clients: Record<string, DevClient>;
}

export interface RunningDevTokenEndpoint {
  /** Full token URL, to use as the OBO client's token endpoint. */
  url: string;
  close(): Promise<void>;
}

const SCOPE_PATTERN = /^(api:\/\/[A-Za-z0-9._-]+)\/\.default$/;

const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Local stand-in for Entra ID's on-behalf-of token endpoint (development and tests only).
 *
 * It follows the same contract the real endpoint does: authenticate the calling service (client id
 * and secret), validate the user's token (the "assertion"), and issue a token for the **requested
 * downstream API** that still names the same user, tenant and roles. The new token's audience is
 * the downstream API, so it is rejected by every other service: tokens are not interchangeable.
 */
export async function startDevTokenEndpoint(
  options: DevTokenEndpointOptions,
  port = 0,
  /** Loopback unless asked: inside a container network the stand-in must listen on all addresses. */
  host = '127.0.0.1',
): Promise<RunningDevTokenEndpoint> {
  const server: Server = createServer((req, res) => {
    void handle(req, res, options).catch(() => send(res, 400, { error: 'invalid_request' }));
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth2/v2.0/token`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  { issuer, clients }: DevTokenEndpointOptions,
): Promise<void> {
  if (req.method !== 'POST') return send(res, 405, { error: 'invalid_request' });

  const form = new URLSearchParams(await readBody(req));
  const grant = form.get('grant_type');
  const isObo =
    grant === 'urn:ietf:params:oauth:grant-type:jwt-bearer' &&
    form.get('requested_token_use') === 'on_behalf_of';
  if (!isObo && grant !== 'client_credentials') {
    return send(res, 400, { error: 'unsupported_grant_type' });
  }

  const client = clients[form.get('client_id') ?? ''];
  if (!client || !sameSecret(client.secret, form.get('client_secret') ?? '')) {
    return send(res, 401, { error: 'invalid_client' });
  }

  const downstream = SCOPE_PATTERN.exec(form.get('scope') ?? '')?.[1];
  if (!downstream) return send(res, 400, { error: 'invalid_scope' });

  if (!isObo) {
    // The service acts as itself: no user, just the roles granted to this client.
    return send(res, 200, {
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: issuer.mint({
        tenant: SERVICE_TENANT,
        userId: form.get('client_id') as string,
        roles: client.roles ?? [],
        audience: downstream,
        scopes: [],
      }),
    });
  }

  let principal;
  try {
    principal = await issuer.verifier(30, client.audience).verify(form.get('assertion') ?? '');
  } catch {
    return send(res, 400, { error: 'invalid_grant' });
  }

  send(res, 200, {
    token_type: 'Bearer',
    expires_in: 3600,
    access_token: issuer.mint({
      tenant: principal.tenantId,
      userId: principal.userId,
      roles: [...principal.roles],
      audience: downstream,
    }),
  });
}

/**
 * Reads the services allowed to obtain tokens from JSON: `{ "<client id>": { "secret", "audience",
 * "roles"? } }`. Refuses anything malformed so a typo does not silently leave a service locked out.
 */
export function parseDevClients(text: string): Record<string, DevClient> {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('clients must be a JSON object keyed by client id');
  }
  const clients: Record<string, DevClient> = {};
  for (const [id, value] of Object.entries(raw)) {
    const c = value as Partial<DevClient> | null;
    if (typeof c?.secret !== 'string' || !c.secret)
      throw new Error(`client "${id}" needs a secret`);
    if (typeof c.audience !== 'string' || !c.audience) {
      throw new Error(`client "${id}" needs an audience`);
    }
    if (
      c.roles !== undefined &&
      !(Array.isArray(c.roles) && c.roles.every((r) => typeof r === 'string'))
    ) {
      throw new Error(`client "${id}" roles must be a list of strings`);
    }
    clients[id] = { secret: c.secret, audience: c.audience, ...(c.roles && { roles: c.roles }) };
  }
  return clients;
}
