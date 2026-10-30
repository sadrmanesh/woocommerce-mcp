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
5. Describe what changed and how you tested it. Update the README when configuration or tool behavior changes, and add a `CHANGELOG.md` entry under `[Unreleased]`.

Write tools stay behind `WOOCOMMERCE_READ_ONLY`. New write tools need the same guard, `readOnlyHint: false`, and a description that says they are refused in read-only mode.

## Reporting issues

Use the bug and feature templates. Include the server version, Node.js version, and transport (`stdio` or streamable HTTP). Redact consumer keys, secrets, and customer data from logs.
