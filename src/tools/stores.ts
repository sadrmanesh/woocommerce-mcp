import type { McpServer } from '@modelcontextprotocol/server';

import { publicStoreLabel } from '../config.js';
import type { Runtime } from './context.js';
import { toolNames } from './names.js';
import { jsonResult } from './result.js';
import { READ } from './registry.js';
import { emptyInput } from './schemas.js';

export interface StoreListing {
  id: string;
  label: string | null;
  host: string;
  readOnly: boolean;
  default: boolean;
  redactPii: boolean;
  webhookReceiver: boolean;
  cache: { enabled: boolean; ttlMs: number; entries: number; hits: number; misses: number };
  rateLimit: { requestsPerSecond: number; burst: number };
}

export function listStores(runtime: Runtime): { stores: StoreListing[]; requireConfirmation: boolean } {
  return {
    stores: runtime.stores.map(({ config, client }) => {
      const stats = client.stats();
      return {
        id: config.id,
        label: config.label,
        host: publicStoreLabel(config.url),
        readOnly: config.readOnly,
        default: config.id === runtime.defaultStore,
        redactPii: config.redactPii,
        webhookReceiver: config.webhookSecret !== null,
        cache: stats.cache,
        rateLimit: stats.rateLimit,
      };
    }),
    requireConfirmation: runtime.requireConfirmation,
  };
}

export function registerStoreTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    toolNames.listStores,
    {
      title: 'List stores',
      description:
        'List the WooCommerce stores this server can reach, with the id to pass as store, which one is the default, whether writes are allowed, privacy and webhook settings, and cache statistics.',
      inputSchema: emptyInput,
      annotations: { ...READ, openWorldHint: false },
    },
    async () => jsonResult(listStores(runtime)),
  );
}
