import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

import { InputError } from '../woocommerce/errors.js';
import type { QueryParams } from '../woocommerce/client.js';
import { summarizeSales, summarizeTopSellers, summarizeTotals } from '../woocommerce/present.js';
import type { ToolContext } from './context.js';
import { toolNames } from './names.js';
import { execute } from './result.js';
import { storeSummaryInput } from './schemas.js';

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export type StoreSummaryInput = z.infer<typeof storeSummaryInput>;

export function registerSummaryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    toolNames.getStoreSummary,
    {
      title: 'Store summary',
      description:
        'Summarize recent sales, top sellers, and current totals for orders, products, and customers from the WooCommerce reports API. Order, product, and customer totals are current counts and do not take the date range.',
      inputSchema: storeSummaryInput,
      annotations: readAnnotations,
    },
    async (input) => execute(ctx, toolNames.getStoreSummary, false, () => getStoreSummary(ctx, input)),
  );
}

export async function getStoreSummary(ctx: ToolContext, input: StoreSummaryInput) {
  if (input.dateMin && input.dateMax && input.dateMin > input.dateMax) {
    throw new InputError('dateMin must be on or before dateMax.');
  }
  const period = input.period ?? (input.dateMin || input.dateMax ? undefined : 'month');
  const query: QueryParams = {
    period,
    date_min: input.dateMin,
    date_max: input.dateMax,
  };
  const [sales, topSellers, orders, products, customers] = await Promise.all([
    ctx.client.get('reports/sales', query),
    ctx.client.get('reports/top_sellers', query),
    ctx.client.get('reports/orders/totals'),
    ctx.client.get('reports/products/totals'),
    ctx.client.get('reports/customers/totals'),
  ]);
  return {
    period: period ?? null,
    dateMin: input.dateMin ?? null,
    dateMax: input.dateMax ?? null,
    sales: summarizeSales(sales.data),
    topSellers: summarizeTopSellers(topSellers.data),
    ordersByStatus: summarizeTotals(orders.data, 'orders totals'),
    productsByType: summarizeTotals(products.data, 'products totals'),
    customersByType: summarizeTotals(customers.data, 'customers totals'),
  };
}
