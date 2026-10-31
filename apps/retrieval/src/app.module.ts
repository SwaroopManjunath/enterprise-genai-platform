import { Module } from '@nestjs/common';
import { RETRIEVAL_CONFIG, loadConfig } from './config/config';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [{ provide: RETRIEVAL_CONFIG, useFactory: () => loadConfig() }],
})
export class AppModule {}
