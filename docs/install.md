# Install

woocommerce-mcp works with any MCP host that can start a stdio server or connect to a Streamable HTTP endpoint. Pick the option that fits where the host runs.

| Option | Best for |
| --- | --- |
| [npx](#npx) | A desktop host on a machine with Node.js 20 or newer |
| [Docker](#docker) | Hosts without Node.js, or isolated deployments |
| [GitHub Packages](#github-packages) | Teams that already install npm packages from GitHub |
| [Smithery](#smithery) | Hosts that install servers from the Smithery catalog |
| [MCP Registry](#mcp-registry) | Hosts and catalogs that read the official MCP Registry |
| [Directories](#directories) | Browsing the listing on Glama or mcpservers.org |
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

Pin a version with `"@sadrmanesh/woocommerce-mcp@0.5.0"` to control upgrades. Add any variable from [Configuration](configuration.md) to `env`, for example `"WOOCOMMERCE_REDACT_PII": "true"`.

## Docker

Every release publishes a multi-architecture image (`linux/amd64`, `linux/arm64`) to the GitHub Container Registry:

```bash
docker pull ghcr.io/sadrmanesh/woocommerce-mcp:0.5.0
```

The same image, with the same tags, is on Docker Hub:

```bash
docker pull sadrmanesh/woocommerce-mcp:0.5.0
```

Tags are `X.Y.Z` for an exact release, `X.Y` for the newest patch of a minor version, and `latest`. The image runs as the unprivileged `node` user and carries OCI labels that link it to this repository.

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
        "ghcr.io/sadrmanesh/woocommerce-mcp:0.5.0"
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

`-e NAME` without a value passes the variable through from `env`, so secrets stay out of `args`. For a long-running HTTP server, see [Deployment](deployment.md). To build the image yourself instead, run `docker build -t woocommerce-mcp .` in a checkout and use `woocommerce-mcp` as the image name.

## GitHub Packages

The npm package is also published to GitHub Packages under the same name, `@sadrmanesh/woocommerce-mcp`. npmjs.com remains the main registry, and the other commands on this page use it. To install from GitHub Packages instead, point the `@sadrmanesh` scope at it in an `.npmrc` file. GitHub Packages asks for a token even for public packages: a personal access token (classic) with the `read:packages` scope.

```ini
@sadrmanesh:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
npm install -g @sadrmanesh/woocommerce-mcp
```

Keep the token in the `GITHUB_TOKEN` environment variable, not in the file.

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

## Directories

The server is also listed on two MCP directories, which show its tools, README, and install instructions:

- [Glama](https://glama.ai/mcp/servers/sadrmanesh/woocommerce-mcp), with a quality score and a card for the server
- [mcpservers.org](https://mcpservers.org/servers/sadrmanesh/woocommerce-mcp)

[![Glama MCP server score](https://glama.ai/mcp/servers/sadrmanesh/woocommerce-mcp/badges/score.svg)](https://glama.ai/mcp/servers/sadrmanesh/woocommerce-mcp)
[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/sadrmanesh/woocommerce-mcp)

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
