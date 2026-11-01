import type { AuthenticatedPrincipal, OboTokenClient } from '@genai/auth';
import type { Guardrails } from '@genai/guardrails';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AgentLimits } from '../config/config';
import {
  GoalBlockedError,
  InvalidDecisionError,
  NotRunOwnerError,
  RunNotFoundError,
} from '../domain/errors';
import type { EventType, FailureReason, Run, ToolCall } from '../domain/types';
import type { AgentModel } from '../model/agent-model';
import { ModelProtocolError } from '../model/protocol';
import type { RunStore } from '../store/run-store';
import { ToolError, type AnyTool, type ToolContext } from '../tools/tool';
import type { ToolRegistry } from '../tools/tool-registry';
import type { ToolCatalog } from '../tools/tool-catalog';
import { collectStrings, digest, isTimeout, stableStringify, truncate, withTimeout } from './util';

export interface RunnerDeps {
  store: RunStore;
  model: AgentModel;
  /** Decides, per caller, which tools exist: built-in ones plus any the MCP gateway allows them. */
  tools: ToolCatalog;
  guardrails: Guardrails;
  obo: OboTokenClient;
  gatewayScope: string;
  limits: AgentLimits;
  now?: () => number;
  newId?: () => string;
}

/** Role that may read any run in its tenant (read-only: it cannot approve anything). */
export const AUDITOR_ROLE = 'agent-auditor';

const FORMAT_REMINDER =
  'Reply with exactly one JSON object: {"calls":[{"name":...,"arguments":{...}}]} or {"final":"..."}.';

type Outcome = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Runs the plan-act loop with every limit enforced by this code, not by the model's cooperation:
 * a step budget, a deadline, per-call timeouts, a cap on calls per step, loop detection, strict
 * argument validation, role-based tool visibility, and a human approval before any write. The
 * model only proposes; nothing it says widens what it may do.
 *
 * All state lives in the RunStore and each change is saved, so a run can pause for approval and
 * be resumed by any replica.
 */
export class AgentRunner {
  private readonly logger = new Logger('AgentRunner');
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  async start(
    caller: AuthenticatedPrincipal,
    input: { goal: string; maxSteps?: number },
    requestId: string,
  ): Promise<Run> {
    const { guardrails, limits } = this.deps;

    const verdict = guardrails.checkQuestion(input.goal);
    if (verdict.blocked) throw new GoalBlockedError(verdict.report);

    const maxSteps = Math.min(
      Math.max(input.maxSteps ?? limits.defaultMaxSteps, 1),
      limits.hardMaxSteps,
    );
    const stamp = new Date(this.now()).toISOString();
    const run: Run = {
      id: this.newId(),
      tenantId: caller.tenantId,
      ownerId: caller.userId,
      goal: verdict.text,
      status: 'running',
      steps: 0,
      maxSteps,
      deadlineAt: this.now() + limits.runTimeoutMs,
      transcript: [{ role: 'user', content: verdict.text }],
      queue: [],
      callCounts: {},
      consecutiveModelErrors: 0,
      nextCallNumber: 1,
      events: [],
      createdAt: stamp,
      updatedAt: stamp,
      revision: 0,
    };
    const registry = await this.deps.tools.registryFor(caller);
    this.record(run, 'run_started', caller.userId, {
      goalChars: verdict.text.length,
      maxSteps,
      tools: registry.visibleTo(caller.roles).map((t) => t.name),
      redactions: verdict.report.redactions,
    });

    return this.advance(await this.deps.store.save(run), caller, requestId, registry);
  }

  /** Reading a run: its owner, or an auditor in the same tenant. Another tenant's run does not exist. */
  async get(caller: AuthenticatedPrincipal, runId: string): Promise<Run> {
    const run = await this.deps.store.get(caller.tenantId, runId);
    if (!run) throw new RunNotFoundError(runId);
    if (run.ownerId !== caller.userId && !caller.roles.includes(AUDITOR_ROLE)) {
      throw new NotRunOwnerError();
    }
    return run;
  }

