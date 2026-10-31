/** One immutable snapshot of a prompt. Edits never change a version; they create the next one. */
export interface PromptVersion {
  version: number;
  template: string;
  /** Variables the template requires, extracted when the version was created. */
  variables: string[];
  note?: string;
  createdBy?: string;
  createdAt: string;
}

export type ActivationKind = 'initial' | 'activate' | 'rollback';

/** Audit trail entry: who moved the active pointer, from where, to where. */
export interface ActivationEvent {
  at: string;
  kind: ActivationKind;
  fromVersion: number | undefined;
  toVersion: number;
  by?: string;
}

export interface ExperimentVariant {
  version: number;
  weight: number;
}

export interface Experiment {
  variants: ExperimentVariant[];
  startedAt: string;
}

export interface PromptRecord {
  tenantId: string;
  name: string;
  versions: PromptVersion[];
  /** Version served to everyone not in an experiment. */
  activeVersion: number | undefined;
  experiment?: Experiment;
  history: ActivationEvent[];
  /** Optimistic-concurrency counter; incremented by the repository on every save. */
  revision: number;
}
