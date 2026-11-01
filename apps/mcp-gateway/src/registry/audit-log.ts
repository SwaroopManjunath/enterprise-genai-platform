import { metricsFor } from '@genai/observability';
import type { AuditEntry } from '../domain/types';
import type { AuditStore } from '../store/stores';

const metrics = metricsFor('mcp-gateway');

/** Stamps and appends. The only way anything in the gateway writes to the audit store. */
export class AuditLog {
  constructor(
    private readonly store: AuditStore,
    private readonly now: () => number,
  ) {}

  record(entry: Omit<AuditEntry, 'id' | 'at'>): Promise<void> {
    // Everything the gateway does passes here, so the metric and the audit trail cannot disagree.
    metrics.count('mcpCalls', { action: entry.action, outcome: entry.outcome });
    return this.store.append({ at: new Date(this.now()).toISOString(), ...entry });
  }
}
