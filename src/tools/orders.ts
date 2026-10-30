import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

import { compact, expectArray, expectRecord, stripLinks } from '../woocommerce/json.js';
import { summarizeNote, summarizeOrder } from '../woocommerce/present.js';
import { pageQuery, type Page, type Runtime, type ToolContext } from './context.js';
import { toolNames } from './names.js';
import { CREATE, defineTool, READ, UPDATE } from './registry.js';
import { addOrderNoteInput, getOrderInput, listOrdersInput, updateOrderStatusInput } from './schemas.js';

export type ListOrdersInput = z.infer<typeof listOrdersInput>;
export type GetOrderInput = z.infer<typeof getOrderInput>;
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusInput>;
export type AddOrderNoteInput = z.infer<typeof addOrderNoteInput>;

export function registerOrderTools(server: McpServer, runtime: Runtime): void {
  defineTool(server, runtime, {
    name: toolNames.listOrders,
    title: 'List orders',
    description: 'List orders. Each item includes status, total, customer, and up to three line items, plus pagination.',
    input: listOrdersInput,
    annotations: READ,
    write: false,
    run: listOrders,
  });
  defineTool(server, runtime, {
    name: toolNames.getOrder,
    title: 'Get order',
    description: 'Get one order by ID, including line items, shipping, and billing, without the REST _links payload.',
    input: getOrderInput,
    annotations: READ,
    write: false,
    run: getOrder,
  });
  defineTool(server, runtime, {
    name: toolNames.updateOrderStatus,
    title: 'Update order status',
    description: "Change an order's status. This does not create a refund by itself; use woocommerce_create_refund for that.",
    input: updateOrderStatusInput,
    annotations: UPDATE,
    write: true,
    run: updateOrderStatus,
  });
  defineTool(server, runtime, {
    name: toolNames.addOrderNote,
    title: 'Add order note',
    description: 'Add a note to an order. Set customerNote when the customer should see it.',
    input: addOrderNoteInput,
    annotations: CREATE,
    write: true,
    run: addOrderNote,
  });
}

export async function listOrders(ctx: ToolContext, input: ListOrdersInput): Promise<Page<ReturnType<typeof summarizeOrder>>> {
  const paging = pageQuery(input, ctx.defaultPerPage);
  const response = await ctx.client.get('orders', {
    ...paging,
    search: input.search,
    status: input.status,
    customer: input.customer,
    product: input.product,
    after: input.after,
    before: input.before,
    orderby: input.orderBy,
    order: input.order,
  });
  return {
    items: expectArray(response.data, 'order list').map((item) => summarizeOrder(item)),
    pagination: {
      page: paging.page,
      perPage: paging.per_page,
      total: response.pagination.total,
      totalPages: response.pagination.totalPages,
    },
  };
}

export async function getOrder(ctx: ToolContext, input: GetOrderInput): Promise<unknown> {
  const response = await ctx.client.get(`orders/${input.id}`);
  return stripLinks(expectRecord(response.data, 'order'));
}

export async function updateOrderStatus(ctx: ToolContext, input: UpdateOrderStatusInput) {
  const response = await ctx.client.put(`orders/${input.id}`, { status: input.status });
  return summarizeOrder(response.data);
}

export async function addOrderNote(ctx: ToolContext, input: AddOrderNoteInput) {
  const response = await ctx.client.post(
    `orders/${input.orderId}/notes`,
    compact({
      note: input.note,
      customer_note: input.customerNote,
    }),
  );
  return summarizeNote(response.data, input.orderId);
}
