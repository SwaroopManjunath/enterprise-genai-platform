import type { z } from 'zod';

/** `read` tools only fetch. `write` tools change something outside the agent, so a person approves each call. */
export type ToolRisk = 'read' | 'write';

/** What a tool may use while running. Tokens are never stored in the run; they come from the live request. */
export interface ToolContext {
  tenantId: string;
  userId: string;
  runId: string;
  /** `${runId}:${callId}`: a retried execution of the same call must not repeat its effect. */
  idempotencyKey: string;
  /** A token for another service, obtained on behalf of the user who is acting. */
  tokenFor(scope: string): Promise<string>;
  /** Aborted when the per-tool timeout fires. */
  signal: AbortSignal;
}

export interface Tool<TInput = Record<string, unknown>> {
  name: string;
  /** Shown to the model. */
  description: string;
  risk: ToolRisk;
  /** The caller needs at least one of these roles to see or use the tool. Empty means any caller. */
  requiredRoles: readonly string[];
  /** Strict: unknown fields are rejected rather than ignored. */
  input: z.ZodType<TInput>;
  /** Plain-text signature shown to the model, e.g. `{"query": string}`. */
  parametersHelp: string;
  /** What the call will do, in words a person approving it can read. Written by the tool, not the model. */
  describe(args: TInput): string;
  execute(args: TInput, ctx: ToolContext): Promise<unknown>;
}

/** An erased tool, for registries that hold tools with different input types. */
export type AnyTool = Tool<never>;

/** Thrown by a tool for a failure the model can act on ("recipient not allowed"). The message goes back to the model. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
