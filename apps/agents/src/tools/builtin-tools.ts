import { z } from 'zod';
import type { RetrievalClient } from '../clients/service-clients';
import type { Mailer, TicketSystem } from './fake-backends';
import { ToolError, type AnyTool, type Tool } from './tool';

const asAny = <T>(tool: Tool<T>): AnyTool => tool as unknown as AnyTool;

export interface BuiltinToolDeps {
  retrieval: RetrievalClient;
  retrievalScope: string;
  tickets: TicketSystem;
  mailer: Mailer;
  emailAllowedDomains: readonly string[];
}

/** Retrieval decides what this user may see, as it does for the assistant: the agent adds no access of its own. */
const searchDocuments = (deps: BuiltinToolDeps): AnyTool =>
  asAny({
    name: 'search_documents',
    description: 'Search the company documents you are allowed to read.',
    risk: 'read',
    requiredRoles: [],
    input: z.object({ query: z.string().min(1).max(500) }).strict(),
    parametersHelp: '{"query": string}',
    describe: (args) => `Search documents for "${args.query}"`,
    async execute(args, ctx) {
      const token = await ctx.tokenFor(deps.retrievalScope);
      const hits = await deps.retrieval.search(
        token,
        { query: args.query, topK: 4 },
        ctx.idempotencyKey,
      );
      return hits.map((h) => ({ documentId: h.documentId, text: h.text }));
    },
  });

const getTicket = (deps: BuiltinToolDeps): AnyTool =>
  asAny({
    name: 'get_ticket',
    description: 'Look up a support ticket by id.',
    risk: 'read',
    requiredRoles: ['support', 'support-lead'],
    input: z.object({ id: z.string().regex(/^T-\d+$/) }).strict(),
    parametersHelp: '{"id": "T-<number>"}',
    describe: (args) => `Read ticket ${args.id}`,
    async execute(args, ctx) {
      const ticket = await deps.tickets.get(ctx.tenantId, args.id);
      if (!ticket) throw new ToolError(`Ticket ${args.id} does not exist`);
      return { id: ticket.id, title: ticket.title, body: ticket.body };
    },
  });

const createTicket = (deps: BuiltinToolDeps): AnyTool =>
  asAny({
    name: 'create_ticket',
    description: 'Open a new support ticket.',
    risk: 'write',
    requiredRoles: ['support', 'support-lead'],
    input: z
      .object({ title: z.string().min(3).max(120), body: z.string().min(1).max(2000) })
      .strict(),
    parametersHelp: '{"title": string, "body": string}',
    describe: (args) => `Create ticket "${args.title}"`,
    async execute(args, ctx) {
      const ticket = await deps.tickets.create(
        ctx.tenantId,
        { ...args, createdBy: ctx.userId },
        ctx.idempotencyKey,
      );
      return { id: ticket.id };
    },
  });

/** The domain check lives in the tool, so it holds even when a person approves a bad recipient by mistake. */
const sendEmail = (deps: BuiltinToolDeps): AnyTool =>
  asAny({
    name: 'send_email',
    description: 'Send an email to a person at an approved company domain.',
    risk: 'write',
    requiredRoles: ['support-lead'],
    input: z
      .object({
        to: z.string().email().max(254),
        subject: z.string().min(1).max(150),
        body: z.string().min(1).max(4000),
      })
      .strict(),
    parametersHelp: '{"to": email, "subject": string, "body": string}',
    describe: (args) => `Send an email to ${args.to} with subject "${args.subject}"`,
    async execute(args, ctx) {
      const domain = args.to.split('@').pop()?.toLowerCase() ?? '';
      if (!deps.emailAllowedDomains.includes(domain)) {
        throw new ToolError(`Sending to ${domain} is not allowed`);
      }
      await deps.mailer.send({
        tenantId: ctx.tenantId,
        to: args.to,
        subject: args.subject,
        body: args.body,
        sentBy: ctx.userId,
        idempotencyKey: ctx.idempotencyKey,
      });
      return { sent: true };
    },
  });

export function builtinTools(deps: BuiltinToolDeps): AnyTool[] {
  return [searchDocuments(deps), getTicket(deps), createTicket(deps), sendEmail(deps)];
}
