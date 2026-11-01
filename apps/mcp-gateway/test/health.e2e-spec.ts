import { TOKEN_VERIFIER, TestIssuer } from '@genai/auth';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { MCP_GATEWAY_CONFIG, loadConfig } from '../src/config/config';

describe('GET /health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(new TestIssuer().verifier())
      .overrideProvider(MCP_GATEWAY_CONFIG)
      .useValue(loadConfig({ OBO_TOKEN_ENDPOINT: 'http://x.test/token', OBO_CLIENT_ID: 'a' }))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports ok without a token (health checks are public)', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
  });
});