  /**
   * Approve or reject the write action a run is waiting on. Only the owner may decide, and only
   * for the exact call stored on the run: the decision carries no arguments, so nothing can be
   * swapped between what was shown and what runs.
   */
  async decide(
    caller: AuthenticatedPrincipal,
    runId: string,
    input: { callId: string; decision: 'approve' | 'reject' },
    requestId: string,
  ): Promise<Run> {
    const run = await this.deps.store.get(caller.tenantId, runId);
    if (!run) throw new RunNotFoundError(runId);
    if (run.ownerId !== caller.userId) throw new NotRunOwnerError();

    const pending = run.pending;
    if (run.status !== 'awaiting_approval' || !pending) {
      throw new InvalidDecisionError('This run is not waiting for an approval');
    }
    if (pending.call.id !== input.callId) {
      throw new InvalidDecisionError('That call is not the one awaiting approval');
    }

    const call = pending.call;
    // Resolved again now, from what this caller may use now, not from what they could use before.
    const registry = await this.deps.tools.registryFor(caller);
    const tool = registry.resolve(call.name, caller.roles);
    run.pending = undefined;
    run.status = 'running';
    // The clock covers active work: time spent waiting for a person does not count against it.
    run.deadlineAt = this.now() + this.deps.limits.runTimeoutMs;
    this.record(run, 'approval_decided', caller.userId, {
      callId: call.id,
      tool: call.name,
      decision: input.decision,
      argsDigest: digest(call.arguments),
    });

    // Claiming the decision is a compare-and-swap: of two racing approvals exactly one gets past
    // this save, so the action cannot run twice.
    let current = await this.deps.store.save(run);

    if (input.decision === 'reject') {
      current.transcript.push({
        role: 'user',
        content: `${this.resultBlock(call, tool?.name, 'The user rejected this action. Do not retry it; continue without it or explain.')}`,
      });
      current = await this.deps.store.save(current);
    } else if (!tool) {
      current = await this.refuse(current, call, 'not_permitted', 'unknown tool');
    } else {
      current = await this.runTool(current, call, tool, caller, caller.userId, requestId);
    }
    return this.advance(current, caller, requestId, registry);
  }

  private async advance(
    run: Run,
    caller: AuthenticatedPrincipal,
    requestId: string,
    registry: ToolRegistry,
  ): Promise<Run> {
    let current = run;
    while (current.status === 'running') {
      if (this.now() >= current.deadlineAt) return this.fail(current, 'timeout');

      const call = current.queue.shift();
      if (call) {
        current = await this.handleCall(current, call, caller, requestId, registry);
        continue;
      }
      if (current.steps >= current.maxSteps) return this.fail(current, 'step_limit');
      current = await this.modelStep(current, caller, requestId, registry);
    }
    return current;
  }

  private async modelStep(
    run: Run,
    caller: AuthenticatedPrincipal,
    requestId: string,
    tools: ToolRegistry,
  ): Promise<Run> {
    const { model, guardrails, obo, gatewayScope, limits } = this.deps;
    run.steps += 1;

    let response;
    try {
      const token = await obo.exchange(caller.accessToken, gatewayScope);
      response = await withTimeout(
        model.next({
          tools: tools.visibleTo(caller.roles),
          transcript: run.transcript,
          token,
          requestId,
        }),
        this.budget(run, limits.modelTimeoutMs),
        'model call',
      );
    } catch (error) {
      if (error instanceof ModelProtocolError) return this.malformed(run, error.message);
      if (isTimeout(error)) {
        return this.fail(run, this.now() >= run.deadlineAt ? 'timeout' : 'model_unavailable');
      }
      await this.fail(run, 'model_unavailable');
      throw error;
    }

    run.consecutiveModelErrors = 0;
    const { step, outputContext } = response;

    if (step.kind === 'final') {
      const verdict = guardrails.checkOutput(step.answer, outputContext);
      this.record(run, 'model_step', 'agent', { kind: 'final', output: verdict.report });
      if (verdict.blocked) return this.fail(run, 'answer_blocked');

      run.status = 'completed';
      run.answer = verdict.text;
      this.record(run, 'run_completed', 'agent', { chars: verdict.text.length });
      return this.save(run);
    }

    if (step.calls.length > limits.maxCallsPerStep) {
      return this.malformed(
        run,
        `too many calls in one step (the limit is ${limits.maxCallsPerStep})`,
      );
    }

    const calls: ToolCall[] = step.calls.map((c) => ({
      id: `c${run.nextCallNumber++}`,
      name: c.name,
      arguments: c.arguments,
      ...(step.reason !== undefined && { reason: step.reason }),
    }));

    for (const call of calls) {
      const key = `${call.name}:${stableStringify(call.arguments)}`;
      run.callCounts[key] = (run.callCounts[key] ?? 0) + 1;
      if (run.callCounts[key] >= limits.loopRepeatLimit) {
        this.record(run, 'model_step', 'agent', { kind: 'loop', tool: truncate(call.name, 64) });
        return this.fail(run, 'loop_detected');
      }
    }

    run.queue.push(...calls);
    run.transcript.push({
      role: 'assistant',
      content: JSON.stringify({
        ...(step.reason !== undefined && { reason: step.reason }),
        calls: calls.map(({ name, arguments: args }) => ({ name, arguments: args })),
      }),
    });
    this.record(run, 'model_step', 'agent', {
      kind: 'calls',
      calls: calls.map((c) => ({
        id: c.id,
        tool: truncate(c.name, 64),
        argsDigest: digest(c.arguments),
      })),
    });
    return this.save(run);
  }

