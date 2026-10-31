import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { HealthController } from './health.controller';
import { InMemoryPromptRepository } from './repository/in-memory-prompt.repository';
import { PROMPT_REPOSITORY, type PromptRepository } from './repository/prompt.repository';
import { PromptRegistryService } from './registry/prompt-registry.service';
import { RegistryController } from './registry/registry.controller';
import { RegistryExceptionFilter } from './registry/registry-exception.filter';

@Module({
  controllers: [HealthController, RegistryController],
  providers: [
    { provide: PROMPT_REPOSITORY, useClass: InMemoryPromptRepository },
    {
      provide: PromptRegistryService,
      inject: [PROMPT_REPOSITORY],
      useFactory: (repo: PromptRepository) => new PromptRegistryService(repo),
    },
    { provide: APP_FILTER, useClass: RegistryExceptionFilter },
  ],
})
export class AppModule {}
