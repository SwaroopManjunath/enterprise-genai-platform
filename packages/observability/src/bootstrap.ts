import { optionsFromEnv } from './config';
import { JsonLogger, setActiveLogger } from './logger';
import { initTelemetry } from './telemetry';

/**
 * One call in a service's `main.ts`: sets up tracing and metrics from the environment (nothing is
 * exported unless an endpoint or a metrics port is configured) and returns the logger to give Nest.
 * `shutdown` flushes what is buffered, so the last spans of a stopping process are not lost.
 */
export function startTelemetry(
  service: string,
  env: NodeJS.ProcessEnv = process.env,
): { logger: JsonLogger; shutdown: () => Promise<void> } {
  const telemetry = initTelemetry(optionsFromEnv(service, env));
  const logger = new JsonLogger({ service });
  setActiveLogger(logger);
  return { logger, shutdown: telemetry.shutdown };
}
