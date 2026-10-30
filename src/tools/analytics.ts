import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

import { asCount, asDecimal, asString, expectArray, isRecord } from '../woocommerce/json.js';
import type { Runtime, ToolContext } from './context.js';
import { toolNames } from './names.js';
import { defineTool, READ } from './registry.js';
import { lowStockReportInput, salesAnalyticsInput } from './schemas.js';

export type SalesAnalyticsInput = z.infer<typeof salesAnalyticsInput>;
export type LowStockReportInput = z.infer<typeof lowStockReportInput>;

const PAGE_SIZE = 100;
/** Amounts are summed in ten-thousandths to avoid floating point drift. */
const SCALE = 10_000;

export interface SalesAnalytics {
  range: { after: string; before: string | null };
  statuses: string[];
  currency: string | null;
  orders: number;
  itemsSold: number;
  grossSales: string;
  refunds: string;
  netSales: string;
  shipping: string;
  tax: string;
  discounts: string;
  averageOrderValue: string;
  byStatus: Record<string, { orders: number; total: string }>;
  series: { period: string; orders: number; total: string }[];
  topProducts: { productId: number | null; name: string | null; quantity: number; total: string }[];
  paymentMethods: { method: string; orders: number; total: string }[];
  truncated: boolean;
  note: string;
}

export function registerAnalyticsTools(server: McpServer, runtime: Runtime): void {
  defineTool(server, runtime, {
    name: toolNames.salesAnalytics,
    title: 'Sales analytics',
    description:
      'Compute sales for a date range from orders: gross and net sales, refunds, average order value, a day, week, or month series, top products, and payment methods. Reads up to maxOrders orders and says when the result is truncated.',
    input: salesAnalyticsInput,
    annotations: READ,
    write: false,
    run: salesAnalytics,
  });
  defineTool(server, runtime, {
    name: toolNames.lowStockReport,
    title: 'Low stock report',
    description:
      'List products whose managed stock is at or below a threshold, plus out-of-stock products, sorted by quantity so the most urgent come first.',
    input: lowStockReportInput,
    annotations: READ,
    write: false,
    run: lowStockReport,
  });
}

export async function salesAnalytics(ctx: ToolContext, input: SalesAnalyticsInput): Promise<SalesAnalytics> {
  const statuses = input.statuses ?? ['processing', 'completed'];
  const groupBy = input.groupBy ?? 'day';
  const maxOrders = input.maxOrders ?? 1_000;
  const top = input.top ?? 10;

  let currency: string | null = null;
  let orders = 0;
  let itemsSold = 0;
  let gross = 0;
  let refunds = 0;
  let shipping = 0;
  let tax = 0;
  let discounts = 0;
  let truncated = false;
  const byStatus = new Map<string, { orders: number; total: number }>();
  const series = new Map<string, { orders: number; total: number }>();
  const products = new Map<string, { productId: number | null; name: string | null; quantity: number; total: number }>();
  const methods = new Map<string, { orders: number; total: number }>();

  for (let page = 1; ; page += 1) {
    const response = await ctx.client.get('orders', {
      page,
      per_page: PAGE_SIZE,
      status: statuses.join(','),
      after: input.after,
      before: input.before,
      orderby: 'date',
      order: 'asc',
    });
    const rows = expectArray(response.data, 'order list');
    for (const row of rows) {
      if (orders >= maxOrders) {
        truncated = true;
        break;
      }
      if (!isRecord(row)) continue;
      orders += 1;
      currency ??= asString(row.currency);
      const total = toUnits(row.total);
      gross += total;
      shipping += toUnits(row.shipping_total);
      tax += toUnits(row.total_tax);
      discounts += toUnits(row.discount_total);
      if (Array.isArray(row.refunds)) {
        for (const refund of row.refunds) {
          if (isRecord(refund)) refunds += Math.abs(toUnits(refund.total));
        }
      }
      bump(byStatus, asString(row.status) ?? 'unknown', total);
      bump(series, periodKey(asString(row.date_created_gmt) ?? asString(row.date_created), groupBy), total);
      bump(methods, asString(row.payment_method_title) || asString(row.payment_method) || 'unknown', total);
      if (Array.isArray(row.line_items)) {
        for (const line of row.line_items) {
          if (!isRecord(line)) continue;
          const quantity = asCount(line.quantity) ?? 0;
          itemsSold += quantity;
          const productId = asCount(line.product_id);
          const key = productId === null ? `name:${asString(line.name) ?? ''}` : String(productId);
          const entry = products.get(key) ?? { productId, name: asString(line.name), quantity: 0, total: 0 };
          entry.quantity += quantity;
          entry.total += toUnits(line.total);
          products.set(key, entry);
        }
      }
    }
    const totalPages = response.pagination.totalPages;
    const lastPage = rows.length < PAGE_SIZE || (totalPages !== null && page >= totalPages);
    if (truncated || lastPage) break;
    if (orders >= maxOrders) {
      truncated = true;
      break;
    }
  }

  return {
    range: { after: input.after, before: input.before ?? null },
    statuses,
    currency,
    orders,
    itemsSold,
    grossSales: money(gross),
    refunds: money(refunds),
    netSales: money(gross - refunds),
    shipping: money(shipping),
    tax: money(tax),
    discounts: money(discounts),
    averageOrderValue: money(orders === 0 ? 0 : Math.round(gross / orders)),
    byStatus: Object.fromEntries(
      [...byStatus].map(([status, value]) => [status, { orders: value.orders, total: money(value.total) }]),
    ),
    series: [...series]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, value]) => ({ period, orders: value.orders, total: money(value.total) })),
    topProducts: [...products.values()]
      .sort((a, b) => b.total - a.total || b.quantity - a.quantity)
      .slice(0, top)
      .map((entry) => ({ ...entry, total: money(entry.total) })),
    paymentMethods: [...methods]
      .sort(([, a], [, b]) => b.total - a.total)
      .map(([method, value]) => ({ method, orders: value.orders, total: money(value.total) })),
    truncated,
    note: 'Totals include tax and shipping as stored on each order. Periods use UTC dates. Weeks start on Monday.',
  };
}

