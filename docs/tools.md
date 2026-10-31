# Tools, resources, and prompts

The server has 47 tools. Operators can hide any of them with allow and deny lists; see [Configuration](configuration.md#tool-allow-and-deny-lists).

The [tool explorer on Hugging Face](https://huggingface.co/spaces/sadrmanesh/woocommerce-mcp-explorer) lists every tool, prompt, and resource with the exact input schemas the server reports over `tools/list`, and builds the `tools/call` request for any arguments you enter.

Every tool accepts an optional `store` argument with a store id from `woocommerce_list_stores`. Without it, the default store is used. Results are JSON text. Errors come back as tool errors with a `code`, a `message`, and, for WooCommerce errors, the HTTP status.

List tools accept `page` (from 1) and `perPage` (1 to 100) and return `items` with `page`, `perPage`, `total`, and `totalPages` when the store reports them. Dates are ISO-8601 (`2026-10-01T00:00:00`). Money values are strings or numbers without a currency symbol.

## Read tools

| Tool | Main arguments |
| --- | --- |
| `woocommerce_list_stores` | none |
| `woocommerce_list_products` | `search`, `status`, `type`, `sku`, `category`, `tag`, `stockStatus`, `featured`, `onSale`, `minPrice`, `maxPrice`, `after`, `before`, `orderBy`, `order` |
| `woocommerce_search_products` | `query` plus the list filters |
| `woocommerce_get_product` | `id` |
| `woocommerce_list_orders` | `search`, `status`, `customer`, `product`, `after`, `before`, `orderBy`, `order` |
| `woocommerce_get_order` | `id` |
| `woocommerce_list_refunds` | `orderId` |
| `woocommerce_get_refund` | `orderId`, `refundId` |
| `woocommerce_list_order_notes` | `orderId`, `type` (`any`, `customer`, `internal`) |
| `woocommerce_get_order_tracking` | `orderId` |
| `woocommerce_list_customers` | `search`, `email`, `role`, `orderBy`, `order`, `redactPii` |
| `woocommerce_get_customer` | `id`, `redactPii` |
| `woocommerce_customer_orders` | `customerId`, `maxOrders`, `recent`, `redactPii` |
| `woocommerce_customer_segments` | `after`, `before`, `statuses`, `vipShare`, `atRiskDays`, `membersPerSegment`, `maxOrders`, `redactPii` |
| `woocommerce_get_stock` | `productId`, `variationId` |
| `woocommerce_list_coupons` | `search`, `code`, `after`, `before`, `orderBy`, `order` |
| `woocommerce_get_coupon` | `id` |
| `woocommerce_coupon_performance` | `after`, `before`, `statuses`, `code`, `maxOrders` |
| `woocommerce_list_webhooks` | `status` |
| `woocommerce_get_webhook` | `id` |
| `woocommerce_list_webhook_events` | `topic` (such as `order.*`), `sinceId`, `limit`, `includePayload` |
| `woocommerce_list_shipping_zones` | `includeMethods`, `includeLocations` |
| `woocommerce_list_shipping_methods` | none |
| `woocommerce_list_tax_rates` | `taxClass` |
| `woocommerce_list_tax_classes` | none |
| `woocommerce_get_store_summary` | `period` (`week`, `month`, `last_month`, `year`) or `dateMin` and `dateMax` |
| `woocommerce_sales_analytics` | `after`, `before`, `statuses`, `groupBy` (`day`, `week`, `month`), `top`, `maxOrders` |
| `woocommerce_low_stock_report` | `threshold`, `includeOutOfStock`, `includeVariations`, `maxProducts`, `maxVariations` |

### Sales analytics

`woocommerce_sales_analytics` reads orders in the range (by default `processing` and `completed`) and returns:

- `orders`, `itemsSold`, `grossSales`, `discounts`, `shipping`, `tax`, `refunds`, `netSales`, and `averageOrderValue`
- `series`: orders and total per day, week (starting Monday), or month, in UTC
- `byStatus`, `paymentMethods`, and `topProducts` (by revenue)

Amounts are added in fixed point, so totals do not drift. Up to `maxOrders` orders (default 1000, maximum 5000) are read; when there are more, `truncated` is `true`. Use a shorter range or raise `maxOrders`.

### Low stock report

`woocommerce_low_stock_report` scans published products (up to `maxProducts`, default 500) and returns those that track stock at or below `threshold` (default 5), plus out-of-stock items, sorted by quantity.

Variable products are handled in two ways:

- When the parent product manages stock for all variations, the parent is checked like a simple product.
- Otherwise each variation is read and checked on its own (up to `maxVariations`, default 2000). Variation items have `type: "variation"`, their own `id`, the `parentId`, and a name such as `Tee - S`.

Pass `includeVariations: false` to skip the variation requests on large catalogs. The result reports `scanned`, `variationsScanned`, and `truncated`.

### Customers and segments

`woocommerce_customer_orders` reads one customer's orders and returns the order count, total spent and average order value (processing and completed orders only), first and last order dates, and the most recent orders.

`woocommerce_customer_segments` reads orders in a date range and groups the people who placed them:

| Segment | Rule |
| --- | --- |
| `vip` | Top `vipShare` percent by spend (default 10, at least one customer) |
| `repeat` | Two or more orders |
| `oneTime` | Exactly one order |
| `atRisk` | Repeat customers whose last order is more than `atRiskDays` (default 60) before the end of the range |
| `guests` | Orders without an account, grouped by billing email |

Each segment returns `customers`, `spent`, and up to `membersPerSegment` members. Only orders inside the range are counted. Pass `redactPii: true` to mask names, emails, and phones; see [Privacy](privacy.md).

### Coupon performance

`woocommerce_coupon_performance` reads the coupon lines of orders in a range and returns, per code, the number of orders, the discount given, and the revenue of those orders. Codes are compared without regard to case.

## Write tools

| Tool | Main arguments |
| --- | --- |
| `woocommerce_create_product` | `name` and product fields |
| `woocommerce_update_product` | `id` and product fields |
| `woocommerce_bulk_update_products` | `updates`: up to 100 of `{ id, regularPrice, salePrice, stockQuantity, stockStatus, manageStock, status }` |
| `woocommerce_bulk_adjust_prices` | `productIds`, `mode` (`percent`, `fixed`), `change`, `target` (`regular`, `sale`), `decimals` |
| `woocommerce_update_order_status` | `id`, `status` |
| `woocommerce_add_order_note` | `orderId`, `note`, `customerNote` |
| `woocommerce_delete_order_note` | `orderId`, `noteId` |
| `woocommerce_fulfill_order` | `orderId`, `carrier`, `trackingNumber`, `trackingUrl`, `shippedAt`, `markCompleted`, `notifyCustomer` |
| `woocommerce_create_refund` | `orderId`, `amount` or `lineItems`, `reason`, `apiRefund`, `restockItems` |
| `woocommerce_update_stock` | `productId`, `variationId`, `stockQuantity`, `manageStock`, `stockStatus` |
| `woocommerce_update_customer` | `id`, `email`, `firstName`, `lastName`, `billing`, `shipping` |
| `woocommerce_create_coupon` | `code`, `amount`, `discountType`, `dateExpires`, limits and restrictions |
| `woocommerce_update_coupon` | `id` and the coupon fields to change; `null` clears `dateExpires` or a limit |
| `woocommerce_delete_coupon` | `id`, `force` |
| `woocommerce_schedule_sale` | `productIds`, `discountPercent`, `startsAt`, `endsAt`, `decimals` |
| `woocommerce_end_sale` | `productIds` |
| `woocommerce_create_webhook` | `name`, `topic`, `deliveryUrl`, `status` |
| `woocommerce_update_webhook` | `id`, `name`, `status`, `deliveryUrl`, `rotateSecret` |
| `woocommerce_delete_webhook` | `id` |

Product fields are `name`, `type`, `status`, `regularPrice`, `salePrice`, sale dates, `description`, `shortDescription`, `sku`, `manageStock`, `stockQuantity`, `stockStatus`, `catalogVisibility`, `featured`, `virtual`, `downloadable`, `weight`, `dimensions`, `categories`, `tags`, `images`, and `externalUrl`.

Notes:

- **Refunds.** `apiRefund` defaults to `false`, which records the refund in WooCommerce without contacting the payment gateway. Set it to `true` to send money back through the gateway. `lineItems[].id` is the order line item id, not the product id.
- **Bulk price changes.** Prices are rounded half away from zero to `decimals` places (default 2). Variable and grouped products, products without a regular price, changes that would make a price zero or negative, and sale prices that would not be below the regular price are skipped and listed in `skipped`. `target: "sale"` sets the sale price from the regular price, for example `mode: "percent", change: -20` for a 20% sale.
- **Batch results.** Bulk tools return `updated` and `errors`; one failed product does not stop the others.
- **Sales.** `woocommerce_schedule_sale` sets the sale price to `discountPercent` off the regular price, with optional start and end dates, in one batch request. Variable and grouped products and products without a regular price are skipped. `woocommerce_end_sale` clears the sale price and both dates.
- **Fulfillment.** See [Fulfillment and tracking](#fulfillment-and-tracking).
- **Webhooks.** New webhooks are signed with the store's configured webhook secret, which never appears in arguments, results, previews, or the audit log. See [Webhooks](webhooks.md).

### Fulfillment and tracking

`woocommerce_fulfill_order` records a shipment, sets the order to `completed` (unless `markCompleted: false`), and adds a customer-visible note with the carrier, tracking number, and link (unless `notifyCustomer: false`). `shippedAt` defaults to today in UTC.

Where the shipment is stored depends on `WOOCOMMERCE_TRACKING_MODE`:

| Mode | Storage |
| --- | --- |
| `meta` (default) | The `woocommerce_mcp_tracking` order meta field holds a list of shipments. Works on any store. |
| `shipment-tracking` | The Shipment Tracking extension's REST API (`wc-shipment-tracking/v3`), so tracking also shows in its emails and the My Account page. |

`woocommerce_get_order_tracking` reads the shipments back in the same mode.

Fulfillment makes up to three requests. The confirmation preview shows the first one (the order update, or the tracking entry in `shipment-tracking` mode); the status change and the customer note follow when you confirm.

### Previews and confirmation

Each write tool also accepts:

- `dryRun: true`: always return a preview and send nothing
- `confirm: true`: apply the change
- `previewId`: the id from the preview being confirmed. The call is refused with `preview_mismatch` if the arguments differ from that preview, and with `stale_preview` if the store data the change was computed from has changed since

When confirmation is required (the default), a call without `confirm: true` returns:

```json
{
  "status": "confirmation_required",
  "store": "default",
  "previewId": "pv_4f1c9a2e7b3d0856",
  "message": "The change was NOT applied. Review the request below with the user, then call this tool again with the same arguments, confirm: true, and this previewId.",
  "request": {
    "method": "PUT",
    "path": "/products/42",
    "query": {},
    "body": { "regular_price": "24.00" }
  }
}
```

A dry run returns `"status": "dry_run"` with the same `request` and `previewId`. Pass `previewId` with `confirm: true` to have the server check that the confirmed arguments are the ones that were previewed; see [Preview ids](safe-writes.md#preview-ids). If the tool would not write anything, the status is `no_change`. Previews may read from the store, for example to compute new prices, but never write. When they do, the preview also has a `preconditions` block listing each record read, with `before` and `after` values for the fields the write sets, and the `previewId` has a second part that fingerprints that data. A confirm that sends this `previewId` is refused with `stale_preview` if the data changed; see [Stale previews](safe-writes.md#stale-previews). A confirm without `previewId` runs again and computes a bulk price change from the prices at that moment, as before.

A write to a read-only store fails with `read_only`. Over authenticated HTTP, a token without the `woocommerce:write` scope fails with `insufficient_scope`.

## Resources

| URI | Content |
| --- | --- |
| `woocommerce://stores` | Configured stores, the default store, and whether each is read-only |
| `woocommerce://stores/{store}/products/{id}` | One product |
| `woocommerce://stores/{store}/orders/{id}` | One order |
| `woocommerce://stores/{store}/events` | The 50 most recent webhook deliveries, without payloads |
| `woocommerce://stores/{store}/events/{id}` | One webhook delivery with its payload |

The `{store}` variable supports completion. Resources are JSON. For stores with `redactPii`, order and event resources are masked too.

## Prompts

| Prompt | Arguments | Purpose |
| --- | --- | --- |
| `sales_briefing` | `period` (`day`, `week`, `month`, `quarter`), `store` | Short briefing with trends, top products, and follow-ups |
| `restock_plan` | `threshold`, `days`, `store` | Restock list from current stock and recent sales |
| `order_triage` | `status` (`pending`, `processing`, `on-hold`), `store` | Review open orders and propose actions without changing them |
| `price_change_review` | `change`, `store` | Plan a price change, preview it, and wait for approval |
