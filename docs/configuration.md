# Configuration

All settings come from environment variables. Empty values count as unset. Booleans accept `true`/`false`, `1`/`0`, `yes`/`no`, and `on`/`off`. Invalid settings stop the server at start-up with one message listing every problem.

## Stores

### One store

| Variable | Default | Description |
| --- | --- | --- |
| `WOOCOMMERCE_URL` | required | Store origin, without `/wp-json`. A subdirectory install may include its path. |
| `WOOCOMMERCE_CONSUMER_KEY` | required | REST API consumer key |
| `WOOCOMMERCE_CONSUMER_SECRET` | required | REST API consumer secret |
| `WOOCOMMERCE_READ_ONLY` | `true` | Set to `false` to allow write tools for this store |
| `WOOCOMMERCE_STORE_ID` | `default` | Id used in the `store` argument and resource URIs |
| `WOOCOMMERCE_STORE_LABEL` | | Human-readable name |
| `WOOCOMMERCE_AUTH_MODE` | `basic` on https, `oauth1` on http | `basic`, `oauth1`, or `query` |
| `WOOCOMMERCE_API_VERSION` | `wc/v3` | REST namespace, such as `wc/v3` |
| `WOOCOMMERCE_WEBHOOK_SECRET` | | Secret for signing and verifying webhooks, 16 characters or more. Enables the [webhook receiver](webhooks.md) for this store. |

### Several stores

Set **one** of:

- `WOOCOMMERCE_STORES_FILE`: path to a JSON file
- `WOOCOMMERCE_STORES`: the same JSON inline

The single-store variables can be used at the same time; that store is added first. The document is either an array of stores or an object with `stores` and an optional `defaultStore`:

