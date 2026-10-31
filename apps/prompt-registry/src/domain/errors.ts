export class PromptNotFoundError extends Error {
  constructor(name: string) {
    super(`Prompt "${name}" not found`);
    this.name = 'PromptNotFoundError';
  }
}

export class VersionNotFoundError extends Error {
  constructor(
    readonly promptName: string,
    readonly version: number,
  ) {
    super(`Prompt "${promptName}" has no version ${version}`);
    this.name = 'VersionNotFoundError';
  }
}

/** Someone else changed the prompt between our read and our write. Safe to retry. */
export class ConcurrentModificationError extends Error {
  constructor(name: string) {
    super(`Prompt "${name}" was modified concurrently`);
    this.name = 'ConcurrentModificationError';
  }
}

export class InvalidExperimentError extends Error {
  constructor(reason: string) {
    super(`Invalid experiment: ${reason}`);
    this.name = 'InvalidExperimentError';
  }
}

export class InvalidPromptError extends Error {
  constructor(reason: string) {
    super(`Invalid prompt: ${reason}`);
    this.name = 'InvalidPromptError';
  }
}
