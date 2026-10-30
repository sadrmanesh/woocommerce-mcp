# woocommerce-mcp

[![CI](https://github.com/sadrmanesh/woocommerce-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sadrmanesh/woocommerce-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933)
[![Docs](https://img.shields.io/badge/docs-sadrmanesh.github.io-7e57c2)](https://sadrmanesh.github.io/woocommerce-mcp/)
[![npm](https://img.shields.io/npm/v/@sadrmanesh/woocommerce-mcp)](https://www.npmjs.com/package/@sadrmanesh/woocommerce-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.sadrmanesh%2Fwoocommerce--mcp-0a7d5a)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.sadrmanesh/woocommerce-mcp)

A [Model Context Protocol](https://modelcontextprotocol.io) server for running one or more WooCommerce stores through the WooCommerce REST API. MCP clients can browse the catalog, work through and fulfill orders, issue refunds, adjust prices and stock in bulk, run promotions, segment customers, react to webhooks, and read sales analytics. Every change is previewed before it is applied and can be written to an audit log.

It runs locally over stdio, or as a remote service over streamable HTTP with bearer-token or OAuth 2.0 authentication, and ships with a Docker image definition.

**Documentation:** <https://sadrmanesh.github.io/woocommerce-mcp/>

Listed on the [official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.sadrmanesh/woocommerce-mcp) as `io.github.sadrmanesh/woocommerce-mcp`.

## Contents

- [Highlights](#highlights)
- [Quick start](#quick-start)
- [Connect an MCP client](#connect-an-mcp-client)
- [Tools, resources, and prompts](#tools-resources-and-prompts)
- [Safe writes](#safe-writes)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Development](#development)
- [Documentation](#documentation)

## Highlights

- **Multi-store.** Configure any number of stores and pick one per call with `store`. Each store has its own credentials and its own read-only switch.
- **Safe by default.** Stores are read-only until you allow writes. Write tools then return a preview of the exact REST request and apply it only when called again with `confirm: true`. `dryRun: true` always previews.
- **Audit log.** One JSON line per write attempt: applied, previewed, refused, or failed, with the tool, store, arguments, and caller.
- **Refunds and bulk operations.** Partial or line-item refunds, batch updates of up to 100 products, and percentage or fixed price adjustments.
- **Analytics.** Sales by day, week, or month with refunds, average order value, top products, and payment methods, plus a low-stock report that covers variations.
- **Promotions and customers.** Coupon performance, scheduled sales, and customer segments such as VIP, repeat, and at risk.
- **Fulfillment.** Order notes, shipment tracking, and one-step fulfillment that emails the customer.
- **Webhooks.** Manage store webhooks and receive signed deliveries, readable as MCP resources.
- **Shipping and taxes.** Read shipping zones, methods, tax rates, and tax classes.
- **Privacy and control.** Optional PII redaction, and tool allow and deny lists per deployment or per store.
- **Gentle on the store.** Per-store rate limiting, retries with backoff and jitter, and an optional read cache.
- **Remote ready.** Streamable HTTP with static bearer tokens (full or read-only) or RFC 7662 token introspection, RFC 9728 protected resource metadata, Host and Origin checks, and a health endpoint.
- **MCP resources and prompts.** Read products and orders by URI, and start common workflows such as a sales briefing or a restock plan.
- **Observability.** Optional OpenTelemetry traces for every tool call and WooCommerce request.
- **Well tested.** Strict TypeScript, Zod validation on every input, and tests against a mocked WooCommerce API.

## Quick start

Node.js 20 or newer is required.

```bash
npm install -g @sadrmanesh/woocommerce-mcp
```

Or from a checkout:

```bash
git clone https://github.com/sadrmanesh/woocommerce-mcp.git
cd woocommerce-mcp
npm install
npm run build
cp .env.example .env
```

Create a REST API key under **WooCommerce > Settings > Advanced > REST API**. Use a Read key while the store is read-only, and a Read/Write key only when you enable writes. WordPress permalinks must not be set to "Plain", or `/wp-json/` will not resolve.

```bash
WOOCOMMERCE_URL=https://store.example.com \
WOOCOMMERCE_CONSUMER_KEY=ck_... \
WOOCOMMERCE_CONSUMER_SECRET=cs_... \
woocommerce-mcp
```

The process then serves MCP on stdin and stdout. Logs go to stderr. `npm start` in a checkout loads `.env` from the working directory without overriding variables that are already set.

## Connect an MCP client

Most hosts accept an `mcpServers` map like the ones below. Keep secrets in `env`, never in `args`. Docker, Smithery, and MCP Registry installs are in [docs/install.md](docs/install.md).

### stdio

```json
{
  "mcpServers": {
    "woocommerce": {
      "command": "npx",
      "args": ["-y", "@sadrmanesh/woocommerce-mcp"],
      "env": {
        "WOOCOMMERCE_URL": "https://store.example.com",
        "WOOCOMMERCE_CONSUMER_KEY": "ck_your_consumer_key",
        "WOOCOMMERCE_CONSUMER_SECRET": "cs_your_consumer_secret"
      }
    }
  }
}
```

From a checkout, use `"command": "node"` and `"args": ["/absolute/path/to/woocommerce-mcp/dist/index.js"]`.

### Streamable HTTP

```bash
MCP_TRANSPORT=http MCP_HTTP_AUTH_TOKENS="$(openssl rand -base64 32)" woocommerce-mcp
```

```json
{
  "mcpServers": {
    "woocommerce": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Without authentication the HTTP endpoint only binds to loopback. See [docs/security.md](docs/security.md) for tokens, scopes, and OAuth introspection.

## Tools, resources, and prompts

Every tool except `woocommerce_list_stores` accepts an optional `store` id. Without it, the default store is used.

| Area | Read tools | Write tools |
| --- | --- | --- |
| Stores | `list_stores` | |
| Products | `list_products`, `search_products`, `get_product` | `create_product`, `update_product`, `bulk_update_products`, `bulk_adjust_prices` |
| Orders | `list_orders`, `get_order`, `list_order_notes` | `update_order_status`, `add_order_note`, `delete_order_note` |
| Fulfillment | `get_order_tracking` | `fulfill_order` |
| Refunds | `list_refunds`, `get_refund` | `create_refund` |
| Customers | `list_customers`, `get_customer`, `customer_orders`, `customer_segments` | `update_customer` |
| Stock | `get_stock`, `low_stock_report` | `update_stock` |
| Coupons and sales | `list_coupons`, `get_coupon`, `coupon_performance` | `create_coupon`, `update_coupon`, `delete_coupon`, `schedule_sale`, `end_sale` |
| Webhooks | `list_webhooks`, `get_webhook`, `list_webhook_events` | `create_webhook`, `update_webhook`, `delete_webhook` |
| Shipping and taxes | `list_shipping_zones`, `list_shipping_methods`, `list_tax_rates`, `list_tax_classes` | |
| Analytics | `get_store_summary`, `sales_analytics` | |

Every name starts with `woocommerce_`, for example `woocommerce_customer_segments`. That makes 47 tools: 28 reads and 19 writes.

**Resources**

| URI | Content |
| --- | --- |
| `woocommerce://stores` | Configured stores |
| `woocommerce://stores/{store}/products/{id}` | One product |
| `woocommerce://stores/{store}/orders/{id}` | One order |
| `woocommerce://stores/{store}/events` | Recent webhook deliveries |
| `woocommerce://stores/{store}/events/{id}` | One webhook delivery with its payload |

**Prompts:** `sales_briefing`, `restock_plan`, `order_triage`, and `price_change_review`.

Full argument and response details are in [docs/tools.md](docs/tools.md).

## Safe writes

1. **Read-only stores.** A store accepts writes only when `WOOCOMMERCE_READ_ONLY=false` (single store) or `"readOnly": false` (store list). Otherwise write tools fail with `read_only` before contacting the store.
2. **Confirmation.** With `WOOCOMMERCE_REQUIRE_CONFIRMATION=true` (the default), the first call returns the planned request and changes nothing:

   ```json
   {
     "status": "confirmation_required",
     "store": "default",
     "message": "The change was NOT applied. ...",
     "request": { "method": "PUT", "path": "orders/1015", "query": {}, "body": { "status": "completed" } }
   }
   ```

   Calling the tool again with the same arguments and `confirm: true` applies it. `dryRun: true` always previews, even with confirmation turned off.
3. **Scopes.** Over authenticated HTTP, write tools also need the `woocommerce:write` scope. Read-only tokens can never change a store.
4. **Audit.** Set `WOOCOMMERCE_AUDIT_LOG` to a file path or `stderr`:

   ```json
   {"time":"2026-10-30T14:02:11.120Z","tool":"woocommerce_update_order_status","store":"default","outcome":"applied","arguments":{"id":1015,"status":"completed"},"client":"static:3f9a1c2b7d10"}
   ```

Refunds created by `woocommerce_create_refund` are recorded as manual refunds unless `apiRefund: true` asks the payment gateway to return the money.

## Configuration

The most common settings are below. Every variable, including the multi-store file format, is in [docs/configuration.md](docs/configuration.md) and [.env.example](.env.example).

| Variable | Default | Description |
| --- | --- | --- |
| `WOOCOMMERCE_URL` | | Store origin, without `/wp-json` |
| `WOOCOMMERCE_CONSUMER_KEY` / `_SECRET` | | REST API credentials |
| `WOOCOMMERCE_READ_ONLY` | `true` | Allow writes for the single store |
| `WOOCOMMERCE_STORES_FILE` / `WOOCOMMERCE_STORES` | | Several stores, as a JSON file or inline JSON |
| `WOOCOMMERCE_DEFAULT_STORE` | first store | Store used when a call omits `store` |
| `WOOCOMMERCE_REQUIRE_CONFIRMATION` | `true` | Preview writes until `confirm: true` |
| `WOOCOMMERCE_AUDIT_LOG` | off | File path or `stderr` |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_HTTP_HOST` / `_PORT` / `_PATH` | `127.0.0.1` / `3000` / `/mcp` | HTTP listener |
| `MCP_HTTP_AUTH_TOKENS` | | Full-access bearer tokens |
| `MCP_HTTP_AUTH_READ_TOKENS` | | Read-only bearer tokens |
| `WOOCOMMERCE_REDACT_PII` | `false` | Mask names, emails, phones, and addresses in results |
| `WOOCOMMERCE_TOOLS_ALLOW` / `_DENY` | | Tool names or `*` patterns to expose or hide |
| `WOOCOMMERCE_WEBHOOK_SECRET` | | Enables the webhook receiver for the store |
| `WOOCOMMERCE_RATE_LIMIT` / `_BURST` | `5` / `10` | Requests per second per store, and burst |
| `WOOCOMMERCE_CACHE_TTL_MS` | `0` (off) | Cache read responses |
| `WOOCOMMERCE_OTEL_ENABLED` | `false` | Export OpenTelemetry traces |

Multi-store example (`stores.json`):

```json
{
  "defaultStore": "eu",
  "stores": [
    { "id": "eu", "label": "EU shop", "url": "https://eu.example.com", "consumerKeyEnv": "EU_KEY", "consumerSecretEnv": "EU_SECRET" },
    { "id": "us", "url": "https://us.example.com", "consumerKeyEnv": "US_KEY", "consumerSecretEnv": "US_SECRET", "readOnly": false }
  ]
}
```

## Deployment

```bash
cp .env.example .env    # add store credentials and MCP_HTTP_AUTH_TOKENS
docker compose up -d --build
curl http://127.0.0.1:3000/healthz
```

The image runs as a non-root user, listens on port 3000, and has a health check. Put it behind a TLS-terminating reverse proxy for remote use. See [docs/deployment.md](docs/deployment.md).

## Development

```bash
npm install
npm run check   # lint, typecheck, tests, build
```

Tests run against a mocked WooCommerce API and never call a live store. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

The full documentation site is at <https://sadrmanesh.github.io/woocommerce-mcp/>. The same guides are in this repository:

- [Install options](docs/install.md)
- [Configuration](docs/configuration.md)
- [Tools reference](docs/tools.md)
- [Webhooks](docs/webhooks.md)
- [Privacy](docs/privacy.md)
- [Performance](docs/performance.md)
- [Security and authentication](docs/security.md)
- [Deployment](docs/deployment.md)
- [Observability](docs/observability.md)
- [Changelog](CHANGELOG.md)

## License

MIT. Copyright (c) 2026 Naser Sadrmanesh. See [LICENSE](LICENSE).

## Author

Naser Sadrmanesh: <https://github.com/sadrmanesh> · <https://sadrmanesh.github.io> · <info.sadrmanesh@gmail.com>
