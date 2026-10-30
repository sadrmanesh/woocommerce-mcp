#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { authWarnings, loadConfig, publicStoreLabel } from './config.js';
import { loadEnvFile } from './env-file.js';
import { startHttpServer } from './http.js';
import { createServer } from './server.js';
import { installShutdown } from './shutdown.js';
import { VERSION } from './version.js';
import { WooCommerceClient } from './woocommerce/client.js';
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
  const client = new WooCommerceClient(config);
  const factory = (): ReturnType<typeof createServer> => createServer({ config, client });
  if (config.transport === 'http') {
    await startHttpServer(factory, config, {
      signals: options.signals ?? true,
      quiet: options.quiet ?? false,
    });
    return;
  }
  if (!(options.quiet ?? false)) {
    const mode = config.readOnly ? 'read-only' : 'writes enabled';
    console.error(
      `woocommerce-mcp ${VERSION} listening on stdio (${mode}) for ${publicStoreLabel(config.url)}`,
    );
  }
  const handle = serveStdio(factory);
  if (options.signals ?? true) {
    installShutdown(() => handle.close());
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

if (runningAsCli()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { VERSION } from './version.js';
export { loadConfig, authWarnings, publicStoreLabel } from './config.js';
export type { AppConfig } from './config.js';
export { createServer } from './server.js';
export { WooCommerceClient } from './woocommerce/client.js';
