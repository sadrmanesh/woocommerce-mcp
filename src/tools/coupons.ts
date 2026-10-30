import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

import { InputError } from '../woocommerce/errors.js';
import {
  asCount,
  asDecimal,
  asString,
  compact,
  expectArray,
  expectRecord,
  isRecord,
  stripLinks,
} from '../woocommerce/json.js';
import { summarizeCoupon } from '../woocommerce/present.js';
import { adjustPrice, sendBatch, type BatchOutcome } from './bulk.js';
import { pageQuery, type Page, type Runtime, type ToolContext } from './context.js';
import { toolNames } from './names.js';
import { money, scanOrders, toUnits } from './order-scan.js';
import { CREATE, defineTool, DESTRUCTIVE, READ, UPDATE } from './registry.js';
import {
  couponPerformanceInput,
  createCouponInput,
  deleteCouponInput,
  endSaleInput,
  getCouponInput,
  listCouponsInput,
  moneyToString,
  scheduleSaleInput,
  updateCouponInput,
} from './schemas.js';

export type ListCouponsInput = z.infer<typeof listCouponsInput>;
export type CreateCouponInput = z.infer<typeof createCouponInput>;

export function registerCouponTools(server: McpServer, runtime: Runtime): void {
  defineTool(server, runtime, {
    name: toolNames.listCoupons,
    title: 'List coupons',
    description: 'List coupons with code, discount type, amount, and usage, plus pagination.',
    input: listCouponsInput,
    annotations: READ,
    write: false,
    run: listCoupons,
  });
  defineTool(server, runtime, {
    name: toolNames.createCoupon,
    title: 'Create coupon',
    description: 'Create a coupon. Amount is a decimal string or number, without a currency symbol.',
    input: createCouponInput,
    annotations: CREATE,
    write: true,
    run: createCoupon,
  });
}

export async function listCoupons(
  ctx: ToolContext,
  input: ListCouponsInput,
): Promise<Page<ReturnType<typeof summarizeCoupon>>> {
  const paging = pageQuery(input, ctx.defaultPerPage);
  const response = await ctx.client.get('coupons', {
    ...paging,
    search: input.search,
    code: input.code,
    after: input.after,
    before: input.before,
    orderby: input.orderBy,
    order: input.order,
  });
  return {
    items: expectArray(response.data, 'coupon list').map((item) => summarizeCoupon(item)),
    pagination: {
      page: paging.page,
      perPage: paging.per_page,
      total: response.pagination.total,
      totalPages: response.pagination.totalPages,
    },
  };
}

export async function createCoupon(ctx: ToolContext, input: CreateCouponInput): Promise<unknown> {
  const response = await ctx.client.post(
    'coupons',
    compact({
      code: input.code,
      amount: moneyToString(input.amount),
      discount_type: input.discountType,
      description: input.description,
      date_expires: input.dateExpires,
      individual_use: input.individualUse,
      usage_limit: input.usageLimit,
      usage_limit_per_user: input.usageLimitPerUser,
      free_shipping: input.freeShipping,
      minimum_amount: input.minimumAmount === undefined ? undefined : moneyToString(input.minimumAmount),
      maximum_amount: input.maximumAmount === undefined ? undefined : moneyToString(input.maximumAmount),
      product_ids: input.productIds,
      excluded_product_ids: input.excludedProductIds,
      email_restrictions: input.emailRestrictions,
    }),
  );
  return stripLinks(expectRecord(response.data, 'coupon'));
}

export type GetCouponInput = z.infer<typeof getCouponInput>;
export type UpdateCouponInput = z.infer<typeof updateCouponInput>;
export type DeleteCouponInput = z.infer<typeof deleteCouponInput>;
export type CouponPerformanceInput = z.infer<typeof couponPerformanceInput>;
export type ScheduleSaleInput = z.infer<typeof scheduleSaleInput>;
export type EndSaleInput = z.infer<typeof endSaleInput>;

