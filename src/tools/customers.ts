import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

import { redactPersonalData } from '../redact.js';
import { InputError } from '../woocommerce/errors.js';
import { asCount, asString, compact, expectArray, expectRecord, isRecord, stripLinks } from '../woocommerce/json.js';
import { summarizeCustomer, summarizeOrder } from '../woocommerce/present.js';
import { pageQuery, type Page, type Runtime, type ToolContext } from './context.js';
import { toolNames } from './names.js';
import { money, scanOrders, toUnits } from './order-scan.js';
import { defineTool, READ, UPDATE } from './registry.js';
import {
  customerOrdersInput,
  customerSegmentsInput,
  getCustomerRedactableInput,
  listCustomersRedactableInput,
  updateCustomerInput,
} from './schemas.js';

export type ListCustomersInput = z.infer<typeof listCustomersRedactableInput>;
export type GetCustomerInput = z.infer<typeof getCustomerRedactableInput>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerInput>;
export type CustomerOrdersInput = z.infer<typeof customerOrdersInput>;
export type CustomerSegmentsInput = z.infer<typeof customerSegmentsInput>;

const PII_NOTE = 'Customer records contain personal data; pass redactPii: true to mask it.';

export function registerCustomerTools(server: McpServer, runtime: Runtime): void {
  defineTool(server, runtime, {
    name: toolNames.listCustomers,
    title: 'List customers',
    description: `List customers. Returns id, name, email, role, and pagination. ${PII_NOTE}`,
    input: listCustomersRedactableInput,
    annotations: READ,
    write: false,
    run: listCustomers,
  });
  defineTool(server, runtime, {
    name: toolNames.getCustomer,
    title: 'Get customer',
    description: `Get one customer by ID, without the REST _links payload. ${PII_NOTE}`,
    input: getCustomerRedactableInput,
    annotations: READ,
    write: false,
    run: getCustomer,
  });
  defineTool(server, runtime, {
    name: toolNames.updateCustomer,
    title: 'Update customer',
    description: 'Update a customer email, name, or billing and shipping address. Only the fields you pass are changed.',
    input: updateCustomerInput,
    annotations: UPDATE,
    write: true,
    run: updateCustomer,
  });
  defineTool(server, runtime, {
    name: toolNames.customerOrders,
    title: 'Customer orders',
    description: `Summarize one customer's order history: order count, total spent, average order value, first and last order, and recent orders. ${PII_NOTE}`,
    input: customerOrdersInput,
    annotations: READ,
    write: false,
    run: customerOrders,
  });
  defineTool(server, runtime, {
    name: toolNames.customerSegments,
    title: 'Customer segments',
    description: `Group the customers who ordered in a date range into VIP, repeat, one-time, at-risk, and guest segments, with counts, spend, and the top members of each. ${PII_NOTE}`,
    input: customerSegmentsInput,
    annotations: READ,
    write: false,
    run: customerSegments,
  });
}

function mask<T>(value: T, redact: boolean | undefined): T {
  return redact === true ? (redactPersonalData(value) as T) : value;
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
  return mask(
    {
      items: expectArray(response.data, 'customer list').map((item) => summarizeCustomer(item)),
      pagination: {
        page: paging.page,
        perPage: paging.per_page,
        total: response.pagination.total,
        totalPages: response.pagination.totalPages,
      },
    },
    input.redactPii,
  );
}

export async function getCustomer(ctx: ToolContext, input: GetCustomerInput): Promise<unknown> {
  const response = await ctx.client.get(`customers/${input.id}`);
  return mask(stripLinks(expectRecord(response.data, 'customer')), input.redactPii);
}

function addressPayload(address: Record<string, string | undefined> | undefined): Record<string, unknown> | undefined {
  if (address === undefined) return undefined;
  const payload = compact({
    first_name: address.firstName,
    last_name: address.lastName,
    company: address.company,
    address_1: address.address1,
    address_2: address.address2,
    city: address.city,
    state: address.state,
    postcode: address.postcode,
    country: address.country,
    phone: address.phone,
    email: address.email,
  });
  return Object.keys(payload).length === 0 ? undefined : payload;
}

export async function updateCustomer(ctx: ToolContext, input: UpdateCustomerInput): Promise<unknown> {
  const payload = compact({
    email: input.email,
    first_name: input.firstName,
    last_name: input.lastName,
    billing: addressPayload(input.billing),
    shipping: addressPayload(input.shipping),
  });
  if (Object.keys(payload).length === 0) throw new InputError('Pass at least one customer field to change.');
  const response = await ctx.client.put(`customers/${input.id}`, payload);
  return summarizeCustomer(response.data);
}

