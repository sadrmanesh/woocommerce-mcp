# Safe writes

Writes to a live store are opt-in, previewed, scoped, and audited, and can require a signed approval. These layers work together.

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
5. **Signed approvals (optional).** With `WOOCOMMERCE_APPROVAL_SECRET` set, a confirm also needs a short-lived, single-use token signed outside the agent's reach for that exact `previewId`. See [Signed approvals](#signed-approvals).

## Preview ids

A preview id links a confirmed write to the preview the user approved.

- Every `confirmation_required`, `dry_run`, and `no_change` response includes `previewId`, for example `pv_4f1c9a2e7b3d0856`. Its arguments part is `pv_` followed by the first 16 hex characters of a SHA-256 over the tool name, the store id, and the tool arguments serialized with sorted keys. `store`, `dryRun`, `confirm`, and `previewId` itself are not part of it.
- When the preview read store data to plan the write, the id has a second part, the state id: `pv_e2a742fe51c807fc_a3510d17b8a51b93`. See [Stale previews](#stale-previews). Tools that write without reading first, such as `woocommerce_create_product`, keep the one-part id.
- A confirm call may pass `previewId`. The server recomputes the arguments part from the call's own tool, store, and arguments. If it differs, the call is refused with `preview_mismatch` and nothing is sent to the store. This check runs first and reads nothing from the store.
- The audit entry for each write attempt carries `previewId`. When the caller supplied one, the entry also has `previewMatch`: `true` for an applied or failed write that matched its preview, `false` for a `preview_mismatch` refusal. When the id had a state part, the entry also has `stateMatch`. Previews and confirmed writes with the same `previewId` are the same change.
- `previewId` is optional. A confirm call without it still works as before, and its audit entry records the arguments part its call would have had, without `previewMatch` or `stateMatch`.

The id is a fingerprint, not a secret or a one-time token. For a one-time, signed approval of a preview, see [Signed approvals](#signed-approvals). The server keeps no record of issued previews, so it does not check that a preview was actually requested, how old it is, or whether it was already used. The same arguments and the same store data always give the same id, which also means a preview stays valid across restarts and between HTTP sessions.

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

## Signed approvals

Preview ids bind *what* is confirmed: the arguments and the store data the change was computed from. They do not bind *who* confirmed it. Without signed approvals the server cannot tell a confirm sent after a person read the preview from one the same agent sent right after asking for the preview. The two-step flow then depends on the client following the server instructions, and the audit log is a record, not a gate.

Since 0.6.0 a deployment can close that gap. Set `WOOCOMMERCE_APPROVAL_SECRET` and every confirmed write also needs an `approval` token: an HMAC-SHA256 signature, made with that secret, over the exact `previewId`, tool, store, and an expiry. The agent never holds the secret, so it cannot produce a token. A person, or a system acting for one, signs it after reviewing the preview.

The mode is opt-in. Without `WOOCOMMERCE_APPROVAL_SECRET` nothing changes: tools do not list the `approval` field and confirms work as in 0.5.0.

### Flow

1. The agent calls a write tool and gets `confirmation_required` with a `previewId`, as before.
2. The person approves that `previewId` out of band, for example in a terminal on the server host:

   ```bash
   woocommerce-mcp approve pv_e2a742fe51c807fc_a3510d17b8a51b93 --by "Naser"
   ```

   The command reads the preview from the audit log when `WOOCOMMERCE_AUDIT_LOG` is a file, shows the tool, store, arguments, request, and the `before` and `after` value of each record, and asks `Approve this change? [y/N]`. On yes it prints the token on stdout. Without the audit log entry, pass `--tool` (and `--store` when it is not the default) and check the change against the preview the agent showed you.
3. The person gives the token to the agent, which calls the tool again with the same arguments, `confirm: true`, the `previewId`, and `approval`.
4. The server checks the token, then the preview as usual (`preview_mismatch`, `stale_preview`), then writes.

### Checks and errors

| Code | Meaning |
| --- | --- |
| `approval_required` | A confirm came without `approval`, or without the `previewId` the approval is bound to. |
| `approval_invalid` | The token is malformed, its signature does not verify, it was issued in the future, or it is valid for longer than `WOOCOMMERCE_APPROVAL_TTL_SECONDS`. |
| `approval_expired` | The token's expiry has passed. |
| `approval_mismatch` | The token was signed for a different `previewId`, tool, or store. An approval for "+10%" cannot be used for "+50%". |
| `approval_replayed` | The token id was already used. |

All of them refuse the call before anything is written, and are logged as `refused`. Signatures are compared in constant time.

- **Bound to the exact preview.** The token covers the full `previewId`, including its state part, so it cannot be moved to other arguments or to a changed store. A confirm with a one-part id for a change that is computed from store data is refused with `preview_mismatch`, so an agent cannot drop the state part to skip the stale check. Stale previews are still refused with `stale_preview` after the approval is verified.
- **Single use.** A token is spent the first time a correctly signed, unexpired, matching token is presented, even if the call is then refused as stale or the store returns an error. Ask for a new preview and a new approval in that case. Spent token ids are kept in memory until their expiry.
- **Short lived.** Tokens are valid for 600 seconds by default. `WOOCOMMERCE_APPROVAL_TTL_SECONDS` sets the server maximum (30 to 3600), and `approve --ttl` can ask for less.
- **Confirmation is implied.** With signed approvals on, writes always preview first, even with `WOOCOMMERCE_REQUIRE_CONFIRMATION=false`.
- **Audited.** Confirm entries get an `approval` object: `mode: "signed"`, `result` (`verified`, `missing`, `invalid`, `expired`, `mismatch`, or `replayed`), the token id, and the approver label from `--by`. The token itself is never logged. Preview entries also keep the `preconditions` records, so `approve` can show them.

```json
{"time":"2026-11-01T09:14:02.511Z","tool":"woocommerce_bulk_adjust_prices","store":"default","outcome":"applied","arguments":{"productIds":[42],"mode":"percent","change":10},"previewId":"pv_e2a742fe51c807fc_a3510d17b8a51b93","previewMatch":true,"stateMatch":true,"approval":{"mode":"signed","result":"verified","tokenId":"q3J0bD1x8aZ2c9Wm4Tn7Vg","by":"Naser"}}
```

### Token format

Any system that holds the secret can sign approvals, such as an approval page, a chat bot button, or a webhook. A token is three dot-separated parts:

```text
wmcp1.<payload>.<signature>
```

- `payload` is the base64url (no padding) of a JSON object: `v` (always `1`), `previewId`, `tool`, `store`, `iat` and `exp` (Unix seconds), `jti` (8 to 64 characters of `A-Z a-z 0-9 _ -`, unique per token), and optional `by` (up to 100 characters).
- `signature` is the base64url (no padding) of `HMAC-SHA256(secret, "wmcp1." + payload)`.

```json
{"v":1,"previewId":"pv_e2a742fe51c807fc_a3510d17b8a51b93","tool":"woocommerce_bulk_adjust_prices","store":"default","iat":1793524442,"exp":1793525042,"jti":"q3J0bD1x8aZ2c9Wm4Tn7Vg","by":"Naser"}
```

In Node.js the package exports the same signer:

```js
import { signApproval } from '@sadrmanesh/woocommerce-mcp';

const { token } = signApproval(process.env.WOOCOMMERCE_APPROVAL_SECRET, {
  previewId, tool, store, by: 'Naser', ttlSeconds: 300,
});
```

### Keep the secret away from the agent

The guarantee only holds while the agent cannot read the secret.

- Do not put `WOOCOMMERCE_APPROVAL_SECRET` in an MCP client config file, a prompt, or a file the agent can open. For a local stdio server, a client config is often readable by the agent; prefer the HTTP transport with the server running as a separate service, and pass the secret through that service's environment or secret store.
- Do not give the agent a shell on the host that holds the secret, or it can run `woocommerce-mcp approve` itself. Run `approve` on a machine or account the agent cannot reach.
- Generate it with `openssl rand -base64 32` (32 characters or more). Rotating it invalidates every outstanding token.

### What this is not

- **Not proof of a specific person.** Whoever holds the secret can approve. The token proves that something outside the agent's reach signed off on this exact change, not who pressed the button. Use `--by` and your own access controls for that.
- **Not shared across replicas or restarts.** Spent token ids live in one server process. Behind several replicas, or across a restart, a token could be accepted once per process until it expires. Keep the TTL short, or run a single writer.
- **Not MCP elicitation.** Elicitation, where the server asks the user directly through the client, is a possible complementary mode for later. It shows that a person was asked, but it still trusts the client to render the question honestly, so a signed approval is the stronger check.
- The stale preview limits above still apply: the check narrows the gap between approval and write, it is not a lock.

Refunds created by `woocommerce_create_refund` are recorded as manual refunds unless `apiRefund: true` asks the payment gateway to return the money.
