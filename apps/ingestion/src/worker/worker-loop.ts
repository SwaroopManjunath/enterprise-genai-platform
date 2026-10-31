import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { IngestionWorker } from './ingestion-worker';

/** Polls the queue on an interval and drains whatever is visible. Disabled when interval is 0. */
export class WorkerLoop implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerLoop.name);
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(
    private readonly worker: IngestionWorker,
    private readonly intervalMs: number,
  ) {}

  onModuleInit(): void {
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Skips a tick if the previous one is still running, so work never piles up concurrently. */
  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.worker.drain();
    } catch (error) {
      this.logger.error(`worker loop failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.busy = false;
    }
  }
}
