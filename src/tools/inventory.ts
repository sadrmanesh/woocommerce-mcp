import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

import { InputError } from '../woocommerce/errors.js';
import { compact } from '../woocommerce/json.js';
import { summarizeStock } from '../woocommerce/present.js';
import type { ToolContext } from './context.js';
import { toolNames, WRITE_NOTE } from './names.js';
import { execute } from './result.js';
import { getStockInput, updateStockInput } from './schemas.js';

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const updateAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export type GetStockInput = z.infer<typeof getStockInput>;
export type UpdateStockInput = z.infer<typeof updateStockInput>;

export function registerInventoryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    toolNames.getStock,
    {
      title: 'Get stock',
      description: 'Read stock quantity and status for a product or variation.',
      inputSchema: getStockInput,
      annotations: readAnnotations,
    },
    async (input) => execute(ctx, toolNames.getStock, false, () => getStock(ctx, input)),
  );

  server.registerTool(
    toolNames.updateStock,
    {
      title: 'Update stock',
      description: `Set the stock quantity or status for a product or variation. Sending stockQuantity turns on stock management unless manageStock is false. ${WRITE_NOTE}`,
      inputSchema: updateStockInput,
      annotations: updateAnnotations,
    },
    async (input) => execute(ctx, toolNames.updateStock, true, () => updateStock(ctx, input)),
  );
}

export async function getStock(ctx: ToolContext, input: GetStockInput) {
  const response = await ctx.client.get(stockPath(input.productId, input.variationId));
  return summarizeStock(response.data, input.productId, input.variationId);
}

export async function updateStock(ctx: ToolContext, input: UpdateStockInput) {
  if (input.stockQuantity === undefined && input.stockStatus === undefined && input.manageStock === undefined) {
    throw new InputError('Provide stockQuantity, stockStatus, or manageStock.');
  }
  const response = await ctx.client.put(
    stockPath(input.productId, input.variationId),
    compact({
      stock_quantity: input.stockQuantity,
      stock_status: input.stockStatus,
      manage_stock: input.manageStock ?? (input.stockQuantity === undefined ? undefined : true),
    }),
  );
  return summarizeStock(response.data, input.productId, input.variationId);
}

export function stockPath(productId: number, variationId?: number): string {
  if (variationId === undefined) return `products/${productId}`;
  return `products/${productId}/variations/${variationId}`;
}