  /** A reply we could not use. One is forgiven (the model is told what was wrong); two in a row end the run. */
  private async malformed(run: Run, reason: string): Promise<Run> {
    run.consecutiveModelErrors += 1;
    this.record(run, 'model_error', 'agent', { reason });
    if (run.consecutiveModelErrors >= 2) return this.fail(run, 'model_error');

    run.transcript.push({
      role: 'user',
      content: `Your last reply could not be used (${reason}). ${FORMAT_REMINDER}`,
    });
    return this.save(run);
  }

  private async handleCall(
    run: Run,
    call: ToolCall,
    caller: AuthenticatedPrincipal,
    requestId: string,
    registry: ToolRegistry,
  ): Promise<Run> {
    // A tool the caller may not use is refused exactly like one that does not exist.
    const tool = registry.resolve(call.name, caller.roles);
    if (!tool) {
      return this.refuse(
        run,
        call,
        'unknown_or_not_permitted',
        `unknown tool "${truncate(call.name, 64)}"`,
      );
    }

    const parsed = tool.input.safeParse(call.arguments);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`)
        .join('; ');
      return this.refuse(
        run,
        call,
        'invalid_arguments',
        `invalid arguments (${truncate(issues, 300)})`,
        tool,
      );
    }

    const args = parsed.data as Record<string, unknown>;
    const validated: ToolCall = { ...call, arguments: args };

    if (tool.risk === 'write') {
      // Never executed from here: a person decides, and the stored call is what runs.
      run.status = 'awaiting_approval';
      run.pending = {
        call: validated,
        summary: tool.describe(args as never),
        requestedAt: new Date(this.now()).toISOString(),
      };
      this.record(run, 'approval_requested', 'agent', {
        callId: call.id,
        tool: tool.name,
        summary: run.pending.summary,
        argsDigest: digest(args),
      });
      return this.save(run);
    }

    return this.runTool(run, validated, tool, caller, 'agent', requestId);
  }

  private async refuse(
    run: Run,
    call: ToolCall,
    reason: string,
    message: string,
    tool?: AnyTool,
  ): Promise<Run> {
    this.record(run, 'tool_denied', 'agent', {
      callId: call.id,
      tool: truncate(call.name, 64),
      reason,
    });
    run.transcript.push({
      role: 'user',
      content: this.resultBlock(call, tool?.name, `error: ${message}`),
    });
    return this.save(run);
  }

  private async runTool(
    run: Run,
    call: ToolCall,
    tool: AnyTool,
    caller: AuthenticatedPrincipal,
    actor: string,
    requestId: string,
  ): Promise<Run> {
    const { limits, guardrails, obo } = this.deps;
    this.record(run, 'tool_call', actor, {
      callId: call.id,
      tool: tool.name,
      risk: tool.risk,
      argsDigest: digest(call.arguments),
    });

    const controller = new AbortController();
    const ctx: ToolContext = {
      tenantId: caller.tenantId,
      userId: caller.userId,
      runId: run.id,
      idempotencyKey: `${run.id}:${call.id}`,
      tokenFor: (scope) => obo.exchange(caller.accessToken, scope),
      signal: controller.signal,
    };

    let outcome: Outcome;
    try {
      const value = await withTimeout(
        tool.execute(call.arguments as never, ctx),
        this.budget(run, limits.toolTimeoutMs),
        `tool ${tool.name}`,
        () => controller.abort(),
      );
      outcome = { ok: true, value };
    } catch (error) {
      if (error instanceof ToolError) outcome = { ok: false, error: error.message };
      else if (isTimeout(error)) outcome = { ok: false, error: 'the tool timed out' };
      else {
        // Details stay in the logs: an internal error message is not something to hand to a model.
        this.logger.warn(`tool ${tool.name} failed (request ${requestId}): ${String(error)}`);
        outcome = { ok: false, error: 'the tool failed' };
      }
    }

    const prepared = this.prepareOutput(outcome, guardrails, limits.maxToolOutputChars);
    this.record(run, 'tool_result', 'agent', {
      callId: call.id,
      tool: tool.name,
      ok: outcome.ok,
      withheld: prepared.withheld,
      truncated: prepared.truncated,
      injectionSignals: prepared.signals,
    });
    run.transcript.push({
      role: 'user',
      content: this.resultBlock(call, tool.name, prepared.text),
    });
    return this.save(run);
  }

  /**
   * Tool output is untrusted: a document or ticket can contain text written to hijack the agent.
   * It is screened like a retrieved source (an instruction-like result never reaches the model),
   * redacted like an answer, and cut to a fixed size.
   */
  private prepareOutput(outcome: Outcome, guardrails: Guardrails, maxChars: number) {
    if (!outcome.ok)
      return { text: `error: ${outcome.error}`, withheld: false, truncated: false, signals: [] };

    const raw = JSON.stringify(outcome.value) ?? 'null';
    // Screen the text as a person or model would read it, never its JSON-escaped form.
    const strings = collectStrings(outcome.value).map((text) => ({ text }));
    const screened = guardrails.screenSources([
      ...strings,
      { text: strings.map((s) => s.text).join('\n') },
    ]);
    if (screened.kept.length < strings.length + 1) {
      return {
        text: 'error: the tool output was withheld because it contained instructions',
        withheld: true,
        truncated: false,
        signals: screened.report.signals,
      };
    }

    const redacted = guardrails.redactForOutput(raw);
    const truncated = redacted.length > maxChars;
    return {
      text: truncated ? `${redacted.slice(0, maxChars)}…[truncated]` : redacted,
      withheld: false,
      truncated,
      signals: [] as string[],
    };
  }

  /** Delimits data so it reads as data: a stray closing tag in the content cannot end the block early. */
  private resultBlock(call: ToolCall, toolName: string | undefined, text: string): string {
    const safe = text.replace(/<\/?tool_result/gi, '');
    return `<tool_result call="${call.id}" tool="${toolName ?? 'unknown'}">\n${safe}\n</tool_result>`;
  }

  /** The time a single call may take: its own limit, or what is left of the run's deadline. */
  private budget(run: Run, limitMs: number): number {
    return Math.max(Math.min(limitMs, run.deadlineAt - this.now()), 1);
  }

  private async fail(run: Run, reason: FailureReason): Promise<Run> {
    run.status = 'failed';
    run.failure = reason;
    run.queue = [];
    run.pending = undefined;
    this.record(run, 'run_failed', 'agent', { reason });
    return this.save(run);
  }

  private save(run: Run): Promise<Run> {
    return this.deps.store.save(run);
  }

  private record(run: Run, type: EventType, actor: string, data: Record<string, unknown>): void {
    const at = new Date(this.now()).toISOString();
    run.events.push({ at, type, actor, data });
    run.updatedAt = at;
  }
}
