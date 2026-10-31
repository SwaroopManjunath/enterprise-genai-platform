export interface Ticket {
  id: string;
  tenantId: string;
  title: string;
  body: string;
  createdBy: string;
  createdAt: string;
}

export interface SentEmail {
  tenantId: string;
  to: string;
  subject: string;
  body: string;
  sentBy: string;
  idempotencyKey: string;
}

/**
 * Stand-ins for a ticketing system. The point of this step is the control around the tools
 * (permissions, approval, limits), not the tickets: swapping in Jira or ServiceNow means
 * implementing this interface, nothing else changes.
 */
export interface TicketSystem {
  get(tenantId: string, id: string): Promise<Ticket | undefined>;
  /** Idempotent: the same key returns the ticket it already created instead of making another. */
  create(
    tenantId: string,
    input: { title: string; body: string; createdBy: string },
    idempotencyKey: string,
  ): Promise<Ticket>;
}

export interface Mailer {
  /** Idempotent on `idempotencyKey`: a retried send does not deliver twice. */
  send(email: SentEmail): Promise<void>;
}

export const TICKET_SYSTEM = Symbol('TICKET_SYSTEM');
export const MAILER = Symbol('MAILER');

export class InMemoryTicketSystem implements TicketSystem {
  private readonly tickets = new Map<string, Ticket>();
  private readonly byKey = new Map<string, string>();
  private counter = 100;

  get(tenantId: string, id: string): Promise<Ticket | undefined> {
    const ticket = this.tickets.get(id);
    return Promise.resolve(ticket?.tenantId === tenantId ? ticket : undefined);
  }

  create(
    tenantId: string,
    input: { title: string; body: string; createdBy: string },
    idempotencyKey: string,
  ): Promise<Ticket> {
    const existing = this.byKey.get(`${tenantId}:${idempotencyKey}`);
    const found = existing && this.tickets.get(existing);
    if (found) return Promise.resolve(found);

    this.counter += 1;
    const ticket: Ticket = {
      id: `T-${this.counter}`,
      tenantId,
      ...input,
      createdAt: new Date().toISOString(),
    };
    this.tickets.set(ticket.id, ticket);
    this.byKey.set(`${tenantId}:${idempotencyKey}`, ticket.id);
    return Promise.resolve(ticket);
  }

  /** Test and demo helper: put a ticket in without going through a tool. */
  seed(ticket: Omit<Ticket, 'createdAt'>): void {
    this.tickets.set(ticket.id, { ...ticket, createdAt: new Date().toISOString() });
  }

  list(tenantId: string): Ticket[] {
    return [...this.tickets.values()].filter((t) => t.tenantId === tenantId);
  }
}

export class InMemoryMailer implements Mailer {
  readonly outbox: SentEmail[] = [];

  send(email: SentEmail): Promise<void> {
    const key = `${email.tenantId}:${email.idempotencyKey}`;
    if (!this.outbox.some((m) => `${m.tenantId}:${m.idempotencyKey}` === key)) {
      this.outbox.push({ ...email });
    }
    return Promise.resolve();
  }
}
