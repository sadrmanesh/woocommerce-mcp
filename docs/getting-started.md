# Getting started

## Quick start

Node.js 20 or newer is required.

```bash
npm install -g woocommerce-mcp
```

Or from a checkout:

```bash
git clone https://github.com/sadrmanesh/woocommerce-mcp.git
cd woocommerce-mcp
npm install
npm run build
cp .env.example .env
```

Create a REST API key under **WooCommerce > Settings > Advanced > REST API**. Use a Read key while the store is read-only, and a Read/Write key only when you enable writes. WordPress permalinks must not be set to "Plain", or `/wp-json/` will not resolve.

```bash
WOOCOMMERCE_URL=https://store.example.com \
WOOCOMMERCE_CONSUMER_KEY=ck_... \
WOOCOMMERCE_CONSUMER_SECRET=cs_... \
woocommerce-mcp
```

The process then serves MCP on stdin and stdout. Logs go to stderr. `npm start` in a checkout loads `.env` from the working directory without overriding variables that are already set.

## Connect an MCP client

Most hosts accept an `mcpServers` map like the ones below. Keep secrets in `env`, never in `args`.

### stdio

```json
{
  "mcpServers": {
    "woocommerce": {
      "command": "npx",
      "args": ["-y", "woocommerce-mcp"],
      "env": {
        "WOOCOMMERCE_URL": "https://store.example.com",
        "WOOCOMMERCE_CONSUMER_KEY": "ck_your_consumer_key",
        "WOOCOMMERCE_CONSUMER_SECRET": "cs_your_consumer_secret"
      }
    }
  }
}
```

From a checkout, use `"command": "node"` and `"args": ["/absolute/path/to/woocommerce-mcp/dist/index.js"]`.

### Streamable HTTP

```bash
MCP_TRANSPORT=http MCP_HTTP_AUTH_TOKENS="$(openssl rand -base64 32)" woocommerce-mcp
```

```json
{
  "mcpServers": {
    "woocommerce": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Without authentication the HTTP endpoint only binds to loopback. See [Security and authentication](security.md) for tokens, scopes, and OAuth introspection.