export function registerPromotionTools(server: McpServer, runtime: Runtime): void {
  defineTool(server, runtime, {
    name: toolNames.getCoupon,
    title: 'Get coupon',
    description: 'Get one coupon with its restrictions, limits, and usage count.',
    input: getCouponInput,
    annotations: READ,
    write: false,
    run: getCoupon,
  });
  defineTool(server, runtime, {
    name: toolNames.updateCoupon,
    title: 'Update coupon',
    description: 'Change a coupon amount, type, expiry, limits, or restrictions. Only the fields you pass are changed.',
    input: updateCouponInput,
    annotations: UPDATE,
    write: true,
    run: updateCoupon,
  });
  defineTool(server, runtime, {
    name: toolNames.deleteCoupon,
    title: 'Delete coupon',
    description: 'Move a coupon to the trash, or delete it permanently with force: true.',
    input: deleteCouponInput,
    annotations: DESTRUCTIVE,
    write: true,
    run: deleteCoupon,
  });
  defineTool(server, runtime, {
    name: toolNames.couponPerformance,
    title: 'Coupon performance',
    description:
      'Report how often each coupon was used in a date range, with the discount given and the revenue of the orders that used it.',
    input: couponPerformanceInput,
    annotations: READ,
    write: false,
    run: couponPerformance,
  });
  defineTool(server, runtime, {
    name: toolNames.scheduleSale,
    title: 'Schedule sale',
    description:
      'Put products on sale at a percentage off their regular price, optionally between two dates. Variable and grouped products are skipped; use the variation tools for those.',
    input: scheduleSaleInput,
    annotations: UPDATE,
    write: true,
    run: scheduleSale,
  });
  defineTool(server, runtime, {
    name: toolNames.endSale,
    title: 'End sale',
    description: 'Clear the sale price and sale dates of products so they sell at their regular price again.',
    input: endSaleInput,
    annotations: UPDATE,
    write: true,
    run: endSale,
  });
}

export async function getCoupon(ctx: ToolContext, input: GetCouponInput): Promise<unknown> {
  const response = await ctx.client.get(`coupons/${input.id}`);
  return stripLinks(expectRecord(response.data, 'coupon'));
}

export async function updateCoupon(ctx: ToolContext, input: UpdateCouponInput): Promise<unknown> {
  const payload = compact({
    amount: input.amount === undefined ? undefined : moneyToString(input.amount),
    discount_type: input.discountType,
    description: input.description,
    individual_use: input.individualUse,
    free_shipping: input.freeShipping,
    minimum_amount: input.minimumAmount === undefined ? undefined : moneyToString(input.minimumAmount),
    maximum_amount: input.maximumAmount === undefined ? undefined : moneyToString(input.maximumAmount),
    product_ids: input.productIds,
    excluded_product_ids: input.excludedProductIds,
    email_restrictions: input.emailRestrictions,
  });
  // null is meaningful here: it removes the expiry or the limit.
  if (input.dateExpires !== undefined) payload.date_expires = input.dateExpires;
  if (input.usageLimit !== undefined) payload.usage_limit = input.usageLimit;
  if (input.usageLimitPerUser !== undefined) payload.usage_limit_per_user = input.usageLimitPerUser;
  if (Object.keys(payload).length === 0) throw new InputError('Pass at least one coupon field to change.');
  const response = await ctx.client.put(`coupons/${input.id}`, payload);
  return stripLinks(expectRecord(response.data, 'coupon'));
}

export async function deleteCoupon(ctx: ToolContext, input: DeleteCouponInput): Promise<unknown> {
  const response = await ctx.client.delete(`coupons/${input.id}`, { force: input.force ?? false });
  return { deleted: true, permanent: input.force ?? false, coupon: summarizeCoupon(response.data) };
}

export interface CouponUsage {
  code: string;
  orders: number;
  discount: string;
  revenue: string;
}

export async function couponPerformance(
  ctx: ToolContext,
  input: CouponPerformanceInput,
): Promise<{
  range: { after: string; before: string | null };
  scanned: number;
  ordersWithCoupons: number;
  truncated: boolean;
  coupons: CouponUsage[];
}> {
  const statuses = input.statuses ?? ['processing', 'completed'];
  const wanted = input.code?.toLowerCase();
  const usage = new Map<string, { orders: number; discount: number; revenue: number }>();
  let ordersWithCoupons = 0;
  const { scanned, truncated } = await scanOrders(
    ctx,
    {
      query: { status: statuses.join(','), after: input.after, before: input.before },
      maxOrders: input.maxOrders ?? 1_000,
    },
    (order) => {
      const lines = Array.isArray(order.coupon_lines) ? order.coupon_lines.filter(isRecord) : [];
      let counted = false;
      for (const line of lines) {
        const code = (asString(line.code) ?? '').toLowerCase();
        if (code === '' || (wanted !== undefined && code !== wanted)) continue;
        const entry = usage.get(code) ?? { orders: 0, discount: 0, revenue: 0 };
        entry.orders += 1;
        entry.discount += toUnits(line.discount);
        entry.revenue += toUnits(order.total);
        usage.set(code, entry);
        counted = true;
      }
      if (counted) ordersWithCoupons += 1;
    },
  );
  return {
    range: { after: input.after, before: input.before ?? null },
    scanned,
    ordersWithCoupons,
    truncated,
    coupons: [...usage]
      .sort(([, a], [, b]) => b.orders - a.orders || b.discount - a.discount)
      .map(([code, entry]) => ({
        code,
        orders: entry.orders,
        discount: money(entry.discount),
        revenue: money(entry.revenue),
      })),
  };
}

