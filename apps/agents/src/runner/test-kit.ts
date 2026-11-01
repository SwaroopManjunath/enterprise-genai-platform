import type { AuthenticatedPrincipal } from '@genai/auth';
import { Guardrails } from '@genai/guardrails';
import { z } from 'zod';
import type { AgentLimits } from '../config/config';
import type { AgentModel, ModelRequest, ModelResponse } from '../model/agent-model';
import type { ModelStep } from '../model/protocol';
import { InMemoryRunStore } from '../store/run-store';
import { ToolError, type AnyTool, type ToolContext, type ToolRisk } from '../tools/tool';
import { StaticToolCatalog } from '../tools/tool-catalog';
import { ToolRegistry } from '../tools/tool-registry';
import { AgentRunner } from './agent-runner';

export const CANARY = 'cnry-0123456789abcdef';
export const INSTRUCTIONS =
  'You are a careful assistant that completes the goal using the listed tools only.';

type Script = ModelStep | Error | ((request: ModelRequest) => ModelStep | Error);

/** A model that replies from a script, so tests can make it misbehave in exactly the way they want. */
export class ScriptedModel implements AgentModel {
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(
    private readonly script: Script[],
    private readonly repeatLast = false,
  ) {}

  next(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const at = this.repeatLast ? Math.min(this.index, this.script.length - 1) : this.index;
    this.index += 1;
    const entry = this.script[at];
    if (entry === undefined) return Promise.reject(new Error('script exhausted'));
    const step = typeof entry === 'function' ? entry(request) : entry;
    if (step instanceof Error) return Promise.reject(step);
    return Promise.resolve({
      step,
      outputContext: { canary: CANARY, instructionText: INSTRUCTIONS },
    });
  }
}

export const calls = (
  ...cs: { name: string; arguments?: Record<string, unknown> }[]
): ModelStep => ({
  kind: 'calls',
  reason: 'because',
  calls: cs.map((c) => ({ name: c.name, arguments: c.arguments ?? {} })),
});
export const call = (name: string, args: Record<string, unknown> = {}): ModelStep =>
  calls({ name, arguments: args });
export const final = (answer: string): ModelStep => ({ kind: 'final', answer });

export interface FakeTool {
  tool: AnyTool;
  executions: { args: Record<string, unknown>; ctx: ToolContext }[];
}

/** A tool that records every execution and returns whatever `behave` says. */
export function fakeTool(
  name: string,
  options: {
    risk?: ToolRisk;
    roles?: string[];
    behave?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown> | unknown;
  } = {},
): FakeTool {
  const executions: FakeTool['executions'] = [];
  const tool = {
    name,
    description: `${name} tool`,
    risk: options.risk ?? 'read',
    requiredRoles: options.roles ?? [],
    input: z.object({ q: z.string().optional(), to: z.string().optional() }).strict(),
    parametersHelp: '{"q"?: string}',
    describe: (args: Record<string, unknown>) => `${name} ${JSON.stringify(args)}`,
    async execute(args: Record<string, unknown>, ctx: ToolContext) {
      executions.push({ args, ctx });
      return options.behave ? options.behave(args, ctx) : { ok: true };
    },
  } as unknown as AnyTool;
  return { tool, executions };
}

export const toolFails = (message: string) => () => {
  throw new ToolError(message);
};

export const principal = (
  overrides: Partial<AuthenticatedPrincipal> = {},
): AuthenticatedPrincipal => ({
  tenantId: 'acme',
  userId: 'alice',
  roles: ['agent-user', 'support'],
  scopes: [],
  tokenId: undefined,
  expiresAt: new Date(Date.now() + 3_600_000),
  accessToken: 'alice-token',
  ...overrides,
});

export const LIMITS: AgentLimits = {
  defaultMaxSteps: 6,
  hardMaxSteps: 10,
  runTimeoutMs: 30_000,
  toolTimeoutMs: 1_000,
  modelTimeoutMs: 1_000,
  maxCallsPerStep: 3,
  loopRepeatLimit: 3,
  maxToolOutputChars: 400,
};

export function buildRunner(options: {
  model: AgentModel;
  tools: AnyTool[];
  limits?: Partial<AgentLimits>;
  guardrails?: Guardrails;
  clock?: { now: number };
}) {
  const store = new InMemoryRunStore();
  const clock = options.clock ?? { now: 1_000_000 };
  const runner = new AgentRunner({
    store,
    model: options.model,
    tools: new StaticToolCatalog(new ToolRegistry(options.tools)),
    guardrails: options.guardrails ?? new Guardrails({ mode: 'enforce' }),
    obo: { exchange: (_token, scope) => Promise.resolve(`obo:${scope}`) },
    gatewayScope: 'api://gateway/.default',
    limits: { ...LIMITS, ...options.limits },
    now: () => clock.now,
    newId: (() => {
      let n = 0;
      return () => `run-${++n}`;
    })(),
  });
  return { runner, store, clock };
}

export const eventTypes = (run: { events: { type: string }[] }): string[] =>
  run.events.map((e) => e.type);
