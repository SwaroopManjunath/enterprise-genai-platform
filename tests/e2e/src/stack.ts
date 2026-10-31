import 'reflect-metadata';
import {
  EnvSecretProvider,
  SECRET_PROVIDER,
  TOKEN_VERIFIER,
  TestIssuer,
  startDevTokenEndpoint,
  type RunningDevTokenEndpoint,
} from '@genai/auth';
import type { INestApplication, Type } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule as AssistantModule } from '../../../apps/assistant/src/app.module';
import { ASSISTANT_CONFIG, loadConfig } from '../../../apps/assistant/src/config/config';
import { AppModule as GatewayModule } from '../../../apps/llm-gateway/src/app.module';
import { GroundedMockProvider } from '../../../apps/llm-gateway/src/llm/grounded-mock.provider';
import { LLM_PROVIDERS } from '../../../apps/llm-gateway/src/llm/types';
import { AppModule as PromptsModule } from '../../../apps/prompt-registry/src/app.module';
import { AppModule as RetrievalModule } from '../../../apps/retrieval/src/app.module';

/** Each service accepts only tokens minted for its own audience: tokens are not interchangeable. */
export const AUDIENCE = {
  assistant: 'api://assistant',
  retrieval: 'api://retrieval',
  gateway: 'api://gateway',
  prompts: 'api://prompt-registry',
} as const;

export type Service = keyof typeof AUDIENCE;

export interface Caller {
  tenant: string;
  userId?: string;
  roles?: string[];
}

export interface HttpResult {
  status: number;
  headers: Headers;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

interface Running {
  app: INestApplication;
  url: string;
}

/** The real services, running together on random local ports and talking over HTTP. */
export class Stack {
  constructor(
    readonly issuer: TestIssuer,
    readonly urls: Record<Service, string>,
    readonly llm: GroundedMockProvider,
    private readonly apps: Record<Service, INestApplication>,
    private readonly oboEndpoint: RunningDevTokenEndpoint,
  ) {}

  /** A genuinely signed token for a user, valid for ONE service. */
  token(service: Service, caller: Caller): string {
    return this.issuer.mint({
      tenant: caller.tenant,
      userId: caller.userId ?? 'user-1',
      roles: caller.roles ?? [],
      audience: AUDIENCE[service],
    });
  }