export interface LowStockItem {
  id: number | null;
  name: string | null;
  sku: string | null;
  stockQuantity: number | null;
  stockStatus: string | null;
}

export async function lowStockReport(
  ctx: ToolContext,
  input: LowStockReportInput,
): Promise<{ threshold: number; scanned: number; truncated: boolean; items: LowStockItem[] }> {
  const threshold = input.threshold ?? 5;
  const includeOut = input.includeOutOfStock ?? true;
  const maxProducts = input.maxProducts ?? 500;
  const items: LowStockItem[] = [];
  let scanned = 0;
  let truncated = false;

  for (let page = 1; ; page += 1) {
    const response = await ctx.client.get('products', {
      page,
      per_page: PAGE_SIZE,
      status: 'publish',
      orderby: 'id',
      order: 'asc',
    });
    const rows = expectArray(response.data, 'product list');
    for (const row of rows) {
      if (scanned >= maxProducts) {
        truncated = true;
        break;
      }
      scanned += 1;
      if (!isRecord(row)) continue;
      const quantity = asCount(row.stock_quantity);
      const status = asString(row.stock_status);
      const low = row.manage_stock === true && quantity !== null && quantity <= threshold;
      const out = includeOut && status === 'outofstock';
      if (low || out) {
        items.push({ id: asCount(row.id), name: asString(row.name), sku: asString(row.sku), stockQuantity: quantity, stockStatus: status });
      }
    }
    const totalPages = response.pagination.totalPages;
    if (truncated || rows.length < PAGE_SIZE || (totalPages !== null && page >= totalPages)) break;
    if (scanned >= maxProducts) {
      truncated = true;
      break;
    }
  }

  items.sort((a, b) => (a.stockQuantity ?? -1) - (b.stockQuantity ?? -1));
  return { threshold, scanned, truncated, items };
}

function toUnits(value: unknown): number {
  const decimal = asDecimal(value);
  if (decimal === null || decimal.trim() === '') return 0;
  const parsed = Number(decimal);
  return Number.isFinite(parsed) ? Math.round(parsed * SCALE) : 0;
}

function money(units: number): string {
  return (units / SCALE).toFixed(2);
}

function bump(map: Map<string, { orders: number; total: number }>, key: string, total: number): void {
  const entry = map.get(key) ?? { orders: 0, total: 0 };
  entry.orders += 1;
  entry.total += total;
  map.set(key, entry);
}

export function periodKey(date: string | null, groupBy: 'day' | 'week' | 'month'): string {
  if (date === null) return 'unknown';
  const iso = /[zZ]|[+-]\d{2}:\d{2}$/.test(date) ? date : `${date}Z`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return 'unknown';
  if (groupBy === 'month') return parsed.toISOString().slice(0, 7);
  if (groupBy === 'week') {
    const day = (parsed.getUTCDay() + 6) % 7;
    parsed.setUTCDate(parsed.getUTCDate() - day);
  }
  return parsed.toISOString().slice(0, 10);
}
