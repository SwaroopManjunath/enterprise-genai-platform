import type { AuditEntry } from '../domain/types';
import type { AuditStore } from '../store/stores';

/** Stamps and appends. The only way anything in the gateway writes to the audit store. */
export class AuditLog {
  constructor(
    private readonly store: AuditStore,
    private readonly now: () => number,
  ) {}

  record(entry: Omit<AuditEntry, 'id' | 'at'>): Promise<void> {
    return this.store.append({ at: new Date(this.now()).toISOString(), ...entry });
  }
}
