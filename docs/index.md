---
hide:
  - navigation
---

# woocommerce-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for running one or more WooCommerce stores through the WooCommerce REST API. MCP clients can browse the catalog, work through orders, issue refunds, adjust prices and stock in bulk, and read sales analytics. Every change is previewed before it is applied and can be written to an audit log.

It runs locally over stdio, or as a remote service over streamable HTTP with bearer-token or OAuth 2.0 authentication, and ships with a Docker image definition.

[Get started](getting-started.md){ .md-button .md-button--primary }
[Tools reference](tools.md){ .md-button }
[Tool explorer](https://huggingface.co/spaces/sadrmanesh/woocommerce-mcp-explorer){ .md-button }
[GitHub](https://github.com/sadrmanesh/woocommerce-mcp){ .md-button }

Listed on the official [MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.sadrmanesh/woocommerce-mcp), [Glama](https://glama.ai/mcp/servers/sadrmanesh/woocommerce-mcp), and [mcpservers.org](https://mcpservers.org/servers/sadrmanesh/woocommerce-mcp).

[![Glama MCP server score](https://glama.ai/mcp/servers/sadrmanesh/woocommerce-mcp/badges/score.svg)](https://glama.ai/mcp/servers/sadrmanesh/woocommerce-mcp)
[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/sadrmanesh/woocommerce-mcp)

```bash
WOOCOMMERCE_URL=https://store.example.com \
WOOCOMMERCE_CONSUMER_KEY=ck_... \
WOOCOMMERCE_CONSUMER_SECRET=cs_... \
npx -y @sadrmanesh/woocommerce-mcp
```

## Highlights

- **Multi-store.** Configure any number of stores and pick one per call with `store`. Each store has its own credentials and its own read-only switch.
- **Safe by default.** Stores are read-only until you allow writes. Write tools then return a preview of the exact REST request and apply it only when called again with `confirm: true`. A confirm is refused if the arguments or the store data the change was computed from changed since the preview. `dryRun: true` always previews.
- **Audit log.** One JSON line per write attempt: applied, previewed, refused, or failed, with the tool, store, arguments, caller, and a preview id that links each confirmed write to its preview.
- **Refunds and bulk operations.** Partial or line-item refunds, batch updates of up to 100 products, and percentage or fixed price adjustments.
- **Analytics.** Sales by day, week, or month with refunds, average order value, top products, and payment methods, plus a low-stock report that covers variations.
- **Promotions and customers.** Coupon performance, scheduled sales, and customer segments such as VIP, repeat, and at risk.
- **Fulfillment.** Order notes, shipment tracking, and one-step fulfillment that emails the customer.
- **Webhooks.** Manage store webhooks and receive signed deliveries, readable as MCP resources.
- **Privacy and control.** Optional PII redaction, and tool allow and deny lists per deployment or per store.
- **Gentle on the store.** Per-store rate limiting, retries with backoff, and an optional read cache.
- **Remote ready.** Streamable HTTP with static bearer tokens (full or read-only) or RFC 7662 token introspection, RFC 9728 protected resource metadata, Host and Origin checks, and a health endpoint.
- **MCP resources and prompts.** Read products and orders by URI, and start common workflows such as a sales briefing or a restock plan.
- **Observability.** Optional OpenTelemetry traces for every tool call and WooCommerce request.
- **Well tested.** Strict TypeScript, Zod validation on every input, and tests against a mocked WooCommerce API.

## Explore

<div class="grid cards" markdown>

-   **Getting started**

    ---

    Install, create a REST API key, and connect an MCP client over stdio or HTTP.

    [Getting started](getting-started.md) · [Install options](install.md)

-   **Tools, resources, and prompts**

    ---

    47 tools for products, orders, fulfillment, customers, coupons, webhooks, shipping, taxes, and analytics.

    [Tools reference](tools.md)

-   **Safe writes**

    ---

    Read-only by default, previewed changes, write scopes, and an audit log.

    [Safe writes](safe-writes.md)

-   **Configuration**

    ---

    Every environment variable and the multi-store file format.

    [Configuration](configuration.md)

-   **Security and authentication**

    ---

    Bearer tokens, read-only tokens, OAuth 2.0 introspection, Host and Origin checks.

    [Security](security.md)

-   **Deployment and observability**

    ---

    Docker, reverse proxies, health checks, and OpenTelemetry traces.

    [Deployment](deployment.md)

-   **Webhooks**

    ---

    Signed deliveries from WooCommerce, kept as events the assistant can read.

    [Webhooks](webhooks.md)

-   **Privacy and performance**

    ---

    PII redaction, rate limits, retries, and caching.

    [Privacy](privacy.md) · [Performance](performance.md)

</div>

## License

MIT. Copyright (c) 2026 Naser Sadrmanesh.
