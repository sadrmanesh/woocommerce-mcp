# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-10-31

### Added

- Preview ids for writes. Every `confirmation_required`, `dry_run`, and `no_change` response includes a `previewId`: `pv_` and 16 hex characters of a SHA-256 over the tool name, store id, and arguments with sorted keys. A confirm call can pass it back as `previewId`. The server recomputes it from the call's own arguments and refuses the write with `preview_mismatch`, before contacting the store, if they differ from the preview.
- Audit entries for writes carry `previewId`, so a preview and the confirmed write that followed it share one id. When the caller supplied a `previewId`, the entry also records `previewMatch`. See the Preview ids section of the safe writes guide.
- An optional Docker Hub job in the release workflow. When the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets are set, it copies the released GHCR image to `docker.io/<username>/woocommerce-mcp` with the same tags. Without them it skips.
- A tool explorer on Hugging Face, <https://huggingface.co/spaces/sadrmanesh/woocommerce-mcp-explorer>, that lists every tool, prompt, and resource with its input schema and builds `tools/call` requests. The README and docs link to it, and the README names the Docker Hub image `sadrmanesh/woocommerce-mcp`.
- `.github/workflows/mirror.yml`, which mirrors `main` and tags to `gitlab.com/sadrmanesh/woocommerce-mcp` when the `GITLAB_TOKEN` secret is set, and skips cleanly otherwise.

### Changed

- `previewId` is optional, so a confirm call without it works as before. Its audit entry records the id its arguments would have had.
- Tool descriptions, the server instructions, and the `confirmation_required` message ask clients to send `previewId` back with `confirm: true`.
- `server.json`, the package version, and the Docker Compose image tag are now 0.4.0.

## [0.3.2] - 2026-10-30

### Added

- The release workflow publishes a Docker image to the GitHub Container Registry as `ghcr.io/sadrmanesh/woocommerce-mcp`, built for `linux/amd64` and `linux/arm64` and tagged `X.Y.Z`, `X.Y`, and `latest`. OCI labels and annotations link the image to this repository and carry its description and license.
- The release workflow also publishes `@sadrmanesh/woocommerce-mcp` to GitHub Packages with the workflow's `GITHUB_TOKEN`. npmjs.com remains the main registry.
- Install docs for the published image and for installing from GitHub Packages with an `.npmrc` scope entry, in the README, the install and deployment guides, and the Persian page.

### Changed

- The Docker examples use the published image instead of a local build.
- `server.json`, the package version, and the Docker Compose image tag are now 0.3.2.

## [0.3.1] - 2026-10-30

### Added

- The release workflow publishes `server.json` to the official MCP Registry after each npm release, signing in with GitHub OIDC. The job checks that `server.json` matches the tag and waits until the package is visible on npm.
- npm and MCP Registry badges in the README, and registry details in the install guide.

### Changed

- `server.json` and the package version are now 0.3.1.

## [0.3.0] - 2026-10-30

### Added

- Customer tools: `woocommerce_update_customer`, `woocommerce_customer_orders` with lifetime totals, and `woocommerce_customer_segments`, which groups customers into VIP, repeat, one-time, and at-risk segments and summarizes guest orders.
- PII redaction: `WOOCOMMERCE_REDACT_PII` or a per-store `redactPii` setting masks names, emails, phones, and street addresses in every tool result and resource. Customer tools also accept `redactPii` per call.
- Coupon and promotion tools: get, update, and delete coupons, `woocommerce_coupon_performance` (uses, discount given, and revenue per code), and `woocommerce_schedule_sale` and `woocommerce_end_sale` for timed percentage sales.
- Order fulfillment: `woocommerce_list_order_notes`, `woocommerce_delete_order_note`, `woocommerce_get_order_tracking`, and `woocommerce_fulfill_order`, which records tracking, completes the order, and notifies the customer. Tracking is kept in order meta, or in the Shipment Tracking extension with `WOOCOMMERCE_TRACKING_MODE=shipment-tracking`.
- Webhook management: list, get, create, update (including secret rotation), and delete webhooks. Webhook secrets come from configuration and never appear in results or previews.
- Webhook receiver on the HTTP transport at `WOOCOMMERCE_WEBHOOK_PATH/<store>`. Deliveries are verified with the store's HMAC-SHA256 secret and kept in memory, readable with `woocommerce_list_webhook_events` and the `woocommerce://stores/{store}/events` resources.
- Shipping and tax tools: shipping zones with their locations and methods, shipping methods, tax rates, and tax classes.
- Tool allow and deny lists with `*` patterns: `WOOCOMMERCE_TOOLS_ALLOW` and `WOOCOMMERCE_TOOLS_DENY` for the whole server, and `allowTools` and `denyTools` per store.
- Per-store rate limiting (`WOOCOMMERCE_RATE_LIMIT`, `WOOCOMMERCE_RATE_BURST`).
- Optional read cache (`WOOCOMMERCE_CACHE_TTL_MS`, `WOOCOMMERCE_CACHE_MAX_ENTRIES`), cleared by every write to the store.
- `server.json` for the MCP Registry, `mcpName` in `package.json`, a `smithery.yaml`, and OCI labels on the Docker image.
- Documentation for install options, webhooks, privacy, and performance.

