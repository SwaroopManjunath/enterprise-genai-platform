import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { metrics as otelMetrics } from '@opentelemetry/api';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { parse } from 'yaml';
import { main } from '../cli/generate-ops';
import { CATALOG, Metrics, resetInstruments, type MetricKey } from '../metrics';
import { METRIC_LABELS } from '../sanitize';
import {
  ALL_ALERTS,
  SLOS,
  TIERS,
  burnAlert,
  burnRate,
  errorBudget,
  firstFiring,
  renderDashboard,
  renderRules,
  seriesOf,
  threshold,
  tiersOf,
} from './index';

const root = resolve(__dirname, '../../../..');
const KEYS = Object.keys(CATALOG) as MetricKey[];
const KNOWN_SERIES = new Map(KEYS.flatMap((k) => seriesOf(k).map((s) => [s, k] as const)));

const MINUTES_PER_DAY = 1440;
const constant = (ratio: number, minutes: number): number[] =>
  Array.from({ length: minutes }, () => ratio);
const slo = (id: string) => SLOS.find((s) => s.id === id)!;

describe('metric names in rules are the names Prometheus really exposes', () => {
  it('matches what a real exporter writes for every metric in the catalog', async () => {
    const exporter = new PrometheusExporter({ preventServerStart: true });
    const provider = new MeterProvider({ readers: [exporter] });
    otelMetrics.setGlobalMeterProvider(provider);
    resetInstruments();
    const recorder = new Metrics('probe');
    for (const key of KEYS) {
      const labels = Object.fromEntries(CATALOG[key].labels.map((l) => [l, 'x']));
      if (CATALOG[key].kind === 'counter') recorder.count(key, labels as never);
      else recorder.observe(key, labels as never, 1);
    }

    const { resourceMetrics } = await exporter.collect();
    const text = new PrometheusSerializer().serialize(resourceMetrics);
    await provider.shutdown();
    otelMetrics.disable();
    resetInstruments();

    const exposed = new Set(
      text
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split(/[{ ]/)[0]),
    );
    for (const series of KNOWN_SERIES.keys()) expect(exposed).toContain(series);
  });
});

describe('error budget arithmetic', () => {
  it('a 99.5% objective allows 0.5% bad events, and burn rate is relative to that', () => {
    const availability = slo('assistant-availability');

    expect(errorBudget(availability)).toBe(0.005);
    expect(burnRate(availability, 0.005)).toBeCloseTo(1);
    expect(burnRate(availability, 0.072)).toBeCloseTo(14.4);
    expect(threshold(availability, TIERS[0]!)).toBe(0.072);
  });

  it('the four tiers spend 2%, 5%, 10% and 10% of the 30-day budget before they fire', () => {
    const spent = TIERS.map((t) => {
      const hours = t.long.endsWith('d') ? Number.parseInt(t.long) * 24 : Number.parseInt(t.long);
      return Math.round(((t.burn * hours) / (30 * 24)) * 100);
    });

    expect(spent).toEqual([2, 5, 10, 10]);
  });

  it('every tier can actually fire: its threshold is a ratio at or below 1', () => {
    for (const s of SLOS) {
      for (const tier of tiersOf(s)) {
        expect(threshold(s, tier)).toBeLessThanOrEqual(1);
        expect(threshold(s, tier)).toBeGreaterThan(0);
      }
    }
  });

  it('quality signals open tickets and never page', () => {
    for (const id of ['answer-grounding', 'ingestion-success']) {
      expect(tiersOf(slo(id)).map((t) => t.severity)).not.toContain('page');
    }
  });
});

describe('how the alerts behave against simulated traffic', () => {
  const availability = slo('assistant-availability');

  it('pages within minutes of a total outage', () => {
    const fired = firstFiring(availability, constant(1, 120));

    expect(fired.fast).toBeGreaterThanOrEqual(5);
    expect(fired.fast).toBeLessThanOrEqual(10);
    expect(fired.slow).toBeDefined();
  });

  it('does not page for a two-minute blip', () => {
    expect(firstFiring(availability, [...constant(1, 2), ...constant(0, 600)])).toEqual({});
  });

  it('a steady 4% of errors (8x) pages on the slow tier, never on the fast one', () => {
    const fired = firstFiring(availability, constant(0.04, MINUTES_PER_DAY));

    expect(fired.fast).toBeUndefined();
    expect(fired.slow).toBeGreaterThan(250);
    expect(fired.slow).toBeLessThan(330);
  });

  it('a slow 1% leak (2x) never pages and raises only the ticket for the long run', () => {
    const fired = firstFiring(availability, constant(0.01, 4 * MINUTES_PER_DAY));

    expect(fired.fast).toBeUndefined();
    expect(fired.slow).toBeUndefined();
    expect(fired.steady).toBeUndefined();
    expect(fired.drip).toBeGreaterThan(35 * 60);
    expect(fired.drip).toBeLessThan(38 * 60);
  });

  it('is quiet when errors stay inside the budget', () => {
    expect(firstFiring(availability, constant(0.004, 4 * MINUTES_PER_DAY))).toEqual({});
  });

  it('a latency SLO of 95% tolerates 5% slow requests and complains about a sustained 20%', () => {
    const latency = slo('assistant-latency');

    expect(firstFiring(latency, constant(0.05, MINUTES_PER_DAY))).toEqual({});
    const fired = firstFiring(latency, constant(0.2, 2 * MINUTES_PER_DAY));
    expect(fired.fast).toBeUndefined();
    expect(fired.steady).toBeDefined();
  });
});

