# Observability

## Logs

The server logs to stderr only, so stdout stays reserved for the stdio transport. `WOOCOMMERCE_DEBUG=true` adds one line per WooCommerce request with the method and API path; query strings and credentials are never logged.

## Audit log

`WOOCOMMERCE_AUDIT_LOG=/path/to/audit.jsonl` (or `stderr`) records one JSON object per write attempt:

| Field | Description |
| --- | --- |
| `time` | ISO-8601 timestamp |
| `tool` | Tool name |
| `store` | Store id |
| `outcome` | `applied`, `dry_run`, `confirmation_required`, `refused`, or `failed` |
| `arguments` | Tool arguments, without `store`, `dryRun`, `confirm`, and `previewId` |
| `request` | Method and path of the planned request, for previews |
| `previewId` | Fingerprint of tool, store, and arguments. Previews return it; a confirm call can send it back. See [Preview ids](safe-writes.md#preview-ids) |
| `previewMatch` | Only when the call supplied a `previewId`: whether it matched the arguments |
| `error` | Error code and message, for `refused` and `failed` |
| `client` | Token client id, over authenticated HTTP |

A write failure in the audit log is reported once on stderr and never fails the tool call.

## OpenTelemetry tracing

Tracing uses the OpenTelemetry API, which is always installed and costs nothing when no SDK is registered. To export traces, install the optional SDK packages next to the server and enable it:

```bash
npm install @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources @opentelemetry/context-async-hooks
WOOCOMMERCE_OTEL_ENABLED=true \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_SERVICE_NAME=woocommerce-mcp \
woocommerce-mcp
```

The Docker image includes them when built with `--build-arg OTEL=true`.

Spans:

| Span | Attributes |
| --- | --- |
| `tool <name>` | `mcp.tool.name`, `mcp.tool.write`, `woocommerce.store`, `woocommerce.write.outcome` |
| `woocommerce <METHOD>` | `http.request.method`, `woocommerce.path` (ids replaced with `{id}`), `server.address`, `http.response.status_code` |

Failed operations record the exception and set the span status to error. Spans are batched and flushed on shutdown.

If your process already registers an OpenTelemetry SDK (for example with `--import @opentelemetry/auto-instrumentations-node/register`), leave `WOOCOMMERCE_OTEL_ENABLED` off; the server's spans go to the provider you registered.
