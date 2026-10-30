import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

import { expectArray, expectRecord, stripLinks } from '../woocommerce/json.js';
import { summarizeCustomer } from '../woocommerce/present.js';
import { pageQuery, type Page, type ToolContext } from './context.js';
import { toolNames } from './names.js';
import { execute } from './result.js';
import { getCustomerInput, listCustomersInput } from './schemas.js';

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export type ListCustomersInput = z.infer<typeof listCustomersInput>;
export type GetCustomerInput = z.infer<typeof getCustomerInput>;

export function registerCustomerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    toolNames.listCustomers,
    {
      title: 'List customers',
      description: 'List customers. Returns id, name, email, role, and pagination. Customer records can contain personal data.',
      inputSchema: listCustomersInput,
      annotations: readAnnotations,
    },
    async (input) => execute(ctx, toolNames.listCustomers, false, () => listCustomers(ctx, input)),
  );

  server.registerTool(
    toolNames.getCustomer,
    {
      title: 'Get customer',
      description: 'Get one customer by ID, without the REST _links payload. The record can contain personal data.',
      inputSchema: getCustomerInput,
      annotations: readAnnotations,
    },
    async (input) => execute(ctx, toolNames.getCustomer, false, () => getCustomer(ctx, input)),
  );
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