  async call(
    method: 'GET' | 'POST' | 'PUT',
    service: Service,
    path: string,
    options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<HttpResult> {
    const response = await fetch(`${this.urls[service]}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(options.token && { authorization: `Bearer ${options.token}` }),
        ...options.headers,
      },
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : undefined,
    };
  }

  /** Ask the assistant as a user. */
  ask(
    caller: Caller,
    question: string,
    extra: { headers?: Record<string, string>; body?: object } = {},
  ) {
    return this.call('POST', 'assistant', '/v1/ask', {
      token: this.token('assistant', caller),
      body: { question, ...extra.body },
      ...(extra.headers && { headers: extra.headers }),
    });
  }

  /** Index a document the way the ingestion pipeline would: with the `indexer` role. */
  async index(
    tenant: string,
    documentId: string,
    chunks: { index: number; text: string; metadata?: object }[],
    options: { allowedRoles?: string[]; tags?: string[] } = {},
  ): Promise<void> {
    const res = await this.call('PUT', 'retrieval', `/v1/index/documents/${documentId}`, {
      token: this.token('retrieval', { tenant, roles: ['indexer'] }),
      body: { chunks, ...options },
    });
    if (res.status !== 200) throw new Error(`indexing ${documentId} failed: ${res.status}`);
  }

  /** Publish a prompt version as a prompt admin; optionally make it active. */
  async publishPrompt(
    tenant: string,
    name: string,
    template: string,
    activate?: number,
  ): Promise<number> {
    const token = this.token('prompts', {
      tenant,
      userId: 'prompt-owner',
      roles: ['prompt-admin'],
    });
    const created = await this.call('POST', 'prompts', `/v1/prompts/${name}/versions`, {
      token,
      body: { template },
    });
    if (created.status !== 201) throw new Error(`publishing prompt failed: ${created.status}`);
    if (activate !== undefined) {
      await this.call('PUT', 'prompts', `/v1/prompts/${name}/active`, {
        token,
        body: { version: activate },
      });
    }
    return created.body.version as number;
  }

  /** Stops one service, to rehearse an outage. */
  stopService(service: Service): Promise<void> {
    return this.apps[service].close();
  }

  async stop(): Promise<void> {
    await Promise.allSettled(Object.values(this.apps).map((app) => app.close()));
    await this.oboEndpoint.close();
  }
}

async function start(
  module: Type<unknown>,
  audience: string,
  issuer: TestIssuer,
  configure: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<Running> {
  const builder = Test.createTestingModule({ imports: [module] })
    .overrideProvider(TOKEN_VERIFIER)
    .useValue(issuer.verifier(30, audience));
  const app = (await configure(builder).compile()).createNestApplication();
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as { port: number }).port;
  return { app, url: `http://127.0.0.1:${port}` };
}

export async function startStack(): Promise<Stack> {
  const issuer = new TestIssuer();
  const llm = new GroundedMockProvider();

  const retrieval = await start(RetrievalModule, AUDIENCE.retrieval, issuer);
  const prompts = await start(PromptsModule, AUDIENCE.prompts, issuer);
  const gateway = await start(GatewayModule, AUDIENCE.gateway, issuer, (b) =>
    b.overrideProvider(LLM_PROVIDERS).useValue([llm]),
  );

  // Stand-in for Entra's on-behalf-of endpoint, so the real OBO client runs over real HTTP.
  const obo = await startDevTokenEndpoint({
    issuer,
    clients: { assistant: { secret: 'dev-secret', audience: AUDIENCE.assistant } },
  });

  const assistant = await start(AssistantModule, AUDIENCE.assistant, issuer, (b) =>
    b
      .overrideProvider(ASSISTANT_CONFIG)
      .useValue(
        loadConfig({
          GATEWAY_URL: gateway.url,
          PROMPTS_URL: prompts.url,
          RETRIEVAL_URL: retrieval.url,
          OBO_TOKEN_ENDPOINT: obo.url,
          OBO_CLIENT_ID: 'assistant',
        }),
      )
      .overrideProvider(SECRET_PROVIDER)
      .useValue(new EnvSecretProvider({ SECRET_ASSISTANT_CLIENT_SECRET: 'dev-secret' })),
  );

  return new Stack(
    issuer,
    {
      assistant: assistant.url,
      retrieval: retrieval.url,
      gateway: gateway.url,
      prompts: prompts.url,
    },
    llm,
    {
      assistant: assistant.app,
      retrieval: retrieval.app,
      gateway: gateway.app,
      prompts: prompts.app,
    },
    obo,
  );
}

/** The documents used by the tests and the demo: one open, one manager-only, one for another tenant. */
export async function seedDocuments(stack: Stack): Promise<void> {
  await stack.index('acme-bank', 'handbook', [
    {
      index: 0,
      text: '# Refunds\nRefunds take five working days to reach the original card.',
      metadata: { headingPath: ['Refunds'] },
    },
    {
      index: 1,
      text: '# Cards\nA lost card can be blocked at any time in the mobile app.',
      metadata: { headingPath: ['Cards'] },
    },
  ]);
  await stack.index(
    'acme-bank',
    'salary-bands',
    [
      {
        index: 0,
        text: '# Salary bands\nSalary bands for managers start at level M1 and are reviewed every year.',
        metadata: { headingPath: ['Salary bands'] },
      },
    ],
    { allowedRoles: ['manager'] },
  );
  await stack.index('globex', 'handbook', [
    {
      index: 0,
      text: '# Refunds\nRefunds take ten working days at Globex.',
      metadata: { headingPath: ['Refunds'] },
    },
  ]);
}
