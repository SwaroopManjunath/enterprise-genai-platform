# One image recipe for all seven services: docker build --build-arg SERVICE=assistant -t genai/assistant .
# Three stages: build everything, install only what the one service needs at run time, and copy
# just that into a small image that runs as an unprivileged user.
ARG NODE_IMAGE=node:22-bookworm-slim

# ---- build: compile the libraries and the service (dev dependencies are needed here)
FROM ${NODE_IMAGE} AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY tests/e2e/package.json tests/e2e/package.json
COPY tests/evals/package.json tests/evals/package.json
COPY tests/delivery/package.json tests/delivery/package.json
RUN npm ci --ignore-scripts
ARG SERVICE
RUN if [ -z "$SERVICE" ] || [ ! -d "apps/$SERVICE" ]; then echo "set --build-arg SERVICE=<one of apps/*>" >&2; exit 1; fi
RUN npm run build -w @genai/shared -w @genai/auth -w @genai/guardrails -w @genai/observability \
 && npm run build -w "@genai/$SERVICE"

# ---- deps: production dependencies of this service only (and the workspace libraries it uses)
FROM ${NODE_IMAGE} AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY tests/e2e/package.json tests/e2e/package.json
COPY tests/evals/package.json tests/evals/package.json
COPY tests/delivery/package.json tests/delivery/package.json
ARG SERVICE
RUN npm ci --ignore-scripts --omit=dev --workspace "@genai/$SERVICE" \
 && npm cache clean --force

# ---- run
FROM ${NODE_IMAGE} AS run
ARG SERVICE
ENV NODE_ENV=production \
    SERVICE=${SERVICE} \
    PORT=3000
# npm and corepack are build tools: the service never runs them, and their bundled modules are the
# image's most frequent source of vulnerability reports. Removing them also removes a way to install more.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /repo
COPY --from=deps --chown=root:root /repo/node_modules ./node_modules
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/packages/auth/package.json ./packages/auth/package.json
COPY --from=build /repo/packages/auth/dist ./packages/auth/dist
COPY --from=build /repo/packages/guardrails/package.json ./packages/guardrails/package.json
COPY --from=build /repo/packages/guardrails/dist ./packages/guardrails/dist
COPY --from=build /repo/packages/observability/package.json ./packages/observability/package.json
COPY --from=build /repo/packages/observability/dist ./packages/observability/dist
COPY --from=build /repo/apps/${SERVICE}/package.json ./apps/${SERVICE}/package.json
COPY --from=build /repo/apps/${SERVICE}/dist ./apps/${SERVICE}/dist
WORKDIR /repo/apps/${SERVICE}
# Nothing the service runs is writable by it, and it is not root.
USER node
EXPOSE 3000
# The services already expose /health; this uses the Node that is in the image, so no curl is needed.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