interface SaleChange {
  id: number;
  name: string | null;
  regularPrice: string;
  salePrice: string;
}

export async function scheduleSale(
  ctx: ToolContext,
  input: ScheduleSaleInput,
): Promise<{ changes: SaleChange[]; skipped: { id: number; reason: string }[]; result: BatchOutcome | null }> {
  if (input.startsAt !== undefined && input.endsAt !== undefined && Date.parse(input.endsAt) <= Date.parse(input.startsAt)) {
    throw new InputError('endsAt must be after startsAt.');
  }
  const decimals = input.decimals ?? 2;
  const ids = [...new Set(input.productIds)];
  const found = await fetchProducts(ctx, ids);
  const changes: SaleChange[] = [];
  const skipped: { id: number; reason: string }[] = [];
  for (const id of ids) {
    const product = found.get(id);
    if (!product) {
      skipped.push({ id, reason: 'not found' });
      continue;
    }
    const type = asString(product.type);
    if (type === 'variable' || type === 'grouped') {
      skipped.push({ id, reason: `${type} products have no own price` });
      continue;
    }
    const regular = asDecimal(product.regular_price);
    const base = Number(regular ?? '');
    if (regular === null || regular === '' || !Number.isFinite(base) || base <= 0) {
      skipped.push({ id, reason: 'no regular price' });
      continue;
    }
    const sale = adjustPrice(base, 'percent', -input.discountPercent, decimals);
    if (sale <= 0 || sale >= base) {
      skipped.push({ id, reason: 'the discount rounds to no change' });
      continue;
    }
    changes.push({ id, name: asString(product.name), regularPrice: regular, salePrice: sale.toFixed(decimals) });
  }
  if (changes.length === 0) return { changes, skipped, result: null };
  const result = await sendBatch(
    ctx,
    changes.map((change) => ({
      id: change.id,
      sale_price: change.salePrice,
      date_on_sale_from: input.startsAt ?? null,
      date_on_sale_to: input.endsAt ?? null,
    })),
  );
  return { changes, skipped, result };
}

export async function endSale(
  ctx: ToolContext,
  input: EndSaleInput,
): Promise<{ cleared: number[]; skipped: { id: number; reason: string }[]; result: BatchOutcome | null }> {
  const ids = [...new Set(input.productIds)];
  const found = await fetchProducts(ctx, ids);
  const cleared: number[] = [];
  const skipped: { id: number; reason: string }[] = [];
  for (const id of ids) {
    const product = found.get(id);
    if (!product) skipped.push({ id, reason: 'not found' });
    else if ((asDecimal(product.sale_price) ?? '') === '' && !product.date_on_sale_from && !product.date_on_sale_to) {
      skipped.push({ id, reason: 'not on sale' });
    } else cleared.push(id);
  }
  if (cleared.length === 0) return { cleared, skipped, result: null };
  const result = await sendBatch(
    ctx,
    cleared.map((id) => ({ id, sale_price: '', date_on_sale_from: null, date_on_sale_to: null })),
  );
  return { cleared, skipped, result };
}

async function fetchProducts(ctx: ToolContext, ids: number[]): Promise<Map<number, Record<string, unknown>>> {
  const response = await ctx.client.get('products', { include: ids.join(','), per_page: 100 });
  const found = new Map<number, Record<string, unknown>>();
  for (const item of expectArray(response.data, 'product list')) {
    if (!isRecord(item)) continue;
    const id = asCount(item.id);
    if (id !== null) found.set(id, item);
  }
  return found;
}
