{{- define "genai.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}

{{- define "genai.labels" -}}
{{ include "genai.selectorLabels" . }}
app.kubernetes.io/part-of: genai-platform
app.kubernetes.io/version: {{ .root.Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | quote }}
{{- end -}}

{{- define "genai.image" -}}
{{- $registry := required "image.registry is required" .root.Values.image.registry -}}
{{- $tag := required "image.tag is required: there is no latest" .root.Values.image.tag -}}
{{- printf "%s/%s/%s:%s" $registry .root.Values.image.repositoryPrefix .name $tag -}}
{{- end -}}

{{/* The Key Vault secrets one service reads, as JSON: [{name, env}]. The gateway also reads each model key. */}}
{{- define "genai.secrets" -}}
{{- $list := list -}}
{{- range (.svc.secrets | default list) -}}
{{- $list = append $list (dict "name" .name "env" (.env | default (printf "SECRET_%s" (upper (replace "-" "_" .name))))) -}}
{{- end -}}
{{- if eq .name "llm-gateway" -}}
{{- range .root.Values.llmGateway.deployments -}}
{{- $list = append $list (dict "name" .apiKeySecret "env" (printf "SECRET_%s" (upper (replace "-" "_" .apiKeySecret)))) -}}
{{- end -}}
{{- end -}}
{{- toJson $list -}}
{{- end -}}

{{/* The enabled services that call this one, as JSON. */}}
{{- define "genai.callers" -}}
{{- $name := .name -}}
{{- $out := list -}}
{{- range $other, $s := .root.Values.services -}}
{{- if and $s.enabled (has $name ($s.calls | default list)) -}}
{{- $out = append $out $other -}}
{{- end -}}
{{- end -}}
{{- toJson $out -}}
{{- end -}}

{{- define "genai.port" -}}
{{- .svc.port | default .root.Values.defaults.port -}}
{{- end -}}

{{/* The pod: shared by Deployments and Rollouts so a canary runs exactly what a rollout would. */}}
{{- define "genai.podTemplate" -}}
{{- $root := .root -}}
{{- $name := .name -}}
{{- $svc := .svc -}}
{{- $secrets := include "genai.secrets" . | fromJsonArray -}}
metadata:
  labels:
    {{- include "genai.labels" . | nindent 4 }}
    azure.workload.identity/use: "true"
spec:
  serviceAccountName: {{ $name }}
  # The Kubernetes API token is not needed; the Azure token is projected by workload identity.
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          {{- include "genai.selectorLabels" . | nindent 10 }}
  containers:
    - name: {{ $name }}
      image: {{ include "genai.image" . | quote }}
      imagePullPolicy: {{ $root.Values.image.pullPolicy }}
      ports:
        - { name: http, containerPort: {{ include "genai.port" . }} }
        - { name: metrics, containerPort: {{ $root.Values.telemetry.metricsPort }} }
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: [ALL]
      resources:
        {{- toYaml ($svc.resources | default $root.Values.defaults.resources) | nindent 8 }}
      startupProbe:
        httpGet: { path: /health, port: http }
        periodSeconds: 2
        failureThreshold: 30
      readinessProbe:
        httpGet: { path: /health, port: http }
        periodSeconds: 5
        failureThreshold: 3
      livenessProbe:
        httpGet: { path: /health, port: http }
        periodSeconds: 10
        failureThreshold: 3
      env:
        - { name: PORT, value: {{ include "genai.port" . | quote }} }
        - { name: AUTH_ISSUER, value: {{ required "auth.issuer is required" $root.Values.auth.issuer | quote }} }
        - { name: AUTH_AUDIENCE, value: {{ required (printf "services.%s.audience is required" $name) $svc.audience | quote }} }
        - { name: AUTH_JWKS_URL, value: {{ required "auth.jwksUrl is required" $root.Values.auth.jwksUrl | quote }} }
        - { name: AUTH_TENANT_CLAIM, value: {{ $root.Values.auth.tenantClaim | quote }} }
        - { name: DEPLOYMENT_ENVIRONMENT, value: {{ $root.Values.environment | quote }} }
        - { name: SERVICE_VERSION, value: {{ $root.Values.image.tag | quote }} }
        - { name: METRICS_PORT, value: {{ $root.Values.telemetry.metricsPort | quote }} }
        {{- with $root.Values.telemetry.otlpEndpoint }}
        - { name: OTEL_EXPORTER_OTLP_ENDPOINT, value: {{ . | quote }} }
        {{- end }}
        - { name: GATEWAY_URL, value: "http://llm-gateway:{{ $root.Values.defaults.port }}" }
        - { name: PROMPTS_URL, value: "http://prompt-registry:{{ $root.Values.defaults.port }}" }
        - { name: RETRIEVAL_URL, value: "http://retrieval:{{ $root.Values.defaults.port }}" }
        - { name: MCP_GATEWAY_URL, value: "http://mcp-gateway:{{ $root.Values.defaults.port }}" }
        {{- if or (eq $name "assistant") (eq $name "agents") (eq $name "mcp-gateway") }}
        - { name: OBO_TOKEN_ENDPOINT, value: {{ required "auth.tokenEndpoint is required" $root.Values.auth.tokenEndpoint | quote }} }
        - { name: OBO_CLIENT_ID, value: {{ required (printf "services.%s.clientId is required" $name) $svc.clientId | quote }} }
        - { name: OBO_CLIENT_SECRET_NAME, value: "{{ $name }}-client-secret" }
        {{- end }}
        {{- if eq $name "ingestion" }}
        - { name: INDEX_SINK, value: retrieval }
        - { name: TOKEN_ENDPOINT, value: {{ required "auth.tokenEndpoint is required" $root.Values.auth.tokenEndpoint | quote }} }
        - { name: CLIENT_ID, value: {{ required "services.ingestion.clientId is required" $svc.clientId | quote }} }
        {{- end }}
        {{- if eq $name "llm-gateway" }}
        - { name: LLM_PROVIDER, value: {{ $root.Values.llmGateway.provider | quote }} }
        - { name: AZURE_OPENAI_DEPLOYMENTS, value: {{ $root.Values.llmGateway.deployments | toJson | quote }} }
        {{- if $root.Values.llmGateway.prices }}
        - { name: MODEL_PRICES, value: {{ $root.Values.llmGateway.prices | toJson | quote }} }
        {{- end }}
        {{- end }}
        {{- range $key, $value := ($svc.env | default dict) }}
        - { name: {{ $key }}, value: {{ $value | quote }} }
        {{- end }}
        {{- range $secrets }}
        - name: {{ .env }}
          valueFrom:
            secretKeyRef: { name: {{ $name }}-secrets, key: {{ .name }} }
        {{- end }}
      volumeMounts:
        - { name: tmp, mountPath: /tmp }
        {{- if $secrets }}
        - { name: secrets, mountPath: /mnt/secrets, readOnly: true }
        {{- end }}
  volumes:
    - { name: tmp, emptyDir: { sizeLimit: 64Mi } }
    {{- if $secrets }}
    - name: secrets
      csi:
        driver: secrets-store.csi.k8s.io
        readOnly: true
        volumeAttributes: { secretProviderClass: {{ $name }} }
    {{- end }}
{{- end -}}

{{/* A Prometheus query for an Argo Rollouts analysis metric. */}}
{{- define "genai.analysisProvider" -}}
prometheus:
  address: {{ .root.Values.rollouts.prometheusAddress }}
  query: {{ .query | quote }}
{{- end }}
