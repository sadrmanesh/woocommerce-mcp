# Webhooks

woocommerce-mcp can manage WooCommerce webhooks and receive their deliveries, so an assistant can react to new orders, stock changes, or customer sign-ups without polling.

There are two parts:

1. **Webhook tools** create, list, update, and delete webhooks in WooCommerce.
2. **The receiver** is an HTTP endpoint on this server that verifies each delivery and keeps recent ones in memory, where tools and resources can read them.

## Set a webhook secret

Each store that receives webhooks needs its own secret of 16 characters or more. WooCommerce signs every delivery with it, and the receiver rejects anything that does not match.

```bash
# One store
WOOCOMMERCE_WEBHOOK_SECRET="$(openssl rand -base64 32)"
```

For several stores, set `webhookSecretEnv` (or `webhookSecret`) on each store entry; see [Configuration](configuration.md#several-stores).

The secret never leaves the server: `woocommerce_create_webhook` reads it from config, previews show `[configured secret]`, and webhook records are returned without it.

## Run the receiver

The receiver runs only with the HTTP transport (`MCP_TRANSPORT=http`), at:

```text
https://<your server><WOOCOMMERCE_WEBHOOK_PATH>/<store id>
```

The default path is `/webhooks/woocommerce`, so the `default` store receives at `/webhooks/woocommerce/default`. WooCommerce must be able to reach this URL, and the webhook tools accept only `https` delivery URLs, so put the server behind a TLS proxy (see [Deployment](deployment.md)). If you use `MCP_HTTP_ALLOWED_HOSTS`, include the public host name.

Deliveries are authenticated by their HMAC signature, not by the MCP bearer token, because WooCommerce cannot send one. The receiver answers:

| Status | When |
| --- | --- |
| `202` | Signature valid; the delivery is stored |
| `200` | The `webhook_id=...` ping WooCommerce sends when a webhook is saved; nothing is stored |
| `401` | Missing or wrong `X-WC-Webhook-Signature` |
| `404` | Unknown store, or a store without a webhook secret |
| `405` | Not a `POST` |
| `413` | Body larger than 1 MB |

## Create a webhook

Ask for it in plain language, for example "Send new orders from the EU store to the server", or call the tool directly:

```json
{
  "name": "New orders",
  "topic": "order.created",
  "deliveryUrl": "https://mcp.example.com/webhooks/woocommerce/eu",
  "store": "eu",
  "confirm": true
}
```

Topics are `coupon.*`, `customer.*`, `order.*`, and `product.*` with `created`, `updated`, `deleted`, and (for coupons, orders, and products) `restored`. `woocommerce_update_webhook` can pause, resume, or disable a webhook, change its URL, and with `rotateSecret: true` set its secret to the store's current configured secret after you change it.

## Read events

Deliveries are kept in memory, newest first, up to `WOOCOMMERCE_WEBHOOK_BUFFER` per store (default 200). They are lost when the server restarts. For durable processing, point a second webhook at your own queue.

- `woocommerce_list_webhook_events` lists them. Filter with `topic` (`order.created` or `order.*`), and poll for new ones with `sinceId` set to the largest `id` you have seen. Payloads are included only with `includePayload: true`.
- `woocommerce://stores/{store}/events` lists the 50 most recent without payloads.
- `woocommerce://stores/{store}/events/{id}` returns one delivery with its payload.

Each event has `id`, `store`, `topic`, `resourceId` (the order, product, customer, or coupon id), `webhookId`, and `receivedAt`. For stores with `redactPii`, payloads are masked when read.

## Test a delivery

```bash
body='{"id":123,"status":"processing"}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$WOOCOMMERCE_WEBHOOK_SECRET" -binary | base64)
curl -i -X POST "http://127.0.0.1:3000/webhooks/woocommerce/default" \
  -H 'content-type: application/json' \
  -H "x-wc-webhook-topic: order.created" \
  -H "x-wc-webhook-signature: $sig" \
  --data "$body"
```
