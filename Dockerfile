# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine AS runtime
ARG OTEL=false
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=3000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json README.md LICENSE CHANGELOG.md ./
# Build with --build-arg OTEL=true to include the optional tracing exporter.
RUN if [ "$OTEL" = "true" ]; then \
      npm install --omit=dev --no-save --ignore-scripts --no-audit --no-fund \
        @opentelemetry/sdk-trace-base@^2 @opentelemetry/resources@^2 \
        @opentelemetry/exporter-trace-otlp-http @opentelemetry/context-async-hooks@^2 \
      && npm cache clean --force; \
    fi \
    && mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_HTTP_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "dist/index.js"]