export async function customerOrders(ctx: ToolContext, input: CustomerOrdersInput): Promise<unknown> {
  const customer = await ctx.client.get(`customers/${input.customerId}`);
  const recentCount = input.recent ?? 10;
  const orders: Record<string, unknown>[] = [];
  let spent = 0;
  let paid = 0;
  const { scanned, truncated } = await scanOrders(
    ctx,
    { query: { customer: input.customerId, order: 'desc' }, maxOrders: input.maxOrders ?? 200 },
    (order) => {
      orders.push(order);
      const status = asString(order.status);
      if (status === 'processing' || status === 'completed') {
        spent += toUnits(order.total);
        paid += 1;
      }
    },
  );
  const dates = orders
    .map((order) => asString(order.date_created_gmt) ?? asString(order.date_created))
    .filter((value): value is string => value !== null)
    .sort();
  return mask(
    {
      customer: summarizeCustomer(customer.data),
      orders: scanned,
      paidOrders: paid,
      totalSpent: money(spent),
      averageOrderValue: paid === 0 ? null : money(Math.round(spent / paid)),
      firstOrder: dates[0] ?? null,
      lastOrder: dates.at(-1) ?? null,
      truncated,
      note: 'Totals count processing and completed orders only.',
      recent: orders.slice(0, recentCount).map((order) => summarizeOrder(order)),
    },
    input.redactPii,
  );
}

interface Shopper {
  key: string;
  customerId: number | null;
  email: string | null;
  customerName: string | null;
  orders: number;
  spent: number;
  firstOrder: string | null;
  lastOrder: string | null;
}

interface SegmentView {
  customers: number;
  spent: string;
  members: {
    customerId: number | null;
    email: string | null;
    customerName: string | null;
    orders: number;
    spent: string;
    lastOrder: string | null;
  }[];
}

export async function customerSegments(ctx: ToolContext, input: CustomerSegmentsInput): Promise<unknown> {
  const statuses = input.statuses ?? ['processing', 'completed'];
  const vipShare = input.vipShare ?? 10;
  const atRiskDays = input.atRiskDays ?? 60;
  const memberLimit = input.membersPerSegment ?? 10;
  const reference = input.before === undefined ? Date.now() : Date.parse(input.before);
  const shoppers = new Map<string, Shopper>();
  let unattributed = 0;

  const { scanned, truncated } = await scanOrders(
    ctx,
    {
      query: { status: statuses.join(','), after: input.after, before: input.before },
      maxOrders: input.maxOrders ?? 2_000,
    },
    (order) => {
      const customerId = asCount(order.customer_id);
      const billing = isRecord(order.billing) ? order.billing : {};
      const email = asString(billing.email)?.trim().toLowerCase() || null;
      const key = customerId !== null && customerId > 0 ? `customer:${customerId}` : email ? `guest:${email}` : null;
      if (key === null) {
        unattributed += 1;
        return;
      }
      const date = asString(order.date_created_gmt) ?? asString(order.date_created);
      const name = [asString(billing.first_name), asString(billing.last_name)].filter(Boolean).join(' ') || null;
      const shopper = shoppers.get(key) ?? {
        key,
        customerId: customerId !== null && customerId > 0 ? customerId : null,
        email,
        customerName: name,
        orders: 0,
        spent: 0,
        firstOrder: date,
        lastOrder: date,
      };
      shopper.orders += 1;
      shopper.spent += toUnits(order.total);
      if (date !== null) {
        if (shopper.firstOrder === null || date < shopper.firstOrder) shopper.firstOrder = date;
        if (shopper.lastOrder === null || date > shopper.lastOrder) shopper.lastOrder = date;
      }
      shoppers.set(key, shopper);
    },
  );

  const all = [...shoppers.values()].sort((a, b) => b.spent - a.spent || b.orders - a.orders);
  const vipCount = all.length === 0 ? 0 : Math.max(1, Math.floor((all.length * vipShare) / 100));
  const cutoff = reference - atRiskDays * 86_400_000;
  const lastSeen = (shopper: Shopper): number => {
    if (shopper.lastOrder === null) return Number.NaN;
    const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(shopper.lastOrder) ? shopper.lastOrder : `${shopper.lastOrder}Z`;
    return Date.parse(iso);
  };
  const view = (members: Shopper[]): SegmentView => ({
    customers: members.length,
    spent: money(members.reduce((sum, member) => sum + member.spent, 0)),
    members: members.slice(0, memberLimit).map((member) => ({
      customerId: member.customerId,
      email: member.email,
      customerName: member.customerName,
      orders: member.orders,
      spent: money(member.spent),
      lastOrder: member.lastOrder,
    })),
  });

  return mask(
    {
      range: { after: input.after, before: input.before ?? null },
      scanned,
      truncated,
      customers: all.length,
      unattributedOrders: unattributed,
      rules: {
        vip: `top ${vipShare}% of customers by spend`,
        repeat: '2 or more orders',
        oneTime: 'exactly 1 order',
        atRisk: `repeat customers whose last order is more than ${atRiskDays} days before the end of the range`,
        guests: 'orders without a customer account, grouped by billing email',
      },
      segments: {
        vip: view(all.slice(0, vipCount)),
        repeat: view(all.filter((shopper) => shopper.orders >= 2)),
        oneTime: view(all.filter((shopper) => shopper.orders === 1)),
        atRisk: view(all.filter((shopper) => shopper.orders >= 2 && lastSeen(shopper) < cutoff)),
        guests: view(all.filter((shopper) => shopper.customerId === null)),
      },
      note: 'Only orders inside the range are counted, so lifetime values can be higher.',
    },
    input.redactPii,
  );
}
