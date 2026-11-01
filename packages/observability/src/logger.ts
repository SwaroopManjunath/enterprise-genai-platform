import type { LoggerService } from '@nestjs/common';
import { currentTrace } from './tracing';

const LEVELS = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'] as const;
type Level = (typeof LEVELS)[number];

/** Text that looks like a credential is replaced, whatever it was meant to say. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*/g, '[redacted-jwt]')
    .replace(/\b(sk|pk|ghp|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, '[redacted-key]')
    .replace(
      /(password|secret|api[-_]?key|token)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi,
      '$1$2[redacted]',
    );
}

export interface JsonLoggerOptions {
  service: string;
  /** Where lines go. Defaults to stdout, one JSON object per line. */
  write?: (line: string) => void;
  minLevel?: Level;
  now?: () => Date;
}

/**
 * Structured logs: one JSON object per line, carrying the trace and span the line was written in,
 * so a log line leads to its trace and back. Messages are scrubbed of anything that looks like a
 * credential. Logs are for what the service did, not for what it was asked or answered: callers
 * log identifiers and outcomes, never text.
 */
export class JsonLogger implements LoggerService {
  private readonly write: (line: string) => void;
  private readonly min: number;
  private readonly now: () => Date;

  constructor(private readonly options: JsonLoggerOptions) {
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.min = LEVELS.indexOf(options.minLevel ?? 'log');
    this.now = options.now ?? (() => new Date());
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.emit('log', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.emit('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.emit('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.emit('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.emit('verbose', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.emit('fatal', message, rest);
  }

  /** A named event with a few identifier-like fields, for things worth counting in a log search. */
  event(name: string, fields: Record<string, string | number | boolean | undefined> = {}): void {
    this.emit('log', name, [], fields);
  }

  private emit(
    level: Level,
    message: unknown,
    rest: unknown[],
    fields: Record<string, unknown> = {},
  ): void {
    if (LEVELS.indexOf(level) < this.min) return;
    // Nest passes the context (the class name) last, and for errors a stack before it.
    const context = typeof rest.at(-1) === 'string' ? (rest.at(-1) as string) : undefined;
    const text = message instanceof Error ? `${message.name}: ${message.message}` : String(message);

    const line = {
      ts: this.now().toISOString(),
      level: level === 'log' ? 'info' : level,
      service: this.options.service,
      ...(context && { context }),
      message: scrubSecrets(text).slice(0, 2000),
      ...currentTrace(),
      ...Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [
          k,
          typeof v === 'string' ? scrubSecrets(v).slice(0, 200) : v,
        ]),
      ),
    };
    this.write(JSON.stringify(line));
  }
}

let active: JsonLogger | undefined;

/** The logger the process started with, so a module can write access logs without being handed it. */
export const setActiveLogger = (logger: JsonLogger | undefined): void => {
  active = logger;
};
export const getActiveLogger = (): JsonLogger | undefined => active;
