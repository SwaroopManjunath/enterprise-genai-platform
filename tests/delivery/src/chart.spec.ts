import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SLOS, errorBudget } from '@genai/observability';
import { parse } from 'yaml';
import { ROOT, helmAvailable, named, ofKind, render, renderError, type Manifest } from './helm';

const enabled = helmAvailable();
const suite = enabled ? describe : describe.skip;

const SERVICES = [
  'agents',
  'assistant',
  'ingestion',
  'llm-gateway',
  'mcp-gateway',
  'prompt-registry',
  'retrieval',
];
const CALLS: Record<string, string[]> = {
  assistant: ['retrieval', 'prompt-registry', 'llm-gateway'],
  agents: ['llm-gateway', 'retrieval', 'mcp-gateway'],
  ingestion: ['retrieval'],
};

const terraformList = (name: string): string[] => {
  const text = readFileSync(resolve(ROOT, 'infra/terraform/main.tf'), 'utf8');
  const block = new RegExp(`${name}\\s*=\\s*toset\\(\\[([^\\]]*)\\]\\)`).exec(text)?.[1] ?? '';
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string).sort();
};

const workloads = (docs: Manifest[]): Manifest[] => [
  ...ofKind(docs, 'Deployment'),
  ...ofKind(docs, 'Rollout'),
];
const podOf = (w: Manifest) => w.spec.template.spec;
const containerOf = (w: Manifest) => podOf(w).containers[0];
const envOf = (w: Manifest): Record<string, { value?: string; valueFrom?: unknown }> =>
  Object.fromEntries(containerOf(w).env.map((e: { name: string }) => [e.name, e]));

