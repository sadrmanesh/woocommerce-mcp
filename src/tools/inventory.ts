import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

import { InputError } from '../woocommerce/errors.js';
import { compact } from '../woocommerce/json.js';
import { summarizeStock } from '../woocommerce/present.js';
import type { Runtime, ToolContext } from './context.js';
import { toolNames } from './names.js';
import { defineTool, READ, UPDATE } from './registry.js';
import { getStockInput, updateStockInput } from './schemas.js';

export type GetStockInput = z.infer<typeof getStockInput>;
export type UpdateStockInput = z.infer<typeof updateStockInput>;

export function registerInventoryTools(server: McpServer, runtime: Runtime): void {
  defineTool(server, runtime, {
    name: toolNames.getStock,
    title: 'Get stock',
    description: 'Read stock quantity and status for a product or variation.',
    input: getStockInput,
    annotations: READ,
    write: false,
    run: getStock,
  });
  defineTool(server, runtime, {
    name: toolNames.updateStock,
    title: 'Update stock',
    description:
      'Set the stock quantity or status for a product or variation. Sending stockQuantity turns on stock management unless manageStock is false.',
    input: updateStockInput,
    annotations: UPDATE,
    write: true,
    run: updateStock,
  });
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
