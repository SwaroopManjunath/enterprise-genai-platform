import { CATALOG, type MetricKey } from '../metrics';

/**
 * The names Prometheus sees. The OpenTelemetry exporter turns dots into underscores, adds `_total`
 * to counters and `_bucket`, `_sum` and `_count` to histograms. A test scrapes a real exporter and
 * checks these, so a change in how names are exposed fails a build instead of silencing an alert.
 */
export function promName(key: MetricKey): string {
  const base = CATALOG[key].name.replace(/\./g, '_');
  return CATALOG[key].kind === 'counter' ? `${base}_total` : base;
}

export function seriesOf(key: MetricKey): string[] {
  const name = promName(key);
  return CATALOG[key].kind === 'counter'
    ? [name]
    : [`${name}_bucket`, `${name}_sum`, `${name}_count`];
}

/** `metric{label="value",...}` with exact matches, or a regex when the value is `~a|b`. */
export function select(series: string, filters: Record<string, string>): string {
  const parts = Object.entries(filters).map(([label, value]) =>
    value.startsWith('~') ? `${label}=~"${value.slice(1)}"` : `${label}="${value}"`,
  );
  return parts.length > 0 ? `${series}{${parts.join(',')}}` : series;
}
