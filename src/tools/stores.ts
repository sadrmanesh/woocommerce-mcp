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
}

export function listStores(runtime: Runtime): { stores: StoreListing[]; requireConfirmation: boolean } {
  return {
    stores: runtime.stores.map(({ config }) => ({
      id: config.id,
      label: config.label,
      host: publicStoreLabel(config.url),
      readOnly: config.readOnly,
      default: config.id === runtime.defaultStore,
    })),
    requireConfirmation: runtime.requireConfirmation,
  };
}

export function registerStoreTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    toolNames.listStores,
    {
      title: 'List stores',
      description:
        'List the WooCommerce stores this server can reach, with the id to pass as store, which one is the default, and whether writes are allowed.',
      inputSchema: emptyInput,
      annotations: { ...READ, openWorldHint: false },
    },
    async () => jsonResult(listStores(runtime)),
  );
}
