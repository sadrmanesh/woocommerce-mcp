# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/sadrmanesh/woocommerce-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sadrmanesh/woocommerce-mcp/releases/tag/v0.1.0
