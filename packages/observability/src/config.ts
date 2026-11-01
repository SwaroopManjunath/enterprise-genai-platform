export type TraceExport = 'otlp' | 'memory' | 'off';
export type MetricExport = 'prometheus' | 'otlp' | 'memory' | 'off';

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  traces: TraceExport;
  metrics: MetricExport;
  /** Base URL of an OTLP collector (Azure Monitor / the OpenTelemetry collector). */
  otlpEndpoint?: string;
  /** Port for a Prometheus scrape endpoint. Keep it off the public ingress. */
  metricsPort?: number;
  /**
   * Secret that makes tenant and user pseudonyms. It must be the same in every service, or one
   * tenant looks like several. Without it each process makes its own, which is safe but uncorrelated.
   */
  pseudonymSalt?: string;
}

/**
 * Standard OpenTelemetry environment variables decide where telemetry goes, so a deployment can
 * change it without a code change. With none set nothing is exported (local development), and
 * logging still works.
 */
export function optionsFromEnv(
  serviceName: string,
  env: NodeJS.ProcessEnv = process.env,
): TelemetryOptions {
  const endpoint = env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  const port = env['METRICS_PORT'] ? Number(env['METRICS_PORT']) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('METRICS_PORT must be a port number');
  }
  const disabled = env['OTEL_SDK_DISABLED'] === 'true';

  return {
    serviceName: env['OTEL_SERVICE_NAME'] ?? serviceName,
    ...(env['SERVICE_VERSION'] && { serviceVersion: env['SERVICE_VERSION'] }),
    ...(env['DEPLOYMENT_ENVIRONMENT'] && { environment: env['DEPLOYMENT_ENVIRONMENT'] }),
    traces: disabled || !endpoint ? 'off' : 'otlp',
    metrics: disabled ? 'off' : port !== undefined ? 'prometheus' : endpoint ? 'otlp' : 'off',
    ...(endpoint && { otlpEndpoint: endpoint }),
    ...(port !== undefined && { metricsPort: port }),
    ...(env['TELEMETRY_PSEUDONYM_SALT'] && { pseudonymSalt: env['TELEMETRY_PSEUDONYM_SALT'] }),
  };
}
