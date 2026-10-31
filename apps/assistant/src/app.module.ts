import { authProviders } from '@genai/auth';
import { Module } from '@nestjs/common';
import { ASSISTANT_CONFIG, loadConfig } from './config/config';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [{ provide: ASSISTANT_CONFIG, useFactory: () => loadConfig() }, ...authProviders()],
})
export class AppModule {}
