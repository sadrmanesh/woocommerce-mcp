# Safe writes

Writes to a live store are opt-in, previewed, scoped, and audited. These four layers work together.

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
