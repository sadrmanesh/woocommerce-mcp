import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

import { InputError } from '../woocommerce/errors.js';
import { asCount, asDecimal, asString, compact, expectArray, expectRecord, stripLinks } from '../woocommerce/json.js';
import { pageQuery, type Page, type Runtime, type ToolContext } from './context.js';
import { toolNames } from './names.js';
import { DESTRUCTIVE, defineTool, READ } from './registry.js';
import { createRefundInput, getRefundInput, listRefundsInput, moneyToString } from './schemas.js';

export type ListRefundsInput = z.infer<typeof listRefundsInput>;
export type GetRefundInput = z.infer<typeof getRefundInput>;
export type CreateRefundInput = z.infer<typeof createRefundInput>;

export interface RefundSummary {
  id: number | null;
  dateCreated: string | null;
  amount: string | null;
  reason: string | null;
  refundedBy: number | null;
  refundedPayment: boolean | null;
  lineItemCount: number;
}

export function registerRefundTools(server: McpServer, runtime: Runtime): void {
  defineTool(server, runtime, {
    name: toolNames.listRefunds,
    title: 'List refunds',
    description: 'List the refunds recorded on an order.',
    input: listRefundsInput,
    annotations: READ,
    write: false,
    run: listRefunds,
  });
  defineTool(server, runtime, {
    name: toolNames.getRefund,
    title: 'Get refund',
    description: 'Get one refund on an order, including refunded line items.',
    input: getRefundInput,
    annotations: READ,
    write: false,
    run: getRefund,
  });
  defineTool(server, runtime, {
    name: toolNames.createRefund,
    title: 'Create refund',
    description:
      'Record a refund on an order, by total amount or by line items. By default this records a manual refund and does not move money; set apiRefund: true to ask the payment gateway to return the funds. Refunds cannot be undone.',
    input: createRefundInput,
    annotations: DESTRUCTIVE,
    write: true,
    run: createRefund,
  });
}

export function summarizeRefund(value: unknown): RefundSummary {
  const record = expectRecord(value, 'refund');
  const lines = Array.isArray(record.line_items) ? record.line_items : [];
  return {
    id: asCount(record.id),
    dateCreated: asString(record.date_created_gmt) ?? asString(record.date_created),
    amount: asDecimal(record.amount),
    reason: asString(record.reason),
    refundedBy: asCount(record.refunded_by),
    refundedPayment: typeof record.refunded_payment === 'boolean' ? record.refunded_payment : null,
    lineItemCount: lines.length,
  };
}

export async function listRefunds(ctx: ToolContext, input: ListRefundsInput): Promise<Page<RefundSummary>> {
  const paging = pageQuery(input, ctx.defaultPerPage);
  const response = await ctx.client.get(`orders/${input.orderId}/refunds`, paging);
  return {
    items: expectArray(response.data, 'refund list').map((item) => summarizeRefund(item)),
    pagination: {
      page: paging.page,
      perPage: paging.per_page,
      total: response.pagination.total,
      totalPages: response.pagination.totalPages,
    },
  };
}

export async function getRefund(ctx: ToolContext, input: GetRefundInput): Promise<unknown> {
  const response = await ctx.client.get(`orders/${input.orderId}/refunds/${input.refundId}`);
  return stripLinks(expectRecord(response.data, 'refund'));
}

export async function createRefund(ctx: ToolContext, input: CreateRefundInput): Promise<unknown> {
  const response = await ctx.client.post(`orders/${input.orderId}/refunds`, toRefundPayload(input));
  return stripLinks(expectRecord(response.data, 'refund'));
}

export function toRefundPayload(input: CreateRefundInput): Record<string, unknown> {
  if (input.amount === undefined && input.lineItems === undefined) {
    throw new InputError('Provide amount, lineItems, or both.');
  }
  const lineItems = input.lineItems?.map((line) =>
    compact({
      id: line.id,
      quantity: line.quantity,
      refund_total: moneyToString(line.refundTotal),
      refund_tax: line.refundTax?.map((tax) => ({ id: tax.id, refund_total: moneyToString(tax.refundTotal) })),
    }),
  );
  return compact({
    amount: input.amount === undefined ? undefined : moneyToString(input.amount),
    reason: input.reason,
    line_items: lineItems,
    api_refund: input.apiRefund ?? false,
    restock_items: input.restockItems,
  });
}
