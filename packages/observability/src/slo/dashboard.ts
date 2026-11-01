import { promName, select } from './names';
import { recordName } from './rules';
import { SLOS, errorBudget } from './slos';

interface Panel {
  type: 'stat' | 'timeseries';
  title: string;
  description?: string;
  unit?: string;
  targets: { expr: string; legend: string }[];
  /** Stat panels: colour by thresholds, `min` and `max` bound the gauge. */
  thresholds?: { color: string; value: number | null }[];
}

const DS = { type: 'prometheus', uid: '${datasource}' };

const sloPanels = (): Panel[] =>
  SLOS.flatMap((slo): Panel[] => [
    {
      type: 'stat',
      title: `${slo.title}: budget left (30d)`,
      description: `${slo.meaning} Objective ${(slo.objective * 100).toFixed(1)}%. 100% means none of the budget is spent; below 0 it is overspent.`,
      unit: 'percentunit',
      targets: [
        {
          expr: `1 - (${recordName('30d')}{slo="${slo.id}"} / ${errorBudget(slo)})`,
          legend: slo.id,
        },
      ],
      thresholds: [
        { color: 'red', value: null },
        { color: 'orange', value: 0.25 },
        { color: 'green', value: 0.5 },
      ],
    },
    {
      type: 'timeseries',
      title: `${slo.title}: burn rate`,
      description:
        'Above 1 the budget is used faster than it is granted. The alerts fire at 14.4, 6, 3 and 1, over two windows each.',
      targets: ['1h', '6h', '1d'].map((w) => ({
        expr: `${recordName(w)}{slo="${slo.id}"} / ${errorBudget(slo)}`,
        legend: `${w} window`,
      })),
    },
  ]);

const by = (label: string, expr: string): string => `sum by (${label}) (${expr})`;

const platformPanels = (): Panel[] => [
  {
    type: 'timeseries',
    title: 'Requests per second, by service',
    unit: 'reqps',
    targets: [
      { expr: by('service', `rate(${promName('httpRequests')}[5m])`), legend: '{{service}}' },
    ],
  },
  {
    type: 'timeseries',
    title: 'Server errors per second, by service',
    unit: 'reqps',
    targets: [
      {
        expr: by(
          'service',
          `rate(${select(promName('httpRequests'), { status_class: '5xx' })}[5m])`,
        ),
        legend: '{{service}}',
      },
    ],
  },
  {
    type: 'timeseries',
    title: 'Request latency p95, by service',
    unit: 'ms',
    targets: [
      {
        expr: `histogram_quantile(0.95, sum by (service, le) (rate(${promName('httpDuration')}_bucket[5m])))`,
        legend: '{{service}}',
      },
    ],
  },
  {
    type: 'timeseries',
    title: 'Answers by outcome',
    unit: 'ops',
    targets: [{ expr: by('outcome', `rate(${promName('answers')}[5m])`), legend: '{{outcome}}' }],
  },
  {
    type: 'timeseries',
    title: 'First token p95',
    unit: 'ms',
    targets: [
      {
        expr: `histogram_quantile(0.95, sum by (le) (rate(${promName('firstToken')}_bucket[5m])))`,
        legend: 'p95',
      },
    ],
  },
  {
    type: 'timeseries',
    title: 'Model calls by deployment and outcome',
    unit: 'ops',
    targets: [
      {
        expr: by('provider, outcome', `rate(${promName('llmCalls')}[5m])`),
        legend: '{{provider}} {{outcome}}',
      },
    ],
  },
  {
    type: 'timeseries',
    title: 'Tokens per second, by direction',
    targets: [
      { expr: by('direction', `rate(${promName('llmTokens')}[5m])`), legend: '{{direction}}' },
    ],
  },
  {
    type: 'timeseries',
    title: 'Spend per hour (USD), by deployment',
    unit: 'currencyUSD',
    description:
      'Micro-dollars from the cost counter, converted. Per-tenant spend is a pseudonym label, kept for the usage API rather than this board.',
    targets: [
      {
        expr: `${by('provider', `increase(${promName('llmCost')}[1h])`)} / 1000000`,
        legend: '{{provider}}',
      },
    ],
  },
  {
    type: 'timeseries',
    title: 'Guardrail decisions',
    unit: 'ops',
    targets: [
      {
        expr: by('kind, action', `rate(${promName('guardrailEvents')}[5m])`),
        legend: '{{kind}} {{action}}',
      },
    ],
  },
  {
    type: 'timeseries',
    title: 'Results returned by retrieval (mean)',
    targets: [
      {
        expr: `sum(rate(${promName('retrievalResults')}_sum[5m])) / sum(rate(${promName('retrievalResults')}_count[5m]))`,
        legend: 'results per search',
      },
    ],
  },
  {
    type: 'timeseries',
    title: 'Ingestion jobs by result',
    unit: 'ops',
    targets: [
      { expr: by('result', `rate(${promName('ingestionJobs')}[5m])`), legend: '{{result}}' },
    ],
  },
  {
    type: 'timeseries',
    title: 'Agent runs and tool calls',
    unit: 'ops',
    targets: [
      { expr: by('status', `rate(${promName('agentRuns')}[5m])`), legend: 'run {{status}}' },
      {
        expr: by('outcome', `rate(${promName('agentToolCalls')}[5m])`),
        legend: 'tool {{outcome}}',
      },
    ],
  },
  {
    type: 'timeseries',
    title: 'MCP gateway, by outcome',
    unit: 'ops',
    targets: [{ expr: by('outcome', `rate(${promName('mcpCalls')}[5m])`), legend: '{{outcome}}' }],
  },
];

/** The Grafana dashboard, written to `ops/grafana/genai-platform.json`. Do not edit it by hand. */
export function renderDashboard(): string {
  const panels = [...sloPanels(), ...platformPanels()].map((p, i) => ({
    id: i + 1,
    type: p.type,
    title: p.title,
    ...(p.description && { description: p.description }),
    datasource: DS,
    gridPos: { h: 7, w: p.type === 'stat' ? 6 : 12, x: (i % 2) * 12, y: Math.floor(i / 2) * 7 },
    fieldConfig: {
      defaults: {
        ...(p.unit && { unit: p.unit }),
        ...(p.thresholds && { thresholds: { mode: 'absolute', steps: p.thresholds } }),
      },
      overrides: [],
    },
    targets: p.targets.map((t, n) => ({
      refId: String.fromCharCode(65 + n),
      datasource: DS,
      expr: t.expr,
      legendFormat: t.legend,
    })),
  }));
  return `${JSON.stringify(
    {
      title: 'GenAI platform: SLOs and health',
      uid: 'genai-platform',
      schemaVersion: 39,
      version: 1,
      tags: ['genai', 'generated'],
      time: { from: 'now-6h', to: 'now' },
      refresh: '30s',
      templating: {
        list: [
          { name: 'datasource', type: 'datasource', query: 'prometheus', label: 'Data source' },
        ],
      },
      panels,
    },
    null,
    2,
  )}\n`;
}
