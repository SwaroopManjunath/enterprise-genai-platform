import type { Run } from '../domain/types';

/**
 * What a caller is shown of a run. The transcript is never exposed (it holds tool output), and
 * the arguments of a pending action go only to the owner who must decide on it.
 */
export function toRunView(run: Run, viewerId: string) {
  const isOwner = run.ownerId === viewerId;
  return {
    id: run.id,
    status: run.status,
    ...(run.failure && { failure: run.failure }),
    goal: run.goal,
    ...(run.answer !== undefined && { answer: run.answer }),
    steps: run.steps,
    maxSteps: run.maxSteps,
    ...(run.pending && {
      pendingApproval: {
        callId: run.pending.call.id,
        tool: run.pending.call.name,
        summary: run.pending.summary,
        ...(isOwner && { arguments: run.pending.call.arguments }),
        ...(run.pending.call.reason && { modelReason: run.pending.call.reason }),
        requestedAt: run.pending.requestedAt,
      },
    }),
    events: run.events,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
