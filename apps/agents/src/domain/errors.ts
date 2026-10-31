import type { QuestionReport } from '@genai/guardrails';

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run "${runId}" not found`);
    this.name = 'RunNotFoundError';
  }
}

/** Only the person who started a run can approve its actions (and read it, unless an auditor). */
export class NotRunOwnerError extends Error {
  constructor() {
    super('Only the user who started this run can do that');
    this.name = 'NotRunOwnerError';
  }
}

/** The decision does not match the run's state (not waiting, wrong call, already decided). */
export class InvalidDecisionError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidDecisionError';
  }
}

/** Someone else changed the run between our read and our write. */
export class ConcurrentRunUpdateError extends Error {
  constructor(runId: string) {
    super(`Run "${runId}" was modified concurrently`);
    this.name = 'ConcurrentRunUpdateError';
  }
}

/** The goal itself looks like an attack on the agent. Reasons stay in logs, not in the response. */
export class GoalBlockedError extends Error {
  constructor(readonly report: QuestionReport) {
    super('Goal blocked by guardrails');
    this.name = 'GoalBlockedError';
  }
}