suite('the Helm chart', () => {
  const docs = enabled ? render() : [];

  describe('refuses to render without what it cannot guess', () => {
    it.each([
      ['an image tag', 'image.tag=', /image.tag is required/],
      ['a registry', 'image.registry=', /image.registry is required/],
      ['an issuer', 'auth.issuer=', /auth.issuer is required/],
      ['signing keys', 'auth.jwksUrl=', /auth.jwksUrl is required/],
      ['a token endpoint', 'auth.tokenEndpoint=', /auth.tokenEndpoint is required/],
      ['a vault', 'azure.keyVaultName=', /azure.keyVaultName is required/],
      [
        'a client id for the assistant',
        'services.assistant.clientId=',
        /services.assistant.clientId is required/,
      ],
      [
        'an identity for the retrieval service',
        'serviceIdentities.retrieval=',
        /serviceIdentities.retrieval is required/,
      ],
    ])('%s', (_what, set, message) => {
      expect(renderError([set])).toMatch(message);
    });

    it('has no default image tag: there is no latest to deploy by accident', () => {
      const defaults = parse(
        readFileSync(resolve(ROOT, 'deploy/helm/genai-platform/values.yaml'), 'utf8'),
      );
      expect(defaults.image.tag).toBe('');
    });
  });

  it('runs all seven services, each with its own service account, and nothing else', () => {
    expect(
      workloads(docs)
        .map((w) => w.metadata.name)
        .sort(),
    ).toEqual(SERVICES);
    expect(
      ofKind(docs, 'ServiceAccount')
        .map((s) => s.metadata.name)
        .sort(),
    ).toEqual(SERVICES);
  });

  describe('every pod is locked down', () => {
    it.each(SERVICES)('%s', (service) => {
      const w = workloads(docs).find((d) => d.metadata.name === service) as Manifest;
      const pod = podOf(w);
      const c = containerOf(w);

      expect(pod.securityContext).toMatchObject({
        runAsNonRoot: true,
        runAsUser: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      });
      expect(pod.automountServiceAccountToken).toBe(false);
      expect(pod.serviceAccountName).toBe(service);
      expect(c.securityContext).toEqual({
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ['ALL'] },
      });
      expect(c.resources.requests).toMatchObject({
        cpu: expect.any(String),
        memory: expect.any(String),
      });
      expect(c.resources.limits.memory).toEqual(expect.any(String));
      expect(c.resources.limits.cpu).toBeUndefined();
      for (const probe of ['startupProbe', 'readinessProbe', 'livenessProbe']) {
        expect(c[probe].httpGet.path).toBe('/health');
      }
      expect(c.image).toBe(`registry.example.com/genai/${service}:1.2.3`);
      expect(c.image).not.toMatch(/:latest$/);
      expect(w.spec.template.metadata.labels['azure.workload.identity/use']).toBe('true');
    });
  });

  describe('the network is closed unless a call is declared', () => {
    const policies = (): Record<string, Manifest> =>
      Object.fromEntries(ofKind(docs, 'NetworkPolicy').map((p) => [p.metadata.name, p]));
    const callersOf = (service: string): string[] =>
      (
        policies()[service]?.spec.ingress as {
          from: { podSelector?: { matchLabels: Record<string, string> } }[];
        }[]
      )
        .flatMap((r) => r.from)
        .flatMap((f) =>
          f.podSelector ? [f.podSelector.matchLabels['app.kubernetes.io/name'] as string] : [],
        )
        .sort();

    it('has a policy for every service that governs both directions', () => {
      expect(Object.keys(policies()).sort()).toEqual(SERVICES);
      for (const p of Object.values(policies()))
        expect(p.spec.policyTypes).toEqual(['Ingress', 'Egress']);
    });

    it('lets a service be called by exactly the services that call it', () => {
      const expected: Record<string, string[]> = {
        retrieval: ['agents', 'assistant', 'ingestion'],
        'llm-gateway': ['agents', 'assistant'],
        'prompt-registry': ['assistant'],
        'mcp-gateway': ['agents'],
        assistant: [],
        agents: [],
        ingestion: [],
      };
      for (const [service, callers] of Object.entries(expected))
        expect([service, callersOf(service)]).toEqual([service, callers]);
    });

    it('lets a service call exactly the services it is declared to', () => {
      for (const service of SERVICES) {
        const egress = policies()[service]?.spec.egress as {
          to: { podSelector?: { matchLabels: Record<string, string> } }[];
        }[];
        const targets = egress
          .flatMap((r) => r.to)
          .flatMap((t) =>
            t.podSelector ? [t.podSelector.matchLabels['app.kubernetes.io/name'] as string] : [],
          )
          .sort();
        expect([service, targets]).toEqual([service, [...(CALLS[service] ?? [])].sort()]);
      }
    });

    it('only lets the ingress controller reach the services that are public', () => {
      const fromController = (service: string) =>
        (
          policies()[service]?.spec.ingress as {
            from: { namespaceSelector?: { matchLabels: Record<string, string> } }[];
          }[]
        )
          .flatMap((r) => r.from)
          .some(
            (f) =>
              f.namespaceSelector?.matchLabels['kubernetes.io/metadata.name'] === 'ingress-nginx',
          );
      for (const service of SERVICES)
        expect([service, fromController(service)]).toEqual([
          service,
          ['agents', 'assistant', 'ingestion', 'mcp-gateway'].includes(service),
        ]);
      expect(
        ofKind(docs, 'Ingress')
          .map((i) => i.metadata.name)
          .sort(),
      ).toEqual(['agents', 'assistant', 'ingestion', 'mcp-gateway']);
    });

    it('never lets a service reach private address space, whatever it calls on the internet', () => {
      for (const p of Object.values(policies())) {
        const open = (p.spec.egress as { to: { ipBlock?: { except: string[] } }[] }[])
          .flatMap((r) => r.to)
          .find((t) => t.ipBlock);
        expect(open?.ipBlock?.except).toEqual(
          expect.arrayContaining([
            '10.0.0.0/8',
            '172.16.0.0/12',
            '192.168.0.0/16',
            '169.254.0.0/16',
          ]),
        );
      }
    });
  });

  describe('secrets', () => {
    it('are mounted only into the services that read them, with that service’s own identity', () => {
      const classes = ofKind(docs, 'SecretProviderClass');
      expect(classes.map((c) => c.metadata.name).sort()).toEqual([
        'agents',
        'assistant',
        'ingestion',
        'llm-gateway',
        'mcp-gateway',
      ]);
      for (const c of classes) {
        const identity = ofKind(docs, 'ServiceAccount').find(
          (s) => s.metadata.name === c.metadata.name,
        )?.metadata.annotations?.['azure.workload.identity/client-id'];
        expect(c.spec.parameters.clientID).toBe(identity);
      }
    });

    it('reach the process as environment variables, by name, from a synced secret', () => {
      const gateway = envOf(
        workloads(docs).find((w) => w.metadata.name === 'llm-gateway') as Manifest,
      );
      expect(gateway['SECRET_AOAI_PRIMARY_KEY']?.valueFrom).toEqual({
        secretKeyRef: { name: 'llm-gateway-secrets', key: 'aoai-primary-key' },
      });
      expect(gateway['SECRET_AOAI_SECONDARY_KEY']).toBeDefined();
      expect(gateway['TELEMETRY_PSEUDONYM_SALT']).toBeDefined();
    });

    it('never appear as a literal value in any manifest', () => {
      const text = JSON.stringify(docs);
      expect(text).not.toMatch(/dev-.*-secret/);
      for (const w of workloads(docs)) {
        for (const e of containerOf(w).env as { name: string; value?: string }[]) {
          if (/^SECRET_/.test(e.name)) expect(e.value).toBeUndefined();
        }
      }
    });

    it('are not given to services that read none', () => {
      for (const service of ['retrieval', 'prompt-registry']) {
        const w = workloads(docs).find((d) => d.metadata.name === service) as Manifest;
        expect(Object.keys(envOf(w)).filter((k) => /^SECRET_/.test(k))).toEqual([]);
        expect(podOf(w).volumes.map((v: { name: string }) => v.name)).toEqual(['tmp']);
      }
    });
  });

  describe('agrees with the Terraform', () => {
    it('runs the services the Terraform creates an identity for', () => {
      expect(terraformList('services')).toEqual(SERVICES);
    });

    it('mounts secrets for exactly the services the Terraform lets read the vault', () => {
      const withSecrets = ofKind(docs, 'SecretProviderClass')
        .map((c) => c.metadata.name)
        .sort();
      expect(terraformList('secret_readers')).toEqual(withSecrets);
    });

    it('uses service account names that match the federated credential subjects', () => {
      const text = readFileSync(resolve(ROOT, 'infra/terraform/identity.tf'), 'utf8');
      expect(text).toContain(
        'subject             = "system:serviceaccount:${var.namespace}:${each.key}"',
      );
    });
  });

  describe('resources follow what the load test measured', () => {
    const measured = JSON.parse(
      readFileSync(resolve(ROOT, 'docs/proof/load-capacity-mock.json'), 'utf8'),
    ) as {
      peaks: Record<string, { cpu: number; mem: number }>;
    };
    const peak = (service: string, field: 'cpu' | 'mem'): number =>
      Math.max(
        ...Object.entries(measured.peaks)
          .filter(([k]) => k.endsWith(`|${service}`))
          .map(([, v]) => v[field]),
      );
    const mebi = (text: string): number => Number.parseInt(text, 10);

    it.each(['assistant', 'llm-gateway', 'retrieval', 'prompt-registry'])(
      '%s has a memory limit with headroom over the most it used under load',
      (service) => {
        const c = containerOf(workloads(docs).find((w) => w.metadata.name === service) as Manifest);
        expect(mebi(c.resources.limits.memory)).toBeGreaterThanOrEqual(peak(service, 'mem') * 1.5);
        expect(mebi(c.resources.requests.memory)).toBeLessThanOrEqual(
          mebi(c.resources.limits.memory),
        );
      },
    );

    it('asks for enough CPU that the autoscaler adds a pod before the measured knee', () => {
      // Throughput stopped growing near 380 requests a second, with the assistant at about 1.2 cores.
      const assistant = containerOf(
        workloads(docs).find((w) => w.metadata.name === 'assistant') as Manifest,
      );
      const requestCores = Number.parseInt(assistant.resources.requests.cpu, 10) / 1000;
      const scaleOutAtCores = requestCores * 0.7;
      const coresPerRequest = peak('assistant', 'cpu') / 100 / 600; // generous: peak CPU over the offered rate at 600
      expect(scaleOutAtCores / coresPerRequest).toBeLessThan(380);
    });
  });

  describe('canary releases', () => {
    const withRollouts = enabled ? docs : [];

    it('turn the services marked canary into Rollouts, and leave the rest as Deployments', () => {
      expect(
        ofKind(withRollouts, 'Rollout')
          .map((r) => r.metadata.name)
          .sort(),
      ).toEqual(['assistant', 'llm-gateway']);
      expect(
        ofKind(withRollouts, 'Deployment')
          .map((r) => r.metadata.name)
          .sort(),
      ).toEqual(['agents', 'ingestion', 'mcp-gateway', 'prompt-registry', 'retrieval']);
    });

    it('are off by default: every service is a plain Deployment without Argo Rollouts installed', () => {
      const plain = render([
        'rollouts.enabled=false',
        'monitoring.serviceMonitor.enabled=false',
        'monitoring.prometheusRule.enabled=false',
      ]);
      expect(ofKind(plain, 'Rollout')).toEqual([]);
      expect(ofKind(plain, 'AnalysisTemplate')).toEqual([]);
      expect(ofKind(plain, 'Deployment')).toHaveLength(7);
    });

    it('judge the canary on its own pods, and fail it when it has had no traffic', () => {
      const rollout = named(withRollouts, 'Rollout', 'assistant');
      expect(rollout.spec.strategy.canary.analysis.args).toContainEqual({
        name: 'pod-hash',
        valueFrom: { podTemplateHashValue: 'Latest' },
      });
      const traffic = named(withRollouts, 'AnalysisTemplate', 'canary-has-traffic').spec.metrics[0];
      expect(traffic.successCondition).toBe('result[0] >= 20');
      const errors = named(withRollouts, 'AnalysisTemplate', 'canary-error-ratio').spec.metrics[0];
      expect(errors.provider.prometheus.query).toContain(
        'pod=~"{{args.service}}-{{args.pod-hash}}-.*"',
      );
      expect(errors.provider.prometheus.query).toContain('route!="/health"');
      expect(errors.failureLimit).toBe(0);
    });

    it('use thresholds derived from the SLOs, so loosening one means changing the other', () => {
      const budget = (id: string) => errorBudget(SLOS.find((s) => s.id === id)!);
      const defaults = parse(
        readFileSync(resolve(ROOT, 'deploy/helm/genai-platform/values.yaml'), 'utf8'),
      ).rollouts.analysis;

      expect(defaults.maxErrorRatio).toBeCloseTo(6 * budget('assistant-availability'), 6);
      expect(defaults.maxSlowRatio).toBeCloseTo(3 * budget('assistant-latency'), 6);
    });

    it('query only series the platform really exposes', () => {
      for (const t of ofKind(withRollouts, 'AnalysisTemplate')) {
        const query = t.spec.metrics[0].provider.prometheus.query as string;
        for (const [, name] of query.matchAll(/\b(http_server_[a-z_]+)\{/g)) {
          expect([
            'http_server_requests_total',
            'http_server_duration_count',
            'http_server_duration_bucket',
          ]).toContain(name);
        }
      }
    });
  });

  describe('monitoring', () => {
    it('keeps the platform’s own service label when scraping, or every SLO rule reads nothing', () => {
      const monitor = named(docs, 'ServiceMonitor', 'genai-platform');
      expect(monitor.spec.endpoints[0].honorLabels).toBe(true);
      expect(monitor.spec.endpoints[0].port).toBe('metrics');
    });

    it('ships exactly the alert rules the SLO code generates', () => {
      const shipped = named(docs, 'PrometheusRule', 'genai-platform-slo').spec.groups;
      const generated = parse(
        readFileSync(resolve(ROOT, 'ops/prometheus/rules.yaml'), 'utf8'),
      ).groups;
      expect(shipped).toEqual(generated);
    });

    it('exposes the metrics port on every service, and nothing from the API port is scraped', () => {
      for (const s of ofKind(docs, 'Service').filter((x) => !x.metadata.name.endsWith('-canary'))) {
        expect(s.metadata.labels?.['genai.dev/metrics']).toBe('true');
        expect(s.spec.ports.map((p: { name: string }) => p.name)).toEqual(['http', 'metrics']);
      }
    });
  });

  it('keeps answers streaming through the ingress: the proxy does not buffer the assistant', () => {
    const annotations = named(docs, 'Ingress', 'assistant').metadata.annotations;
    expect(annotations?.['nginx.ingress.kubernetes.io/proxy-buffering']).toBe('off');
    expect(annotations?.['nginx.ingress.kubernetes.io/ssl-redirect']).toBe('true');
  });

  it('scales every service and protects it during node upgrades', () => {
    expect(ofKind(docs, 'HorizontalPodAutoscaler')).toHaveLength(7);
    expect(ofKind(docs, 'PodDisruptionBudget')).toHaveLength(7);
    const hpa = named(docs, 'HorizontalPodAutoscaler', 'assistant');
    expect(hpa.spec.scaleTargetRef.kind).toBe('Rollout');
    expect(hpa.spec.minReplicas).toBeGreaterThanOrEqual(2);
    for (const w of workloads(docs)) expect(w.spec.replicas).toBeUndefined();
  });
});
