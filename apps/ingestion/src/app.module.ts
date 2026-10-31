import { Module } from '@nestjs/common';
import { INGESTION_CONFIG, loadConfig } from './config/config';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [{ provide: INGESTION_CONFIG, useFactory: () => loadConfig() }],
})
export class AppModule {}
