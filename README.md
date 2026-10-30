# woocommerce-mcp

[![CI](https://github.com/sadrmanesh/woocommerce-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sadrmanesh/woocommerce-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

MCP server for reading and managing a WooCommerce store through the WooCommerce REST API. Any MCP client that speaks stdio, or streamable HTTP, can list products, orders, customers, coupons, stock, and a sales summary, and can change the store when you explicitly allow writes.

The server talks to `/wp-json/wc/v3/` with the consumer key and secret from WooCommerce. It does not store those credentials.

## Features

- Products: list, search, get, create, and update
- Orders: list, get, update status, and add a note
- Customers: list and get
- Inventory: read stock and update quantity or status, including variations
- Store summary from the reports API: recent sales, top sellers, and order, product, and customer totals
- Coupons: list and create
- Read-only mode on by default. Writes run only when `WOOCOMMERCE_READ_ONLY=false`
- Zod validation on every tool input
- Pagination via `page` and `perPage`, with `X-WP-Total` and `X-WP-TotalPages` returned to the client
- WooCommerce error payloads mapped to a stable JSON error, with retries for rate limits and transient gateway failures
- stdio transport, plus an optional streamable HTTP endpoint bound to loopback

## Quick start

Node.js 20 or newer is required.

```bash
git clone https://github.com/sadrmanesh/woocommerce-mcp.git
cd woocommerce-mcp
npm install
cp .env.example .env
```

Edit `.env` with the store URL and a REST API key from **WooCommerce > Settings > Advanced > REST API**. Use a Read key while the server is read-only. Use a Read/Write key only after you set `WOOCOMMERCE_READ_ONLY=false`.

WordPress permalinks must not be "Plain", or `/wp-json/` will not resolve.

```bash
npm run build
npm start
```

`npm start` loads `.env` from the working directory without overriding variables that are already set. An MCP host should pass the variables itself. The process then waits on stdin. Logs go to stderr so they do not corrupt the JSON-RPC stream.

To install the published package instead of a checkout:

```bash
npm install woocommerce-mcp
```

The executable name is `woocommerce-mcp`.

## Connect an MCP client

Hosts differ in where this file lives. The `mcpServers` map below is the common shape. Use `type: "stdio"` when the host asks for a transport type. For streamable HTTP, hosts use either `http` or `streamable-http`.

### stdio

Launch the built entry point from a checkout:

```json
{
  "mcpServers": {
    "woocommerce": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/woocommerce-mcp/dist/index.js"],
      "env": {
        "WOOCOMMERCE_URL": "https://store.example.com",
        "WOOCOMMERCE_CONSUMER_KEY": "ck_your_consumer_key",
        "WOOCOMMERCE_CONSUMER_SECRET": "cs_your_consumer_secret",
        "WOOCOMMERCE_READ_ONLY": "true"
      }
    }
  }
}
```

After the package is installed from a registry, the same host can launch the bin:

```json
{
  "mcpServers": {
    "woocommerce": {
      "command": "woocommerce-mcp",
      "env": {
        "WOOCOMMERCE_URL": "https://store.example.com",
        "WOOCOMMERCE_CONSUMER_KEY": "ck_your_consumer_key",
        "WOOCOMMERCE_CONSUMER_SECRET": "cs_your_consumer_secret"
      }
    }
  }
}
```

`npx` works the same way once the package is published: `"command": "npx"` and `"args": ["-y", "woocommerce-mcp"]`, with the same `env` block. Keep the secret in `env`, not in `args`.

### Streamable HTTP

Start the server with `MCP_TRANSPORT=http`. It listens on `127.0.0.1:3000/mcp` unless you change the port or path. v0.1.0 refuses any bind that is not loopback.

```bash
MCP_TRANSPORT=http npm start
```

Point the host at that URL. The store credentials stay in the server environment.

```json
{
  "mcpServers": {
    "woocommerce": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

If the host uses a different type name for streamable HTTP, set `"type": "streamable-http"` and keep the same URL. Requests whose `Host` header is not loopback are rejected.

## Tools

| Tool | Access | Purpose |
| --- | --- | --- |
| `woocommerce_list_products` | read | Filter the catalog |
| `woocommerce_search_products` | read | Search name, SKU, and description |
| `woocommerce_get_product` | read | One product, without `_links` |
| `woocommerce_create_product` | write | Create a product |
| `woocommerce_update_product` | write | Update fields you send |
| `woocommerce_list_orders` | read | Filter orders |
| `woocommerce_get_order` | read | One order, including line items |
| `woocommerce_update_order_status` | write | Set order status |
| `woocommerce_add_order_note` | write | Add a private or customer-visible note |
| `woocommerce_list_customers` | read | Filter customers |
| `woocommerce_get_customer` | read | One customer |
| `woocommerce_get_stock` | read | Stock for a product or variation |
| `woocommerce_update_stock` | write | Set quantity or stock status |
| `woocommerce_get_store_summary` | read | Sales, top sellers, and totals |
| `woocommerce_list_coupons` | read | Filter coupons |
| `woocommerce_create_coupon` | write | Create a coupon |

List tools return `{ items, pagination }`. `pagination` is `{ page, perPage, total, totalPages }`. `total` and `totalPages` are `null` when WooCommerce omits the headers. Get tools return the REST resource with `_links` removed. Write tools return the created or updated resource in the same shape.

Prices are decimal strings or numbers, such as `"19.99"`. Report dates are `YYYY-MM-DD`. `after` and `before` filters are ISO-8601 date-times, such as `2026-10-01T00:00:00Z`.

## Usage examples

These are example arguments and example responses, not a live store.

Search products:

```json
{
  "query": "scarf",
  "perPage": 5,
  "stockStatus": "instock"
}
```

```json
{
  "items": [
    {
      "id": 7,
      "name": "Wool scarf",
      "sku": "SCARF",
      "type": "simple",
      "status": "publish",
      "price": "25.00",
      "regularPrice": "25.00",
      "salePrice": "",
      "stockStatus": "instock",
      "stockQuantity": 4,
      "manageStock": true,
      "permalink": "https://store.example.com/product/wool-scarf"
    }
  ],
  "pagination": { "page": 1, "perPage": 5, "total": 1, "totalPages": 1 }
}
```

Create a product as a draft:

```json
{
  "name": "Wool hat",
  "status": "draft",
  "regularPrice": "32.00",
  "sku": "HAT",
  "stockQuantity": 12
}
```

Sending `stockQuantity` turns on `manage_stock` unless you also send `manageStock: false`.

Update an order and leave a note the customer can see:

```json
{ "id": 1015, "status": "completed" }
```

```json
{ "orderId": 1015, "note": "Shipped with tracking 1Z999", "customerNote": true }
```

Order statuses: `pending`, `processing`, `on-hold`, `completed`, `cancelled`, `refunded`, `failed`. Changing status to `refunded` does not create a refund record.

Update variation stock:

```json
{ "productId": 70, "variationId": 81, "stockQuantity": 6 }
```

Store summary for a date range:

```json
{ "dateMin": "2026-10-01", "dateMax": "2026-10-30" }
```

With no dates, the sales and top-seller reports use `period: "month"`. You can set `period` to `week`, `month`, `last_month`, or `year`. Order, product, and customer totals are current counts and ignore the date range. Figures come from WooCommerce's reports endpoints and follow that API's definitions.

Create a coupon:

```json
{
  "code": "FALL10",
  "amount": "10",
  "discountType": "percent",
  "dateExpires": "2026-11-30"
}
```

`discountType` is `percent`, `fixed_cart`, or `fixed_product`.

### Errors

A failed tool returns `isError: true` and JSON text:

```json
{
  "error": {
    "message": "Invalid ID.",
    "code": "woocommerce_rest_product_invalid_id",
    "status": 404
  }
}
```

Read-only refusals use `"code": "read_only"` and do not call the store. Invalid arguments are rejected by the schema before the handler runs. Rate-limit responses include `retryAfterMs` when WooCommerce or the host sent `Retry-After`.

Reads retry HTTP 429, 502, 503, 504, timeouts, and network failures, up to `WOOCOMMERCE_MAX_RETRIES` (default 2). Writes retry only HTTP 429, because a 5xx response may mean the change was applied. A `Retry-After` longer than 10 seconds is returned to the caller instead of blocking the tool. Redirects are not followed.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `WOOCOMMERCE_URL` | required | Store origin, without `/wp-json`. A subdirectory install may include its path. |
| `WOOCOMMERCE_CONSUMER_KEY` | required | REST API consumer key |
| `WOOCOMMERCE_CONSUMER_SECRET` | required | REST API consumer secret |
| `WOOCOMMERCE_READ_ONLY` | `true` | Set to `false` to allow write tools |
| `WOOCOMMERCE_AUTH_MODE` | `basic` on https, `oauth1` on http | `basic`, `oauth1`, or `query` |
| `WOOCOMMERCE_API_VERSION` | `wc/v3` | REST version prefix, such as `wc/v3` |
| `WOOCOMMERCE_TIMEOUT_MS` | `30000` | Per-attempt timeout, from 1000 to 120000 |
| `WOOCOMMERCE_MAX_RETRIES` | `2` | Extra attempts after the first, from 0 to 5 |
| `WOOCOMMERCE_DEFAULT_PER_PAGE` | `10` | Page size when a tool omits `perPage`. Maximum 100 |
| `WOOCOMMERCE_DEBUG` | `false` | Log the HTTP method and API path to stderr. Queries are not logged |
| `WOOCOMMERCE_USER_AGENT` | `woocommerce-mcp/0.1.0` | `User-Agent` header |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_HTTP_HOST` | `127.0.0.1` | `127.0.0.1` or `localhost` only |
| `MCP_HTTP_PORT` | `3000` | TCP port for streamable HTTP |
| `MCP_HTTP_PATH` | `/mcp` | URL path for streamable HTTP |

Empty values are treated as unset. Boolean values accept `true`/`false`, `1`/`0`, `yes`/`no`, and `on`/`off`.

HTTPS uses HTTP Basic auth: the consumer key is the username and the consumer secret is the password. Plain HTTP uses OAuth 1.0a one-legged HMAC-SHA1, which is what WooCommerce requires when the connection is not encrypted. `query` puts the key and secret in the query string for hosts that drop the `Authorization` header. The server warns on stderr when that mode, or Basic auth over `http://`, would expose the secret.

Customer and order tools can return personal data. Protect the API key the same way you protect store admin access. Do not commit `.env`.

## Development

```bash
npm install
npm test
npm run lint
npm run typecheck
npm run build
```

`npm run check` runs lint, typecheck, tests, and the build. Tests mock HTTP. They do not call a live store.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).

## Roadmap

v0.1.0 is one store, one API key, and a fixed set of tools. Later versions under consideration, including a pro edition, would add:

- More than one store profile in a single process
- WooCommerce Analytics reports in addition to the legacy reports API
- Product variations, refunds, and shipments as their own tools
- Bulk updates with a dry-run preview before anything is written
- Webhook delivery so a client can hear about new orders
- An audit log of write calls
- Per-tool allow and deny lists
- Authenticated remote HTTP. v0.1.0 binds streamable HTTP to loopback only
- WordPress application passwords as another credential type

Nothing in that list is scheduled. The changelog is the record of what has shipped.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. Copyright (c) 2026 Naser Sadrmanesh. See [LICENSE](LICENSE).

## Author

Naser Sadrmanesh

- <https://github.com/sadrmanesh>
- <https://sadrmanesh.github.io>
- <info.sadrmanesh@gmail.com>