describe('the generated Prometheus rules', () => {
  const file = parse(renderRules()) as {
    groups: { name: string; rules: Record<string, unknown>[] }[];
  };
  const rules = file.groups.flatMap((g) => g.rules);
  const exprs = rules.map((r) => String(r['expr']));

  it('is valid YAML with a recording rule per SLO and window, and an alert per tier', () => {
    const recorded = rules.filter((r) => r['record']);
    expect(recorded).toHaveLength(SLOS.length * 8);
    expect(rules.filter((r) => r['alert'])).toHaveLength(ALL_ALERTS.length);
    expect(new Set(rules.map((r) => String(r['alert'] ?? ''))).size - 1).toBe(ALL_ALERTS.length);
  });

  it('only reads series that exist, with labels those series have', () => {
    // recorded series (`slo:...`) are the rules' own; everything else must be in the catalog
    const selector = /(?<![:\w])([a-z][a-z0-9_]*)\{([^}]*)\}/g;
    let checked = 0;
    for (const expr of exprs) {
      for (const [, name, body] of expr.matchAll(selector)) {
        const key = KNOWN_SERIES.get(name!);
        expect(key).toBeDefined();
        const allowed = new Set<string>(['service', 'le', ...CATALOG[key!].labels]);
        for (const [, label] of body!.matchAll(/([a-z_]+)(?:=~|=)"/g)) {
          expect(allowed).toContain(label);
          expect(METRIC_LABELS as readonly string[]).toContain(label === 'le' ? 'service' : label);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('treats "no bad events yet" as zero, not as missing data', () => {
    for (const expr of exprs.filter((e) => e.includes('/ sum') && e.startsWith('('))) {
      expect(expr).toContain('or vector(0)');
    }
  });

  it('gives every alert a severity, a runbook that exists, and a summary a person can act on', () => {
    for (const alert of ALL_ALERTS) {
      expect(['page', 'ticket']).toContain(alert.severity);
      expect(existsSync(resolve(root, alert.runbook))).toBe(true);
      expect(alert.summary.length).toBeGreaterThan(20);
    }
    expect(new Set(ALL_ALERTS.map((a) => a.alert)).size).toBe(ALL_ALERTS.length);
  });

  it('requires both windows to agree, so a blip or a stale problem does not alert', () => {
    const alert = burnAlert(slo('assistant-availability'), TIERS[0]!);

    expect(alert.expr).toContain('ratio_rate1h');
    expect(alert.expr).toContain('ratio_rate5m');
    expect(alert.expr).toContain(' and ');
  });

  it('watches every service for going silent', () => {
    expect(ALL_ALERTS.filter((a) => a.alert.endsWith('TelemetryMissing'))).toHaveLength(7);
  });
});

describe('the generated dashboard', () => {
  const dashboard = JSON.parse(renderDashboard()) as {
    panels: { id: number; targets: { expr: string }[] }[];
  };

  it('has unique panels and queries only series that exist', () => {
    expect(new Set(dashboard.panels.map((p) => p.id)).size).toBe(dashboard.panels.length);
    for (const panel of dashboard.panels) {
      for (const { expr } of panel.targets) {
        for (const [name] of expr.matchAll(/\b[a-z][a-z0-9_]*(?:_total|_bucket|_sum|_count)\b/g)) {
          expect(KNOWN_SERIES.has(name)).toBe(true);
        }
      }
    }
  });
});

describe('the committed files', () => {
  it('are exactly what the code generates now', () => {
    expect(main(['--check'], root)).toBe(0);
  });

  it('are not hand-edited: the committed rules equal the generated rules', () => {
    expect(readFileSync(resolve(root, 'ops/prometheus/rules.yaml'), 'utf8')).toBe(renderRules());
  });
});
