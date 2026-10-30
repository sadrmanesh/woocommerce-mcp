# Performance

Every store gets its own rate limiter, retry policy, and optional response cache. They protect the store from bursts of tool calls and make repeated questions cheaper.

## Rate limiting

Requests to a store pass through a token bucket: up to `WOOCOMMERCE_RATE_BURST` requests (default 10) go out at once, then requests are spaced to `WOOCOMMERCE_RATE_LIMIT` per second (default 5). Calls wait their turn instead of failing, so a large report is slower but does not trip the host's own limits. Retries count against the limit too.

Shared hosting often needs a lower rate, for example `WOOCOMMERCE_RATE_LIMIT=2`. Set it to `0` to turn the limiter off.

## Retries and backoff

| Request | Retried on |
| --- | --- |
| Reads (`GET`) | HTTP 408, 429, 502, 503, 504, timeouts, network errors |
| Writes | HTTP 429 only, because a 5xx may mean the change was applied |

Up to `WOOCOMMERCE_MAX_RETRIES` extra attempts (default 2) are made. The wait before attempt `n` uses exponential backoff with equal jitter:

```text
ceiling = min(WOOCOMMERCE_RETRY_MAX_MS, WOOCOMMERCE_RETRY_BASE_MS * 2^n)
wait    = ceiling / 2 + random(0, ceiling / 2)
```

With the defaults the waits are about 125 to 250 ms, then 250 to 500 ms. When the store sends `Retry-After`, that value is used instead. A `Retry-After` longer than `WOOCOMMERCE_RETRY_MAX_MS` is not waited for: the tool returns a `rate_limited` error with `retryAfterMs` so the assistant can tell the user.

## Caching

Read responses can be cached in memory for `WOOCOMMERCE_CACHE_TTL_MS` milliseconds. Caching is off by default, because stock and order status change all the time.

```bash
WOOCOMMERCE_CACHE_TTL_MS=30000      # 30 seconds
WOOCOMMERCE_CACHE_MAX_ENTRIES=500   # per store, least recently used are dropped
```

- The key is the REST namespace, path, and query, so different pages and filters are cached separately.
- Any write to a store, including a failed one, clears that store's cache, so a read after a change sees fresh data.
- Changes made elsewhere (in wp-admin, by customers, or by other servers) are visible after the TTL at most.
- Callers get a copy, so a tool can never change a cached response.

A short TTL helps most for analytics prompts that call several tools over the same orders. `woocommerce_list_stores` shows the cache hits, misses, and size for each store.

## Large reports

Analytics, segment, and stock tools page through the REST API 100 records at a time and stop at their `maxOrders`, `maxProducts`, or `maxVariations` limit with `truncated: true`. Prefer shorter date ranges over higher limits on busy stores.
