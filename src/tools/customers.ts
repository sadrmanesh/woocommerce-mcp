import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

import { expectArray, expectRecord, stripLinks } from '../woocommerce/json.js';
import { summarizeCustomer } from '../woocommerce/present.js';
import { pageQuery, type Page, type Runtime, type ToolContext } from './context.js';
import { toolNames } from './names.js';
import { defineTool, READ } from './registry.js';
import { getCustomerInput, listCustomersInput } from './schemas.js';

export type ListCustomersInput = z.infer<typeof listCustomersInput>;
export type GetCustomerInput = z.infer<typeof getCustomerInput>;

export function registerCustomerTools(server: McpServer, runtime: Runtime): void {
  defineTool(server, runtime, {
    name: toolNames.listCustomers,
    title: 'List customers',
    description: 'List customers. Returns id, name, email, role, and pagination. Customer records can contain personal data.',
    input: listCustomersInput,
    annotations: READ,
    write: false,
    run: listCustomers,
  });
  defineTool(server, runtime, {
    name: toolNames.getCustomer,
    title: 'Get customer',
    description: 'Get one customer by ID, without the REST _links payload. The record can contain personal data.',
    input: getCustomerInput,
    annotations: READ,
    write: false,
    run: getCustomer,
  });
}

export async function listCustomers(
  ctx: ToolContext,
  input: ListCustomersInput,
): Promise<Page<ReturnType<typeof summarizeCustomer>>> {
  const paging = pageQuery(input, ctx.defaultPerPage);
  const response = await ctx.client.get('customers', {
    ...paging,
    search: input.search,
    email: input.email,
    role: input.role,
    orderby: input.orderBy,
    order: input.order,
  });
  return {
    items: expectArray(response.data, 'customer list').map((item) => summarizeCustomer(item)),
    pagination: {
      page: paging.page,
      perPage: paging.per_page,
      total: response.pagination.total,
      totalPages: response.pagination.totalPages,
    },
  };
}

export async function getCustomer(ctx: ToolContext, input: GetCustomerInput): Promise<unknown> {
  const response = await ctx.client.get(`customers/${input.id}`);
  return stripLinks(expectRecord(response.data, 'customer'));
}
