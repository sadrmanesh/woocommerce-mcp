import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

import { compact, expectArray, expectRecord, stripLinks } from '../woocommerce/json.js';
import { summarizeNote, summarizeOrder } from '../woocommerce/present.js';
import { pageQuery, type Page, type ToolContext } from './context.js';
import { toolNames, WRITE_NOTE } from './names.js';
import { execute } from './result.js';
import { addOrderNoteInput, getOrderInput, listOrdersInput, updateOrderStatusInput } from './schemas.js';

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

const noteAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export type ListOrdersInput = z.infer<typeof listOrdersInput>;
export type GetOrderInput = z.infer<typeof getOrderInput>;
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusInput>;
export type AddOrderNoteInput = z.infer<typeof addOrderNoteInput>;

export function registerOrderTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    toolNames.listOrders,
    {
      title: 'List orders',
      description: 'List orders. Each item includes status, total, customer, and up to three line items, plus pagination.',
      inputSchema: listOrdersInput,
      annotations: readAnnotations,
    },
    async (input) => execute(ctx, toolNames.listOrders, false, () => listOrders(ctx, input)),
  );

  server.registerTool(
    toolNames.getOrder,
    {
      title: 'Get order',
      description: 'Get one order by ID, including line items, shipping, and billing, without the REST _links payload.',
      inputSchema: getOrderInput,
      annotations: readAnnotations,
    },
    async (input) => execute(ctx, toolNames.getOrder, false, () => getOrder(ctx, input)),
  );

  server.registerTool(
    toolNames.updateOrderStatus,
    {
      title: 'Update order status',
      description: `Change an order's status. This does not create a refund by itself. ${WRITE_NOTE}`,
      inputSchema: updateOrderStatusInput,
      annotations: updateAnnotations,
    },
    async (input) => execute(ctx, toolNames.updateOrderStatus, true, () => updateOrderStatus(ctx, input)),
  );

  server.registerTool(
    toolNames.addOrderNote,
    {
      title: 'Add order note',
      description: `Add a note to an order. Set customerNote when the customer should see it. ${WRITE_NOTE}`,
      inputSchema: addOrderNoteInput,
      annotations: noteAnnotations,
    },
    async (input) => execute(ctx, toolNames.addOrderNote, true, () => addOrderNote(ctx, input)),
  );
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
