# Contributing

Thanks for helping with woocommerce-mcp. The project is MIT licensed, copyright Naser Sadrmanesh.

## Setup

Node.js 20 or newer:

```bash
git clone https://github.com/sadrmanesh/woocommerce-mcp.git
cd woocommerce-mcp
npm install
npm test
```

`npm run check` runs the linter, the TypeScript check, the tests, and the build.

Do not put real consumer keys or customer data in tests, fixtures, or commit messages. Tests mock `fetch`. A `.env` file is gitignored.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep the change focused. Match the existing TypeScript style: ESM, strict compiler options, and `.js` extensions on local imports.
3. Add or update tests for behavior you change. HTTP tests should keep using a mocked `fetch`.
4. Run `npm run check` before you open the pull request.
5. Describe what changed and how you tested it. Update the README and `docs/` when configuration or tool behavior changes, and add a `CHANGELOG.md` entry under `[Unreleased]`.

Define tools with `defineTool` from `src/tools/registry.ts`. Mark write tools with `write: true` and one of the write annotation presets; the registry then adds the `store`, `dryRun`, and `confirm` arguments and handles read-only stores, token scopes, previews, the audit log, and tracing. Make the write the last step of a tool so previews show the request that matters. Document new tools in `docs/tools.md`.

## Releases

1. Update the version in `package.json` and `src/version.ts`, and move the `[Unreleased]` notes in `CHANGELOG.md` under the new version.
2. Merge to `main`, then push a tag such as `v0.2.0`.
3. The release workflow runs `npm run check`, confirms the tag matches the package version, and publishes to npm with the `NPM_TOKEN` repository secret. Without the secret it stops before publishing.
4. After npm, it publishes `server.json` to the MCP Registry, the same package to GitHub Packages, and a multi-architecture Docker image to `ghcr.io/sadrmanesh/woocommerce-mcp` tagged `X.Y.Z`, `X.Y`, and `latest`. GitHub Packages and GHCR use the workflow's `GITHUB_TOKEN`.

The release workflow also copies the GHCR image, for every platform, to Docker Hub as `docker.io/<DOCKERHUB_USERNAME>/woocommerce-mcp` with the same `X.Y.Z`, `X.Y`, and `latest` tags. This job runs only when the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets are set, and skips with a notice otherwise.

## Mirrors

`.github/workflows/mirror.yml` pushes `main` and every tag to `gitlab.com/sadrmanesh/woocommerce-mcp`. It runs only when the `GITLAB_TOKEN` repository secret is set (a GitLab access token with the `write_repository` scope) and skips with a notice otherwise. Set the `GITLAB_NAMESPACE` repository variable to mirror to another GitLab namespace. GitHub stays the main repository for issues and pull requests.

## Reporting issues

Use the bug and feature templates. Include the server version, Node.js version, and transport (`stdio` or streamable HTTP). Redact consumer keys, secrets, and customer data from logs.