### Changed

- The npm package is now published as `@sadrmanesh/woocommerce-mcp`. Install it with `npm install -g @sadrmanesh/woocommerce-mcp` or run it with `npx -y @sadrmanesh/woocommerce-mcp`. The command name is still `woocommerce-mcp`.
- `woocommerce_low_stock_report` now checks the variations of variable products, unless `includeVariations: false`. Each item has `type` (`product` or `variation`) and `parentId`, and the result reports `variationsScanned`.
- Retries use exponential backoff with equal jitter, configurable with `WOOCOMMERCE_RETRY_BASE_MS` and `WOOCOMMERCE_RETRY_MAX_MS`. Reads also retry HTTP 408.
- `woocommerce_list_stores` reports each store's privacy, webhook, cache, and rate limit settings.
- The server now has 47 tools, up from 24.

## [0.2.0] - 2026-10-30

### Added

- Several stores in one server, configured with `WOOCOMMERCE_STORES` or `WOOCOMMERCE_STORES_FILE`. Every tool takes an optional `store` argument, and each store has its own read-only setting.
- Bearer authentication for the HTTP transport: static tokens with full or read-only scope, and OAuth 2.0 access tokens checked with RFC 7662 token introspection. Protected resource metadata (RFC 9728) and `WWW-Authenticate` challenges let clients discover the authorization server.
- `/healthz` endpoint, `Host` and `Origin` allow lists, and binding beyond loopback when authentication is configured.
- Write previews: `dryRun: true` returns the exact request a write tool would send, and `confirm: true` applies it.
- Audit log of every write attempt as JSON Lines (`WOOCOMMERCE_AUDIT_LOG`).
- Refund tools: list, get, and create, with gateway refunds off unless requested.
- Bulk tools: batch updates of price, stock, and status for up to 100 products, and percentage or fixed price adjustments.
- Sales analytics over orders, with a time series, status and payment method breakdowns, and top products, plus a low stock report.
- `woocommerce_list_stores` tool.
- MCP resources for stores, products, and orders, and prompts for a sales briefing, restock plan, order triage, and price change review.
- Optional OpenTelemetry tracing for tool calls and WooCommerce requests (`WOOCOMMERCE_OTEL_ENABLED`).
- Dockerfile and Docker Compose setup, with an image build and smoke test in CI.
- Release workflow that verifies the package and publishes it to npm when a version tag is pushed.
- Documentation for configuration, tools, security, deployment, and observability.

### Changed

- Write tools ask for confirmation by default. Set `WOOCOMMERCE_REQUIRE_CONFIRMATION=false` to apply changes on the first call.
- `MCP_HTTP_HOST` accepts non-loopback addresses when bearer authentication is configured.
- Tool modules register through a shared definition that adds the store, preview, audit, and tracing handling.

## [0.1.0] - 2026-10-30

### Added

- MCP server for the WooCommerce REST API (`wc/v3`) over stdio, with an optional streamable HTTP endpoint bound to loopback.
- Product tools: list, search, get, create, and update.
- Order tools: list, get, update status, and add a note.
- Customer tools: list and get.
- Stock tools for products and variations.
- Store summary from the sales, top sellers, and totals report endpoints.
- Coupon tools: list and create.
- Read-only mode, enabled unless `WOOCOMMERCE_READ_ONLY=false`.
- Zod input validation, pagination, WooCommerce error mapping, and retries for rate limits and transient read failures.
- Configuration through environment variables, documented in `.env.example`.
- Tests with mocked HTTP, ESLint, and a GitHub Actions workflow.

[Unreleased]: https://github.com/sadrmanesh/woocommerce-mcp/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/sadrmanesh/woocommerce-mcp/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/sadrmanesh/woocommerce-mcp/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/sadrmanesh/woocommerce-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/sadrmanesh/woocommerce-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sadrmanesh/woocommerce-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sadrmanesh/woocommerce-mcp/releases/tag/v0.1.0
