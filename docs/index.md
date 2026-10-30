---
hide:
  - navigation
---

# woocommerce-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for running one or more WooCommerce stores through the WooCommerce REST API. MCP clients can browse the catalog, work through orders, issue refunds, adjust prices and stock in bulk, and read sales analytics. Every change is previewed before it is applied and can be written to an audit log.

It runs locally over stdio, or as a remote service over streamable HTTP with bearer-token or OAuth 2.0 authentication, and ships with a Docker image definition.

[Get started](getting-started.md){ .md-button .md-button--primary }
[Tools reference](tools.md){ .md-button }
[GitHub](https://github.com/sadrmanesh/woocommerce-mcp){ .md-button }

```bash
WOOCOMMERCE_URL=https://store.example.com \
WOOCOMMERCE_CONSUMER_KEY=ck_... \
WOOCOMMERCE_CONSUMER_SECRET=cs_... \
npx -y woocommerce-mcp
```

## Highlights

- **Multi-store.** Configure any number of stores and pick one per call with `store`. Each store has its own credentials and its own read-only switch.
- **Safe by default.** Stores are read-only until you allow writes. Write tools then return a preview of the exact REST request and apply it only when called again with `confirm: true`. `dryRun: true` always previews.
- **Audit log.** One JSON line per write attempt: applied, previewed, refused, or failed, with the tool, store, arguments, and caller.
- **Refunds and bulk operations.** Partial or line-item refunds, batch updates of up to 100 products, and percentage or fixed price adjustments.
- **Analytics.** Sales by day, week, or month with refunds, average order value, top products, and payment methods, plus a low-stock report.
- **Remote ready.** Streamable HTTP with static bearer tokens (full or read-only) or RFC 7662 token introspection, RFC 9728 protected resource metadata, Host and Origin checks, and a health endpoint.
- **MCP resources and prompts.** Read products and orders by URI, and start common workflows such as a sales briefing or a restock plan.
- **Observability.** Optional OpenTelemetry traces for every tool call and WooCommerce request.
- **Well tested.** Strict TypeScript, Zod validation on every input, and tests against a mocked WooCommerce API.

## Explore

<div class="grid cards" markdown>

-   **Getting started**

    ---

    Install, create a REST API key, and connect an MCP client over stdio or HTTP.

    [Getting started](getting-started.md)

-   **Tools, resources, and prompts**

    ---

    24 tools for products, orders, refunds, customers, stock, coupons, and analytics.

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

</div>

## License

MIT. Copyright (c) 2026 Naser Sadrmanesh.
