# Deployment

## Docker Compose

```bash
cp .env.example .env
# Fill in store credentials, then add a token:
echo "MCP_HTTP_AUTH_TOKENS=$(openssl rand -base64 32)" >> .env
docker compose up -d --build
curl http://127.0.0.1:3000/healthz
```

The compose file:

- runs the server over streamable HTTP on port 3000, published on `127.0.0.1` only
- writes the audit log to the `audit` volume at `/data/audit.jsonl`
- uses a read-only root file system, drops all capabilities, and blocks privilege escalation

To serve several stores, mount a stores file and set `WOOCOMMERCE_STORES_FILE` (the lines are commented in `docker-compose.yml`). Keep secrets in `.env` and reference them with `consumerSecretEnv`.

## Docker image

Released images are on the GitHub Container Registry for `linux/amd64` and `linux/arm64`:

```bash
docker run -d --name woocommerce-mcp -p 127.0.0.1:3000:3000 \
  --env-file .env \
  ghcr.io/sadrmanesh/woocommerce-mcp:0.4.0
```

Use `0.4.0` to pin a release, `0.4` to follow patch releases, or `latest`. To run the published image with Docker Compose, remove the `build:` block and set `image: ghcr.io/sadrmanesh/woocommerce-mcp:0.4.0`.

Or build it yourself from a checkout:

```bash
docker build -t woocommerce-mcp .
docker build -t woocommerce-mcp:otel --build-arg OTEL=true .   # with the tracing exporter
```

The image is based on `node:22-alpine`, runs as the unprivileged `node` user, exposes port 3000, and defines a health check against `/healthz`. It defaults to `MCP_TRANSPORT=http` and `MCP_HTTP_HOST=0.0.0.0`, so it will not start without authentication configured.

Run it over stdio instead, for a host that launches containers:

```json
{
  "mcpServers": {
    "woocommerce": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT=stdio", "-e", "WOOCOMMERCE_URL", "-e", "WOOCOMMERCE_CONSUMER_KEY", "-e", "WOOCOMMERCE_CONSUMER_SECRET", "ghcr.io/sadrmanesh/woocommerce-mcp:0.4.0"],
      "env": {
        "WOOCOMMERCE_URL": "https://store.example.com",
        "WOOCOMMERCE_CONSUMER_KEY": "ck_...",
        "WOOCOMMERCE_CONSUMER_SECRET": "cs_..."
      }
    }
  }
}
```

## Reverse proxy

Expose the server only through TLS. A minimal Caddy example:

```
mcp.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Then set:

```bash
MCP_HTTP_ALLOWED_HOSTS=mcp.example.com
MCP_OAUTH_RESOURCE=https://mcp.example.com/mcp   # when using OAuth introspection
```

Streamable HTTP responses can be server-sent event streams, so disable response buffering in proxies that buffer by default.

## Endpoints

| Path | Purpose |
| --- | --- |
| `MCP_HTTP_PATH` (default `/mcp`) | MCP streamable HTTP |
| `/healthz` | Liveness check, returns `{"status":"ok","version":"..."}` |
| `/.well-known/oauth-protected-resource<path>` | RFC 9728 metadata, when authentication is on |

## Upgrading from 0.1.x

Existing single-store variables keep working. Two behaviours changed:

- Write tools now ask for confirmation by default. Clients must call again with `confirm: true`, or set `WOOCOMMERCE_REQUIRE_CONFIRMATION=false` to restore the old behaviour.
- `MCP_HTTP_HOST` may now be a non-loopback address when authentication is configured.
