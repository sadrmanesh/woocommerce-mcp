# Security and authentication

## Store credentials

The server holds WooCommerce consumer keys only in memory. Give each store the narrowest key that works: a **Read** key for read-only stores, and a **Read/Write** key only for stores where you set `readOnly: false`. Customer and order tools return personal data, so protect the server the way you protect store admin access, and turn on [PII redaction](privacy.md) when the assistant does not need names and addresses.

Over `https://` the client uses HTTP Basic auth. Over plain `http://` it signs requests with OAuth 1.0a (HMAC-SHA1), as WooCommerce requires. `query` mode puts the secret in the URL and is only for hosts that strip the `Authorization` header; the server warns when a configuration would expose a secret.

## Write controls

Writes pass four checks, in order:

1. The token has the `woocommerce:write` scope (HTTP with authentication only).
2. The target store is not read-only.
3. The call has `confirm: true`, unless confirmation is turned off. `dryRun: true` always stops here with a preview.
4. The WooCommerce key has write permission.

Each write attempt is recorded in the audit log when `WOOCOMMERCE_AUDIT_LOG` is set, including refused and failed attempts. Entries contain the tool arguments, which can include customer notes or prices, so store the file with the same care as the store data.

## Limit the tools

Remove tools a deployment does not need with `WOOCOMMERCE_TOOLS_ALLOW` and `WOOCOMMERCE_TOOLS_DENY`, or per store with `allowTools` and `denyTools`. A hidden tool is not listed, so the assistant cannot call it or be talked into calling it. For example, `WOOCOMMERCE_TOOLS_DENY="delete_*,*webhook*"` removes every delete tool and all webhook management. See [Configuration](configuration.md#tool-allow-and-deny-lists).

## Webhook receiver

The [webhook receiver](webhooks.md) accepts deliveries without a bearer token, because WooCommerce cannot send one. Instead each delivery must carry a valid HMAC-SHA256 signature made with the store's webhook secret, compared in constant time. Stores without a secret have no receiver. Bodies over 1 MB are refused, and only the newest deliveries are kept in memory.

Use a random secret of 32 bytes or more, keep it in an environment variable referenced by `webhookSecretEnv`, and rotate it by changing the variable, restarting, and calling `woocommerce_update_webhook` with `rotateSecret: true` for each webhook. Tool results and previews never contain the secret.

## HTTP authentication

Without authentication the HTTP endpoint can bind only to `127.0.0.1`, `localhost`, or `::1`, and checks `Host` and `Origin` headers against loopback names to block DNS rebinding. Configure authentication to expose it further.

### Static bearer tokens

```bash
MCP_HTTP_AUTH_TOKENS=<token>[,<token>...]        # scopes: woocommerce:read woocommerce:write
MCP_HTTP_AUTH_READ_TOKENS=<token>[,<token>...]   # scope:  woocommerce:read
```

Tokens must be at least 24 characters without whitespace. Generate them with `openssl rand -base64 32`. They are compared as SHA-256 digests in constant time. The audit log identifies the caller as `static:<first 12 hex characters of the digest>`, never the token.

### OAuth 2.0 token introspection

To accept access tokens from an existing authorization server, configure RFC 7662 introspection:

| Variable | Description |
| --- | --- |
| `MCP_OAUTH_ISSUER` | Authorization server issuer URL. Required, and advertised to clients. |
| `MCP_OAUTH_INTROSPECTION_URL` | Introspection endpoint (https, or http on localhost) |
| `MCP_OAUTH_CLIENT_ID` / `MCP_OAUTH_CLIENT_SECRET` | Credentials this server uses to call the endpoint |
| `MCP_OAUTH_RESOURCE` | Optional. Public URL of the MCP endpoint. When set, tokens must carry it as their audience (`aud`). |
| `MCP_OAUTH_REQUIRED_SCOPES` | Optional. Comma-separated scopes every request needs |

Active tokens are cached for up to 60 seconds, never past their `exp`. Tokens without `exp` are rejected. Issue the `woocommerce:read` and `woocommerce:write` scopes from your authorization server; a token without `woocommerce:write` can read but not write. Static tokens and introspection can be combined.

### Discovery

With authentication on, the server publishes RFC 9728 protected resource metadata at `/.well-known/oauth-protected-resource<path>` (for example `/.well-known/oauth-protected-resource/mcp`) and points to it from the `WWW-Authenticate` header of every `401` and `403` response. MCP clients use it to find the authorization server.

### Behind a proxy

Terminate TLS at a reverse proxy and forward to the container. Add the public host name to `MCP_HTTP_ALLOWED_HOSTS` if you want the server to check it, and set `MCP_OAUTH_RESOURCE` to the public `https://` URL so discovery documents use it. Browser-based clients also need their origin in `MCP_HTTP_ALLOWED_ORIGINS`.

## Reporting a vulnerability

Email <info.sadrmanesh@gmail.com> with details. Please do not open a public issue for security problems.
