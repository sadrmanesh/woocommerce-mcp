import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

import { InputError } from '../woocommerce/errors.js';
import { asCount, asDecimal, asString, compact, expectArray, isRecord } from '../woocommerce/json.js';
import { summarizeProduct } from '../woocommerce/present.js';
import type { Runtime, ToolContext } from './context.js';
import { toolNames } from './names.js';
import { defineTool, UPDATE } from './registry.js';
import { bulkAdjustPricesInput, bulkUpdateProductsInput, moneyToString } from './schemas.js';

export type BulkUpdateProductsInput = z.infer<typeof bulkUpdateProductsInput>;
export type BulkAdjustPricesInput = z.infer<typeof bulkAdjustPricesInput>;

export interface BatchOutcome {
  updated: ReturnType<typeof summarizeProduct>[];
  errors: { id: number | null; code: string | null; message: string | null }[];
}

export interface PriceChange {
  id: number;
  name: string | null;
  field: 'regular_price' | 'sale_price';
  from: string | null;
  to: string;
}

export function registerBulkTools(server: McpServer, runtime: Runtime): void {
  defineTool(server, runtime, {
    name: toolNames.bulkUpdateProducts,
    title: 'Bulk update products',
    description:
      'Update price, stock, or status on up to 100 products in one WooCommerce batch request. Per-product failures are listed in errors.',
    input: bulkUpdateProductsInput,
    annotations: UPDATE,
    write: true,
    run: bulkUpdateProducts,
  });
  defineTool(server, runtime, {
    name: toolNames.bulkAdjustPrices,
    title: 'Bulk adjust prices',
    description:
      'Raise or lower prices on up to 100 products by a percentage or a fixed amount, rounded to the given decimals. Reads the current prices first and returns every old and new price; the preview shows the exact batch request. Variable products are skipped because their prices live on variations.',
    input: bulkAdjustPricesInput,
    annotations: UPDATE,
    write: true,
    run: bulkAdjustPrices,
  });
}

export async function bulkUpdateProducts(ctx: ToolContext, input: BulkUpdateProductsInput): Promise<BatchOutcome> {
  const ids = new Set<number>();
  const update = input.updates.map((entry) => {
    if (ids.has(entry.id)) throw new InputError(`Product ${entry.id} appears more than once.`);
    ids.add(entry.id);
    const payload = compact({
      id: entry.id,
      regular_price: entry.regularPrice === undefined ? undefined : moneyToString(entry.regularPrice),
      sale_price: entry.salePrice === undefined ? undefined : moneyToString(entry.salePrice),
      manage_stock: entry.manageStock ?? (entry.stockQuantity === undefined ? undefined : true),
      stock_quantity: entry.stockQuantity,
      stock_status: entry.stockStatus,
      status: entry.status,
    });
    if (Object.keys(payload).length === 1) throw new InputError(`Product ${entry.id} has no fields to update.`);
    return payload;
  });
  return sendBatch(ctx, update);
}

export async function bulkAdjustPrices(
  ctx: ToolContext,
  input: BulkAdjustPricesInput,
): Promise<{ changes: PriceChange[]; skipped: { id: number; reason: string }[]; result: BatchOutcome | null }> {
  const ids = [...new Set(input.productIds)];
  const response = await ctx.client.get('products', { include: ids.join(','), per_page: 100 });
  const found = new Map<number, Record<string, unknown>>();
  for (const item of expectArray(response.data, 'product list')) {
    if (!isRecord(item)) continue;
    const id = asCount(item.id);
    if (id !== null) found.set(id, item);
  }

  const decimals = input.decimals ?? 2;
  const field = input.target === 'sale' ? 'sale_price' : 'regular_price';
  const changes: PriceChange[] = [];
  const skipped: { id: number; reason: string }[] = [];
  for (const id of ids) {
    const product = found.get(id);
    if (!product) {
      skipped.push({ id, reason: 'not found' });
      continue;
    }
    if (asString(product.type) === 'variable' || asString(product.type) === 'grouped') {
      skipped.push({ id, reason: `${asString(product.type) ?? 'unknown'} products have no own price` });
      continue;
    }
    const base = Number(asDecimal(product.regular_price) ?? '');
    if (asDecimal(product.regular_price) === null || asDecimal(product.regular_price) === '' || !Number.isFinite(base)) {
      skipped.push({ id, reason: 'no regular price' });
      continue;
    }
    const next = adjustPrice(base, input.mode, input.change, decimals);
    if (next <= 0) {
      skipped.push({ id, reason: 'new price would be zero or negative' });
      continue;
    }
    if (field === 'sale_price' && next >= base) {
      skipped.push({ id, reason: 'sale price would not be below the regular price' });
      continue;
    }
    changes.push({
      id,
      name: asString(product.name),
      field,
      from: asDecimal(product[field]),
      to: next.toFixed(decimals),
    });
  }

  if (changes.length === 0) return { changes, skipped, result: null };
  const result = await sendBatch(
    ctx,
    changes.map((change) => ({ id: change.id, [change.field]: change.to })),
  );
  return { changes, skipped, result };
}

/** Applies a percentage or fixed change and rounds half away from zero. */
export function adjustPrice(base: number, mode: 'percent' | 'fixed', change: number, decimals: number): number {
  const raw = mode === 'percent' ? base * (1 + change / 100) : base + change;
  const factor = 10 ** decimals;
  // Round on a scaled value with a small epsilon so 19.995 becomes 20.00, not 19.99.
  return Math.sign(raw) * Math.round(Math.abs(raw) * factor + 1e-9) / factor;
}

async function sendBatch(ctx: ToolContext, update: Record<string, unknown>[]): Promise<BatchOutcome> {
  const response = await ctx.client.post('products/batch', { update });
  const data = isRecord(response.data) ? response.data : {};
  const rows = Array.isArray(data.update) ? data.update : [];
  const outcome: BatchOutcome = { updated: [], errors: [] };
  for (const row of rows) {
    if (isRecord(row) && isRecord(row.error)) {
      outcome.errors.push({
        id: asCount(row.id),
        code: asString(row.error.code),
        message: asString(row.error.message),
      });
    } else {
      outcome.updated.push(summarizeProduct(row));
    }
  }
  return outcome;
}
