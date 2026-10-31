# Safe writes

Writes to a live store are opt-in, previewed, scoped, and audited. These four layers work together.

1. **Read-only stores.** A store accepts writes only when `WOOCOMMERCE_READ_ONLY=false` (single store) or `"readOnly": false` (store list). Otherwise write tools fail with `read_only` before contacting the store.
2. **Confirmation.** With `WOOCOMMERCE_REQUIRE_CONFIRMATION=true` (the default), the first call returns the planned request and changes nothing:

   ```json
   {
     "status": "confirmation_required",
     "store": "default",
     "previewId": "pv_4f1c9a2e7b3d0856",
     "message": "The change was NOT applied. ...",
     "request": { "method": "PUT", "path": "orders/1015", "query": {}, "body": { "status": "completed" } }
   }
   ```

   Calling the tool again with the same arguments and `confirm: true` applies it. `dryRun: true` always previews, even with confirmation turned off. Every preview carries a `previewId`; send it back with `confirm: true` and the server refuses the call if the arguments changed since the preview.
3. **Scopes.** Over authenticated HTTP, write tools also need the `woocommerce:write` scope. Read-only tokens can never change a store.
4. **Audit.** Set `WOOCOMMERCE_AUDIT_LOG` to a file path or `stderr`:

   ```json
   {"time":"2026-10-30T14:02:11.120Z","tool":"woocommerce_update_order_status","store":"default","outcome":"applied","arguments":{"id":1015,"status":"completed"},"client":"static:3f9a1c2b7d10","previewId":"pv_4f1c9a2e7b3d0856","previewMatch":true}
   ```

## Preview ids

A preview id links a confirmed write to the preview the user approved.

- Every `confirmation_required`, `dry_run`, and `no_change` response includes `previewId`, for example `pv_4f1c9a2e7b3d0856`. It is `pv_` followed by the first 16 hex characters of a SHA-256 over the tool name, the store id, and the tool arguments serialized with sorted keys. `store`, `dryRun`, `confirm`, and `previewId` itself are not part of it.
- A confirm call may pass `previewId`. The server recomputes the id from the call's own tool, store, and arguments. If it differs, the call is refused with `preview_mismatch` and nothing is sent to the store.
- The audit entry for each write attempt carries `previewId`. When the caller supplied one, the entry also has `previewMatch`: `true` for an applied or failed write that matched its preview, `false` for a `preview_mismatch` refusal. Previews and confirmed writes with the same `previewId` are the same change.
- `previewId` is optional. A confirm call without it still works as before, and its audit entry records the id its arguments would have had, without `previewMatch`.

The id is a fingerprint, not a secret or a one-time token. The server keeps no record of issued previews, so it does not check that a preview was actually requested, how old it is, or whether it was already used. The same arguments always give the same id, which also means a preview stays valid across restarts and between HTTP sessions. Because the confirmed call runs again, values the tool reads from the store, such as current prices for a bulk change, can still differ from the preview.

Refunds created by `woocommerce_create_refund` are recorded as manual refunds unless `apiRefund: true` asks the payment gateway to return the money.
