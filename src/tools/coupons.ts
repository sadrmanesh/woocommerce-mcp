import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

import { compact, expectArray, expectRecord, stripLinks } from '../woocommerce/json.js';
import { summarizeCoupon } from '../woocommerce/present.js';
import { pageQuery, type Page, type Runtime, type ToolContext } from './context.js';
import { toolNames } from './names.js';
import { CREATE, defineTool, READ } from './registry.js';
import { createCouponInput, listCouponsInput, moneyToString } from './schemas.js';

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
