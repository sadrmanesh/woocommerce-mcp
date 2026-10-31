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

   Calling the tool again with the same arguments and `confirm: true` applies it. `dryRun: true` always previews, even with confirmation turned off. Every preview carries a `previewId`; send it back with `confirm: true` and the server refuses the call with `preview_mismatch` if the arguments changed since the preview, or with `stale_preview` if the store data the change was computed from changed since. See [Stale previews](#stale-previews).
3. **Scopes.** Over authenticated HTTP, write tools also need the `woocommerce:write` scope. Read-only tokens can never change a store.
4. **Audit.** Set `WOOCOMMERCE_AUDIT_LOG` to a file path or `stderr`:

   ```json
   {"time":"2026-10-30T14:02:11.120Z","tool":"woocommerce_update_order_status","store":"default","outcome":"applied","arguments":{"id":1015,"status":"completed"},"client":"static:3f9a1c2b7d10","previewId":"pv_4f1c9a2e7b3d0856","previewMatch":true}
   ```

## Preview ids

A preview id links a confirmed write to the preview the user approved.

- Every `confirmation_required`, `dry_run`, and `no_change` response includes `previewId`, for example `pv_4f1c9a2e7b3d0856`. Its arguments part is `pv_` followed by the first 16 hex characters of a SHA-256 over the tool name, the store id, and the tool arguments serialized with sorted keys. `store`, `dryRun`, `confirm`, and `previewId` itself are not part of it.
- When the preview read store data to plan the write, the id has a second part, the state id: `pv_e2a742fe51c807fc_a3510d17b8a51b93`. See [Stale previews](#stale-previews). Tools that write without reading first, such as `woocommerce_create_product`, keep the one-part id.
- A confirm call may pass `previewId`. The server recomputes the arguments part from the call's own tool, store, and arguments. If it differs, the call is refused with `preview_mismatch` and nothing is sent to the store. This check runs first and reads nothing from the store.
- The audit entry for each write attempt carries `previewId`. When the caller supplied one, the entry also has `previewMatch`: `true` for an applied or failed write that matched its preview, `false` for a `preview_mismatch` refusal. When the id had a state part, the entry also has `stateMatch`. Previews and confirmed writes with the same `previewId` are the same change.
- `previewId` is optional. A confirm call without it still works as before, and its audit entry records the arguments part its call would have had, without `previewMatch` or `stateMatch`.

The id is a fingerprint, not a secret or a one-time token. The server keeps no record of issued previews, so it does not check that a preview was actually requested, how old it is, or whether it was already used. The same arguments and the same store data always give the same id, which also means a preview stays valid across restarts and between HTTP sessions.

## Stale previews

A write such as "raise prices by 10%" is computed from values in the store. If a price changes between the preview and the confirm, the same arguments would produce a different write. Since 0.5.0 the server detects this.

**At preview time** the tool runs on a planning client that reads fresh data, bypassing the read cache, and stops at the first write. Relative changes are resolved there, so the request already holds the absolute values. The preview adds a `preconditions` block that lists every record the plan read:

```json
{
  "status": "confirmation_required",
  "store": "default",
  "previewId": "pv_e2a742fe51c807fc_a3510d17b8a51b93",
  "request": { "method": "POST", "path": "products/batch", "query": {}, "body": { "update": [{ "id": 42, "regular_price": "22.00" }] } },
  "preconditions": {
    "stateId": "a3510d17b8a51b93",
    "recordCount": 1,
    "records": [
      {
        "resource": "products/42",
        "dateModified": "2026-10-30T09:12:44",
        "before": { "regular_price": "20.00" },
        "after": { "regular_price": "22.00" }
      }
    ],
    "note": "A confirm with this previewId is refused with stale_preview if these records change before it is applied."
  }
}
```

`before` holds the current values of the fields the write sets and `after` the values it will set. Up to 50 records are listed, with `truncated: true` beyond that; the state id always covers all of them.

The state id is the first 16 hex characters of a SHA-256 over every read the plan made: the path and query of each request, and for each record returned its id, its `date_modified`, the fields the write sets, and a fixed set of fields that writes are commonly computed from (`status`, `type`, `price`, `regular_price`, `sale_price`, the sale dates, `manage_stock`, `stock_quantity`, `stock_status`, and `total`). Other values, such as a payload that is not a record, are hashed whole.

**At confirm time**, when the `previewId` has a state part and its arguments part matches, the server plans the write again on fresh reads and recomputes the state id. If it differs, the call is refused before anything is written:

```json
{
  "error": {
    "code": "stale_preview",
    "message": "Refused to run woocommerce_bulk_adjust_prices: the store data this change was computed from has changed since the preview ... Call the tool again without confirm to get a fresh preview ...",
    "details": {
      "previewStateId": "a3510d17b8a51b93",
      "currentStateId": "8bed7e78cf74f185",
      "current": [
        { "resource": "products/42", "dateModified": "2026-10-30T09:20:03", "before": { "regular_price": "25.00" }, "after": { "regular_price": "27.50" } }
      ]
    }
  }
}
```

The audit log records it as `refused`, with `previewMatch: true`, `stateMatch: false`, and `stale` holding both state ids. The client should ask for a fresh preview, show it to the user, and confirm with the new id. When the state still matches, the write is applied and the entry has `stateMatch: true`.

`preview_mismatch` and `stale_preview` are separate on purpose: a mismatch means the caller changed what it asked for, a stale preview means the store changed underneath it. Arguments are checked first, so a call with both problems reports `preview_mismatch`.

### What is and is not guaranteed

- **Covered:** a change to any record the preview read, through its `date_modified` or one of the fingerprinted fields, a record that appeared in or disappeared from a read, and a plan that no longer writes at all.
- **Not covered:** changes in the store that the write was not computed from. Tools that write without reading, such as `woocommerce_update_order_status` or `woocommerce_create_product`, have no state part and behave as in 0.4.0.
- **Not a lock.** WooCommerce's REST API has no conditional writes, so a change that lands in the short gap between the server's check and its write is not detected. The check narrows the window from "whenever the user approves" to milliseconds; it does not close it.
- **Opt-in per call.** A confirm without `previewId`, or with a one-part id from 0.4.0, is not checked for staleness. Clients that want the guarantee should always send the `previewId` they received.
- Only the first write a tool plans is previewed. Tools that make several requests, such as `woocommerce_fulfill_order`, are checked against the data read before that first write.

Refunds created by `woocommerce_create_refund` are recorded as manual refunds unless `apiRefund: true` asks the payment gateway to return the money.
