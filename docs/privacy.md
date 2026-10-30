# Privacy

Orders and customer records contain personal data. woocommerce-mcp can mask it before it reaches the assistant, either for a whole store or for one call.

## Turn it on

| Scope | Setting |
| --- | --- |
| Every store | `WOOCOMMERCE_REDACT_PII=true` |
| One store | `"redactPii": true` in the store entry |
| One call | `redactPii: true` on `woocommerce_list_customers`, `woocommerce_get_customer`, `woocommerce_customer_orders`, and `woocommerce_customer_segments` |

A store setting applies to every tool result and to the order and webhook event resources. A call cannot turn masking off for a store that has it on.

## What is masked

| Data | Result |
| --- | --- |
| First, last, full, display, and user names; company | `[redacted]` |
| Street address lines and postcode | `[redacted]` |
| Customer IP address, user agent, and avatar URL | `[redacted]` |
| Email fields | First character and domain: `s***@example.com` |
| Phone fields | Last two digits: `***34` |
| Email addresses inside any other text, such as notes | Masked the same way as email fields |

City, state, country, order totals, and product data are kept, so reports and segments still work. Masked emails keep the domain, which is enough to spot business customers or typos without exposing the person.

## What is not masked

- **Write previews.** A preview echoes the arguments of the call, which the caller already has.
- **Free text you did not write.** Names typed into order notes or product reviews are only masked when they look like an email address.
- **WooCommerce itself.** Masking happens in this server. The REST API key can still read everything, so give it the narrowest permission that works (Read for reporting) and keep the audit log on.

## Other privacy controls

- Hide customer tools completely with `WOOCOMMERCE_TOOLS_DENY="*customer*"`; see [Configuration](configuration.md#tool-allow-and-deny-lists).
- The audit log records tool arguments for writes only, never read results.
- Webhook events stay in memory and are dropped on restart.
