# Install

woocommerce-mcp works with any MCP host that can start a stdio server or connect to a Streamable HTTP endpoint. Pick the option that fits where the host runs.

| Option | Best for |
| --- | --- |
| [npx](#npx) | A desktop host on a machine with Node.js 20 or newer |
| [Docker](#docker) | Hosts without Node.js, or isolated deployments |
| [Smithery](#smithery) | Hosts that install servers from the Smithery catalog |
| [MCP Registry](#mcp-registry) | Hosts and catalogs that read the official MCP Registry |
| [HTTP](#remote-http) | One shared server for several users or hosts |

Every option needs a WooCommerce REST API key; see [Getting started](getting-started.md#quick-start). Start with a Read key and the default read-only mode.

## npx

Add this to your host's MCP server settings. Most hosts use an `mcpServers` map in a JSON file.

```json
{
  "mcpServers": {
    "woocommerce": {
      "command": "npx",
      "args": ["-y", "@sadrmanesh/woocommerce-mcp"],
      "env": {
        "WOOCOMMERCE_URL": "https://store.example.com",
        "WOOCOMMERCE_CONSUMER_KEY": "ck_your_consumer_key",
        "WOOCOMMERCE_CONSUMER_SECRET": "cs_your_consumer_secret"
      }
    }
  }
}
```

Pin a version with `"@sadrmanesh/woocommerce-mcp@0.3.1"` to control upgrades. Add any variable from [Configuration](configuration.md) to `env`, for example `"WOOCOMMERCE_REDACT_PII": "true"`.

## Docker

```bash
git clone https://github.com/sadrmanesh/woocommerce-mcp.git
docker build -t woocommerce-mcp woocommerce-mcp
```

```json
{
  "mcpServers": {
    "woocommerce": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "MCP_TRANSPORT=stdio",
        "-e", "WOOCOMMERCE_URL",
        "-e", "WOOCOMMERCE_CONSUMER_KEY",
        "-e", "WOOCOMMERCE_CONSUMER_SECRET",
        "woocommerce-mcp"
      ],
      "env": {
        "WOOCOMMERCE_URL": "https://store.example.com",
        "WOOCOMMERCE_CONSUMER_KEY": "ck_your_consumer_key",
        "WOOCOMMERCE_CONSUMER_SECRET": "cs_your_consumer_secret"
      }
    }
  }
}
```

`-e NAME` without a value passes the variable through from `env`, so secrets stay out of `args`. For a long-running HTTP server, see [Deployment](deployment.md).

## Smithery

The repository includes a `smithery.yaml`. Smithery builds the Docker image and asks for:

| Field | Maps to |
| --- | --- |
| `storeUrl` | `WOOCOMMERCE_URL` |
| `consumerKey` | `WOOCOMMERCE_CONSUMER_KEY` |
| `consumerSecret` | `WOOCOMMERCE_CONSUMER_SECRET` |
| `readOnly` | `WOOCOMMERCE_READ_ONLY`, default `true` |
| `redactPii` | `WOOCOMMERCE_REDACT_PII`, default `false` |
| `denyTools` | `WOOCOMMERCE_TOOLS_DENY`, for example `delete_*` |

The server always runs over stdio there.

## MCP Registry

The server is listed on the official [MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.sadrmanesh/woocommerce-mcp). `server.json` describes it under the name `io.github.sadrmanesh/woocommerce-mcp`. It points to the `@sadrmanesh/woocommerce-mcp` npm package, started with `npx` over stdio, and lists the environment variables a host should ask for. The `mcpName` field in `package.json` proves the npm package belongs to that name.

Hosts that read the registry can install the server from it. To publish a new version, a maintainer updates the version in `server.json` (a test checks that it matches `package.json`) and pushes a version tag. The release workflow publishes the package to npm, then signs in to the registry with GitHub OIDC and runs `mcp-publisher publish`, so no registry token is stored in the repository.

## Remote HTTP

Run one server and point hosts at it:

```bash
MCP_TRANSPORT=http MCP_HTTP_AUTH_TOKENS="$(openssl rand -base64 32)" npx -y @sadrmanesh/woocommerce-mcp
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

HTTP is also required for the [webhook receiver](webhooks.md). See [Security and authentication](security.md) before exposing it.

## Check the install

Ask the assistant to "list the WooCommerce stores". It calls `woocommerce_list_stores`, which shows each store, whether it is read-only, and which features are on, without contacting the store. Then ask for "the last five orders" to test the API key.
