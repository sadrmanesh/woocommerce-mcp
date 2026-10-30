# Tools, resources, and prompts

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
| `woocommerce_list_customers` | `search`, `email`, `role`, `orderBy`, `order` |
| `woocommerce_get_customer` | `id` |
| `woocommerce_get_stock` | `productId`, `variationId` |
| `woocommerce_list_coupons` | `search`, `code`, `after`, `before`, `orderBy`, `order` |
| `woocommerce_get_store_summary` | `period` (`week`, `month`, `last_month`, `year`) or `dateMin` and `dateMax` |
| `woocommerce_sales_analytics` | `after`, `before`, `statuses`, `groupBy` (`day`, `week`, `month`), `top`, `maxOrders` |
| `woocommerce_low_stock_report` | `threshold`, `includeOutOfStock`, `maxProducts` |

### Sales analytics

`woocommerce_sales_analytics` reads orders in the range (by default `processing` and `completed`) and returns:

- `orders`, `itemsSold`, `grossSales`, `discounts`, `shipping`, `tax`, `refunds`, `netSales`, and `averageOrderValue`
- `series`: orders and total per day, week (starting Monday), or month, in UTC
- `byStatus`, `paymentMethods`, and `topProducts` (by revenue)

Amounts are added in fixed point, so totals do not drift. Up to `maxOrders` orders (default 1000, maximum 5000) are read; when there are more, `truncated` is `true`. Use a shorter range or raise `maxOrders`.

### Low stock report

`woocommerce_low_stock_report` scans published products (up to `maxProducts`, default 500) and returns those that track stock at or below `threshold` (default 5), plus out-of-stock products, sorted by quantity. Stock tracked on individual variations is not scanned; use `woocommerce_get_stock` for those.

## Write tools

| Tool | Main arguments |
| --- | --- |
| `woocommerce_create_product` | `name` and product fields |
| `woocommerce_update_product` | `id` and product fields |
| `woocommerce_bulk_update_products` | `updates`: up to 100 of `{ id, regularPrice, salePrice, stockQuantity, stockStatus, manageStock, status }` |
| `woocommerce_bulk_adjust_prices` | `productIds`, `mode` (`percent`, `fixed`), `change`, `target` (`regular`, `sale`), `decimals` |
| `woocommerce_update_order_status` | `id`, `status` |
| `woocommerce_add_order_note` | `orderId`, `note`, `customerNote` |
| `woocommerce_create_refund` | `orderId`, `amount` or `lineItems`, `reason`, `apiRefund`, `restockItems` |
| `woocommerce_update_stock` | `productId`, `variationId`, `stockQuantity`, `manageStock`, `stockStatus` |
| `woocommerce_create_coupon` | `code`, `amount`, `discountType`, `dateExpires`, limits and restrictions |

Product fields are `name`, `type`, `status`, `regularPrice`, `salePrice`, sale dates, `description`, `shortDescription`, `sku`, `manageStock`, `stockQuantity`, `stockStatus`, `catalogVisibility`, `featured`, `virtual`, `downloadable`, `weight`, `dimensions`, `categories`, `tags`, `images`, and `externalUrl`.

Notes:

- **Refunds.** `apiRefund` defaults to `false`, which records the refund in WooCommerce without contacting the payment gateway. Set it to `true` to send money back through the gateway. `lineItems[].id` is the order line item id, not the product id.
- **Bulk price changes.** Prices are rounded half away from zero to `decimals` places (default 2). Variable and grouped products, products without a regular price, changes that would make a price zero or negative, and sale prices that would not be below the regular price are skipped and listed in `skipped`. `target: "sale"` sets the sale price from the regular price, for example `mode: "percent", change: -20` for a 20% sale.
- **Batch results.** Bulk tools return `updated` and `errors`; one failed product does not stop the others.

### Previews and confirmation

Each write tool also accepts:

- `dryRun: true`: always return a preview and send nothing
- `confirm: true`: apply the change

When confirmation is required (the default), a call without `confirm: true` returns:

```json
{
  "status": "confirmation_required",
  "store": "default",
  "message": "The change was NOT applied. Review the request below with the user, then call this tool again with the same arguments and confirm: true.",
  "request": {
    "method": "PUT",
    "path": "/products/42",
    "query": {},
    "body": { "regular_price": "24.00" }
  }
}
```

A dry run returns `"status": "dry_run"` with the same `request`. If the tool would not write anything, the status is `no_change`. Previews may read from the store, for example to compute new prices, but never write. Because the confirmed call runs again, a bulk price change is computed from the prices at that moment.

A write to a read-only store fails with `READ_ONLY_MODE`. Over authenticated HTTP, a token without the `woocommerce:write` scope fails with `FORBIDDEN`.

## Resources

| URI | Content |
| --- | --- |
| `woocommerce://stores` | Configured stores, the default store, and whether each is read-only |
| `woocommerce://stores/{store}/products/{id}` | One product |
| `woocommerce://stores/{store}/orders/{id}` | One order |

The `{store}` variable supports completion. Resources are JSON.

## Prompts

| Prompt | Arguments | Purpose |
| --- | --- | --- |
| `sales_briefing` | `period` (`day`, `week`, `month`, `quarter`), `store` | Short briefing with trends, top products, and follow-ups |
| `restock_plan` | `threshold`, `days`, `store` | Restock list from current stock and recent sales |
| `order_triage` | `status` (`pending`, `processing`, `on-hold`), `store` | Review open orders and propose actions without changing them |
| `price_change_review` | `change`, `store` | Plan a price change, preview it, and wait for approval |
