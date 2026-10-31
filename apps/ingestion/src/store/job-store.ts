import type { JobRecord } from '../domain/job';

export interface JobStore {
  create(record: JobRecord): Promise<void>;
  /** Tenant-scoped: a job id from another tenant is simply not found. */
  get(tenantId: string, jobId: string): Promise<JobRecord | undefined>;
  update(jobId: string, patch: Partial<Omit<JobRecord, 'jobId' | 'tenantId'>>): Promise<void>;
}

export const JOB_STORE = Symbol('JOB_STORE');

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  create(record: JobRecord): Promise<void> {
    this.jobs.set(record.jobId, { ...record });
    return Promise.resolve();
  }

  get(tenantId: string, jobId: string): Promise<JobRecord | undefined> {
    const job = this.jobs.get(jobId);
    return Promise.resolve(job && job.tenantId === tenantId ? { ...job } : undefined);
  }

  update(jobId: string, patch: Partial<Omit<JobRecord, 'jobId' | 'tenantId'>>): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job) Object.assign(job, patch, { updatedAt: this.now().toISOString() });
    return Promise.resolve();
  }
}
