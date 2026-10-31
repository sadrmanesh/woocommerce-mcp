#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { askOnTerminal, runApprove } from './approve-cli.js';
import { authWarnings, loadConfig, publicStoreLabel } from './config.js';
import { loadEnvFile } from './env-file.js';
import { startHttpServer } from './http.js';
import { createRuntime, createServer } from './server.js';
import { startTelemetry } from './telemetry.js';
import { installShutdown } from './shutdown.js';
import { VERSION } from './version.js';
import { ConfigError } from './woocommerce/errors.js';

export interface MainOptions {
  loadDotEnv?: boolean;
  signals?: boolean;
  quiet?: boolean;
}

export async function main(env: NodeJS.ProcessEnv = process.env, options: MainOptions = {}): Promise<void> {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 20) {
    throw new ConfigError('woocommerce-mcp requires Node.js 20 or newer.');
  }
  if (options.loadDotEnv ?? env === process.env) {
    loadEnvFile(env, resolve(process.cwd(), '.env'));
  }
  const config = loadConfig(env);
  for (const warning of authWarnings(config)) {
    console.error(`woocommerce-mcp warning: ${warning}`);
  }
  const telemetry = config.telemetry ? await startTelemetry() : null;
  const runtime = createRuntime(config);
  const factory = (): ReturnType<typeof createServer> => createServer({ runtime });
  const quiet = options.quiet ?? false;
  const signals = options.signals ?? true;
  if (config.transport === 'http') {
    const http = await startHttpServer(factory, config, {
      signals: false,
      quiet,
      webhooks: {
        path: config.webhookPath,
        events: runtime.events,
        storeSecret: (id) => {
          const store = runtime.stores.find((entry) => entry.config.id.toLowerCase() === id.toLowerCase());
          const secret = store?.config.webhookSecret;
          return store && secret ? { id: store.config.id, secret } : null;
        },
      },
    });
    if (signals) {
      installShutdown(async () => {
        await http.close();
        await telemetry?.shutdown();
      });
    }
    return;
  }
  if (!quiet) {
    const stores = config.stores
      .map((store) => `${store.id}=${publicStoreLabel(store.url)}${store.readOnly ? ' (read-only)' : ' (writes enabled)'}`)
      .join(', ');
    console.error(`woocommerce-mcp ${VERSION} listening on stdio for ${stores}`);
  }
  const handle = serveStdio(factory);
  if (signals) {
    installShutdown(async () => {
      await handle.close();
      await telemetry?.shutdown();
    });
  }
}

function runningAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      pathToFileURL(realpathSync(entry)).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href
    );
  } catch {
    return false;
  }
}

if (runningAsCli() && process.argv[2] === 'approve') {
  // Out-of-band signer: never started by an MCP client, never serves tools.
  loadEnvFile(process.env, resolve(process.cwd(), '.env'));
  runApprove(process.argv.slice(3), process.env, {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(`${text}\n`),
    ask: process.stdin.isTTY ? askOnTerminal : null,
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    });
} else if (runningAsCli()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { VERSION } from './version.js';
export { loadConfig, authWarnings, publicStoreLabel } from './config.js';
export type { AppConfig, StoreConfig } from './config.js';
export { createRuntime, createServer } from './server.js';
export { createAuditLog, memoryAuditLog } from './audit.js';
export { ApprovalError, ApprovalVerifier, signApproval } from './approval.js';
export type { ApprovalClaims, SignApprovalOptions } from './approval.js';
export type { AuditApproval, AuditEntry, AuditLog } from './audit.js';
export type { Runtime } from './tools/context.js';
export { WooCommerceClient } from './woocommerce/client.js';