```json
{
  "defaultStore": "eu",
  "stores": [
    {
      "id": "eu",
      "label": "EU shop",
      "url": "https://eu.example.com",
      "consumerKeyEnv": "EU_WC_KEY",
      "consumerSecretEnv": "EU_WC_SECRET"
    },
    {
      "id": "us",
      "url": "https://us.example.com",
      "consumerKey": "ck_...",
      "consumerSecret": "cs_...",
      "authMode": "basic",
      "apiVersion": "wc/v3",
      "readOnly": false
    }
  ]
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | 1 to 40 letters, digits, `-`, or `_`. Matched without regard to case. Must be unique. |
| `url` | yes | Same rules as `WOOCOMMERCE_URL` |
| `consumerKey` or `consumerKeyEnv` | yes | The key, or the name of an environment variable that holds it |
| `consumerSecret` or `consumerSecretEnv` | yes | Prefer `consumerSecretEnv` so the file holds no secrets |
| `label` | no | Display name |
| `authMode` | no | Defaults by URL scheme |
| `apiVersion` | no | Defaults to `wc/v3` |
| `readOnly` | no | Defaults to `true` for every listed store |
| `redactPii` | no | Mask personal data in every result for this store. Defaults to `WOOCOMMERCE_REDACT_PII`. |
| `webhookSecret` or `webhookSecretEnv` | no | Webhook secret, 16 characters or more. Prefer `webhookSecretEnv`. |
| `allowTools` | no | Tool names or patterns this store allows. Empty means all. |
| `denyTools` | no | Tool names or patterns this store refuses |

`WOOCOMMERCE_DEFAULT_STORE` picks the store used when a call omits `store`. It overrides `defaultStore` from the document. Without either, the first store is the default.

## Write safety

| Variable | Default | Description |
| --- | --- | --- |
| `WOOCOMMERCE_REQUIRE_CONFIRMATION` | `true` | Write tools return a preview until called with `confirm: true` |
| `WOOCOMMERCE_AUDIT_LOG` | off | Path of a JSON Lines file (created with mode 0600), or `stderr` |
| `WOOCOMMERCE_APPROVAL_SECRET` | off | 32 characters or more. When set, every confirmed write needs an `approval` token signed with it, and writes always preview first. See [Signed approvals](safe-writes.md#signed-approvals). Never put it where the agent can read it, such as an MCP client config |
| `WOOCOMMERCE_APPROVAL_TTL_SECONDS` | `600` | Longest approval token lifetime the server accepts, 30 to 3600. Also the default lifetime for `woocommerce-mcp approve` |

## Tool allow and deny lists

| Variable | Default | Description |
| --- | --- | --- |
| `WOOCOMMERCE_TOOLS_ALLOW` | all tools | Comma-separated tool names or patterns to expose |
| `WOOCOMMERCE_TOOLS_DENY` | none | Comma-separated tool names or patterns to hide |

A pattern is a tool name, with or without the `woocommerce_` prefix, where `*` matches any run of characters. For example, `delete_*` matches `woocommerce_delete_coupon`, and `*webhook*` matches every webhook tool. Deny wins over allow. A pattern that matches no tool is a configuration error, so typos are caught at start-up.

The global lists decide which tools are registered at all. The per-store `allowTools` and `denyTools` fields are checked on every call: a tool hidden for one store is still listed when another store allows it, and calling it for the store that denies it fails with `tool_disabled`. A tool that no store allows is not listed.

```bash
# A reporting deployment: reads only, no customer tools.
WOOCOMMERCE_TOOLS_ALLOW="list_*,get_*,*_report,*_analytics,*_performance"
WOOCOMMERCE_TOOLS_DENY="*customer*"
```

`woocommerce_list_stores` is always available.

## Privacy

| Variable | Default | Description |
| --- | --- | --- |
| `WOOCOMMERCE_REDACT_PII` | `false` | Mask names, emails, phones, and street addresses in every tool result and resource. Per store: `redactPii`. |

See [Privacy](privacy.md) for what is masked.

## Webhooks

| Variable | Default | Description |
| --- | --- | --- |
| `WOOCOMMERCE_WEBHOOK_PATH` | `/webhooks/woocommerce` | Base path of the receiver. Deliveries go to `<path>/<store id>`. Must differ from `MCP_HTTP_PATH`. |
| `WOOCOMMERCE_WEBHOOK_BUFFER` | `200` | Deliveries kept in memory per store, 1 to 10000 |
| `WOOCOMMERCE_TRACKING_MODE` | `meta` | Where `woocommerce_fulfill_order` stores tracking: `meta` or `shipment-tracking` |

See [Webhooks](webhooks.md).

## REST client

| Variable | Default | Description |
| --- | --- | --- |
| `WOOCOMMERCE_TIMEOUT_MS` | `30000` | Per-attempt timeout, 1000 to 120000 |
| `WOOCOMMERCE_MAX_RETRIES` | `2` | Extra attempts after the first, 0 to 5 |
| `WOOCOMMERCE_DEFAULT_PER_PAGE` | `10` | Page size when a tool omits `perPage`, up to 100 |
| `WOOCOMMERCE_DEBUG` | `false` | Log the method and API path of each request to stderr. Queries and secrets are never logged. |
| `WOOCOMMERCE_USER_AGENT` | `woocommerce-mcp/<version>` | `User-Agent` header |
| `WOOCOMMERCE_RATE_LIMIT` | `5` | Requests per second per store, 0 to 1000. `0` turns the limiter off. |
| `WOOCOMMERCE_RATE_BURST` | `10` | Requests allowed at once before the rate applies, 1 to 1000 |
| `WOOCOMMERCE_RETRY_BASE_MS` | `250` | First retry backoff, 10 to 10000 |
| `WOOCOMMERCE_RETRY_MAX_MS` | `10000` | Longest backoff, and the longest `Retry-After` the server waits for, 100 to 60000 |
| `WOOCOMMERCE_CACHE_TTL_MS` | `0` (off) | How long read responses are cached, up to 3600000 |
| `WOOCOMMERCE_CACHE_MAX_ENTRIES` | `500` | Cached responses kept per store, 1 to 100000 |

Reads retry HTTP 408, 429, 502, 503, 504, timeouts, and network failures. Writes retry only HTTP 429, because a 5xx may mean the change was applied. Redirects are not followed. See [Performance](performance.md) for the rate limiter, backoff, and cache.

## Transport

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_HTTP_HOST` | `127.0.0.1` | Bind address. Anything other than loopback requires authentication. |
| `MCP_HTTP_PORT` | `3000` | TCP port |
| `MCP_HTTP_PATH` | `/mcp` | Endpoint path |
| `MCP_HTTP_ALLOWED_HOSTS` | loopback names | Comma-separated `Host` header names to accept |
| `MCP_HTTP_ALLOWED_ORIGINS` | loopback origins | Comma-separated browser origins to accept |

Authentication variables are described in [security.md](security.md).

## Tracing

| Variable | Default | Description |
| --- | --- | --- |
| `WOOCOMMERCE_OTEL_ENABLED` | `false` | Export traces with OTLP over HTTP |

Standard `OTEL_*` variables such as `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME` apply. See [observability.md](observability.md).
