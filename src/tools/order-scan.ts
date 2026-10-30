import { asDecimal, expectArray, isRecord } from '../woocommerce/json.js';
import type { ToolContext } from './context.js';

const PAGE_SIZE = 100;

export interface OrderScanOptions {
  query: Record<string, string | number | boolean | undefined>;
  maxOrders: number;
}

/**
 * Pages through orders oldest first and calls visit for each one. Returns how many orders were seen and whether
 * the scan stopped at maxOrders before the last page.
 */
export async function scanOrders(
  ctx: ToolContext,
  options: OrderScanOptions,
  visit: (order: Record<string, unknown>) => void,
): Promise<{ scanned: number; truncated: boolean }> {
  let scanned = 0;
  for (let page = 1; ; page += 1) {
    const response = await ctx.client.get('orders', {
      orderby: 'date',
      order: 'asc',
      ...options.query,
      page,
      per_page: PAGE_SIZE,
    });
    const rows = expectArray(response.data, 'order list');
    for (const row of rows) {
      if (scanned >= options.maxOrders) return { scanned, truncated: true };
      if (!isRecord(row)) continue;
      scanned += 1;
      visit(row);
    }
    const totalPages = response.pagination.totalPages;
    if (rows.length < PAGE_SIZE || (totalPages !== null && page >= totalPages)) return { scanned, truncated: false };
    if (scanned >= options.maxOrders) return { scanned, truncated: true };
  }
}

/** Sums decimal strings in ten-thousandths to avoid floating point drift. */
export const SCALE = 10_000;

export function toUnits(value: unknown): number {
  const decimal = asDecimal(value);
  if (decimal === null || decimal.trim() === '') return 0;
  const parsed = Number(decimal);
  return Number.isFinite(parsed) ? Math.round(parsed * SCALE) : 0;
}

export function money(units: number): string {
  return (units / SCALE).toFixed(2);
}
