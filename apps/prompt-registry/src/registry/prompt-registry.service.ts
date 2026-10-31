import { Inject, Injectable } from '@nestjs/common';
import { pickVariant } from '../domain/bucketing';
import {
  InvalidExperimentError,
  InvalidPromptError,
  PromptNotFoundError,
  VersionNotFoundError,
} from '../domain/errors';
import { extractVariables, renderTemplate } from '../domain/template';
import type {
  ActivationEvent,
  ExperimentVariant,
  PromptRecord,
  PromptVersion,
} from '../domain/types';
import { PROMPT_REPOSITORY, type PromptRepository } from '../repository/prompt.repository';

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_TEMPLATE_LENGTH = 50_000;

export interface CreateVersionInput {
  template: string;
  note?: string;
  createdBy?: string;
}

@Injectable()
export class PromptRegistryService {
  constructor(
    @Inject(PROMPT_REPOSITORY) private readonly repo: PromptRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Appends version N+1. Existing versions are never touched. The first version of a prompt
   * becomes active automatically; later ones stay inactive until someone activates them, so
   * publishing a draft can never change production behaviour by itself.
   */
  async createVersion(
    tenantId: string,
    name: string,
    input: CreateVersionInput,
  ): Promise<PromptVersion> {
    if (!NAME_PATTERN.test(name)) {
      throw new InvalidPromptError(
        'name must be lowercase letters, digits, ".", "_" or "-" (max 64 chars)',
      );
    }
    if (input.template.trim() === '' || input.template.length > MAX_TEMPLATE_LENGTH) {
      throw new InvalidPromptError(`template must be 1-${MAX_TEMPLATE_LENGTH} characters`);
    }

    const existing = await this.repo.get(tenantId, name);
    const record: PromptRecord = existing ?? {
      tenantId,
      name,
      versions: [],
      activeVersion: undefined,
      history: [],
      revision: 0,
    };

    const at = this.now().toISOString();
    const version: PromptVersion = {
      version: record.versions.length + 1,
      template: input.template,
      variables: extractVariables(input.template),
      createdAt: at,
      ...(input.note !== undefined && { note: input.note }),
      ...(input.createdBy !== undefined && { createdBy: input.createdBy }),
    };
    record.versions.push(version);

    if (record.activeVersion === undefined) {
      record.activeVersion = version.version;
      record.history.push({
        at,
        kind: 'initial',
        fromVersion: undefined,
        toVersion: version.version,
        ...(input.createdBy !== undefined && { by: input.createdBy }),
      });
    }

    await this.repo.save(record);
    return version;
  }

  async get(tenantId: string, name: string): Promise<PromptRecord> {
    const record = await this.repo.get(tenantId, name);
    if (!record) throw new PromptNotFoundError(name);
    return record;
  }

  async list(tenantId: string): Promise<PromptRecord[]> {
    return this.repo.list(tenantId);
  }

  async getVersion(tenantId: string, name: string, version: number): Promise<PromptVersion> {
    const record = await this.get(tenantId, name);
    const found = record.versions.find((v) => v.version === version);
    if (!found) throw new VersionNotFoundError(name, version);
    return found;
  }

  /**
   * Points the prompt at an existing version. Moving to an older version is a rollback, recorded
   * as such in the history. Activating the version that is already active is a no-op.
   */
  async activate(
    tenantId: string,
    name: string,
    version: number,
    by?: string,
  ): Promise<PromptRecord> {
    const record = await this.get(tenantId, name);
    if (!record.versions.some((v) => v.version === version)) {
      throw new VersionNotFoundError(name, version);
    }
    if (record.activeVersion === version) return record;

    const event: ActivationEvent = {
      at: this.now().toISOString(),
      kind:
        record.activeVersion !== undefined && version < record.activeVersion
          ? 'rollback'
          : 'activate',
      fromVersion: record.activeVersion,
      toVersion: version,
      ...(by !== undefined && { by }),
    };
    record.activeVersion = version;
    record.history.push(event);

    return this.repo.save(record);
  }

  /**
   * Splits traffic between existing versions by weight. Needs at least two distinct versions,
   * each with a positive integer weight. Replaces any experiment already running.
   */
  async setExperiment(
    tenantId: string,
    name: string,
    variants: ExperimentVariant[],
  ): Promise<PromptRecord> {
    const record = await this.get(tenantId, name);

    if (variants.length < 2) throw new InvalidExperimentError('needs at least two variants');
    if (new Set(variants.map((v) => v.version)).size !== variants.length) {
      throw new InvalidExperimentError('each version may appear only once');
    }
    for (const variant of variants) {
      if (!Number.isInteger(variant.weight) || variant.weight <= 0) {
        throw new InvalidExperimentError('weights must be positive integers');
      }
      if (!record.versions.some((v) => v.version === variant.version)) {
        throw new VersionNotFoundError(name, variant.version);
      }
    }

    record.experiment = {
      variants: variants.map(({ version, weight }) => ({ version, weight })),
      startedAt: this.now().toISOString(),
    };
    return this.repo.save(record);
  }

  async clearExperiment(tenantId: string, name: string): Promise<PromptRecord> {
    const record = await this.get(tenantId, name);
    if (!record.experiment) return record;
    delete record.experiment;
    return this.repo.save(record);
  }

  /**
   * Chooses the version to serve and renders it. With a running experiment and a `subjectKey`
   * (user or conversation id) the assignment is sticky; without a key we cannot be sticky, so we
   * serve the active version rather than flipping a coin per request.
   */
  async resolve(
    tenantId: string,
    name: string,
    input: { variables: Record<string, string>; subjectKey?: string },
  ): Promise<ResolvedPrompt> {
    const record = await this.get(tenantId, name);

    let version = record.activeVersion;
    let inExperiment = false;
    if (record.experiment && input.subjectKey !== undefined) {
      // startedAt is part of the key so each new experiment reshuffles who sees which variant.
      const key = `${tenantId}:${name}:${record.experiment.startedAt}:${input.subjectKey}`;
      version = pickVariant(
        key,
        record.experiment.variants.map((v) => ({ value: v.version, weight: v.weight })),
      );
      inExperiment = true;
    }

    const chosen = record.versions.find((v) => v.version === version);
    if (!chosen) throw new VersionNotFoundError(name, version ?? 0);

    return {
      name,
      version: chosen.version,
      inExperiment,
      rendered: renderTemplate(chosen.template, input.variables),
    };
  }
}

export interface ResolvedPrompt {
  name: string;
  version: number;
  /** True when the version came from an A/B split rather than the active pointer. */
  inExperiment: boolean;
  rendered: string;
}
