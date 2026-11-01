export type RunStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed';

/** Why a run ended without an answer. Each is a limit doing its job, not a crash. */
export type FailureReason =
  | 'step_limit'
  | 'timeout'
  | 'loop_detected'
  | 'model_error'
  | 'model_unavailable'
  | 'answer_blocked';

export interface ToolCall {
  /** Unique within the run (`c1`, `c2`, ...). Approvals and idempotency keys refer to it. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** The model's stated reason for the call. Untrusted text: a claim, not a fact. */
  reason?: string;
}

/**
 * A write action waiting for a person. The arguments here are exactly what will run if approved:
 * approval binds to this stored call, never to a re-generated one.
 */
export interface PendingApproval {
  call: ToolCall;
  /** Human-readable description of the action, written by the tool. */
  summary: string;
  requestedAt: string;
}

export type EventType =
  | 'run_started'
  | 'model_step'
  | 'model_error'
  | 'tool_call'
  | 'tool_denied'
  | 'tool_result'
  | 'approval_requested'
  | 'approval_decided'
  | 'run_completed'
  | 'run_failed';

/** Append-only audit entry. `data` holds facts and digests, never raw tool output. */
export interface RunEvent {
  at: string;
  type: EventType;
  /** Who or what caused it: the user's id, or `agent` for the model's own steps. */
  actor: string;
  data: Record<string, unknown>;
}

/** What the model is shown as the conversation so far. Tool results arrive as `user` messages. */
export interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Run {
  id: string;
  tenantId: string;
  /** The user who started the run: the only one who can approve its actions. */
  ownerId: string;
  /** The goal as given to the model (sensitive data already masked). */
  goal: string;
  status: RunStatus;
  failure?: FailureReason;
  answer?: string;
  /** Model calls made so far. */
  steps: number;
  maxSteps: number;
  /** Epoch milliseconds after which the run is cut off. */
  deadlineAt: number;
  transcript: TranscriptMessage[];
  /** Calls the model asked for that have not run yet, in order. */
  queue: ToolCall[];
  /** Set while status is awaiting_approval. */
  pending?: PendingApproval;
  /** How many times each distinct call has been requested, for loop detection. */
  callCounts: Record<string, number>;
  consecutiveModelErrors: number;
  nextCallNumber: number;
  events: RunEvent[];
  createdAt: string;
  updatedAt: string;
  /** Incremented on every save; a save with a stale revision is rejected. */
  revision: number;
}
