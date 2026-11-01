import 'reflect-metadata';
import { startTelemetry } from '@genai/observability';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 3001);
  const telemetry = startTelemetry('prompt-registry');
  const app = await NestFactory.create(AppModule, { logger: telemetry.logger });
  app.enableShutdownHooks();
  app.getHttpServer().on('close', () => void telemetry.shutdown());
  await app.listen(port);
  new Logger('Bootstrap').log(`prompt-registry listening on :${port}`);
}

void bootstrap();
