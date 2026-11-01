import 'reflect-metadata';
import { startTelemetry } from '@genai/observability';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config/config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const telemetry = startTelemetry('mcp-gateway');
  const app = await NestFactory.create(AppModule, { logger: telemetry.logger });
  app.enableShutdownHooks();
  app.getHttpServer().on('close', () => void telemetry.shutdown());
  await app.listen(config.port);
  new Logger('Bootstrap').log(`mcp-gateway listening on :${config.port}`);
}

void bootstrap();
