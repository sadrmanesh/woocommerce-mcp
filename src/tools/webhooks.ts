import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

import { redactPersonalData } from '../redact.js';
import { summarizeEvent, type WebhookEvent } from '../webhooks.js';
import { InputError } from '../woocommerce/errors.js';
import { asCount, asString, compact, expectArray, expectRecord } from '../woocommerce/json.js';
import { pageQuery, type Runtime, type ToolContext } from './context.js';
import { toolNames } from './names.js';
import { CREATE, defineTool, DESTRUCTIVE, READ, UPDATE } from './registry.js';
import {
  createWebhookInput,
  deleteWebhookInput,
  getWebhookInput,
  listWebhookEventsInput,
  listWebhooksInput,
  updateWebhookInput,
} from './schemas.js';

export type ListWebhooksInput = z.infer<typeof listWebhooksInput>;
export type GetWebhookInput = z.infer<typeof getWebhookInput>;
export type CreateWebhookInput = z.infer<typeof createWebhookInput>;
export type UpdateWebhookInput = z.infer<typeof updateWebhookInput>;
export type DeleteWebhookInput = z.infer<typeof deleteWebhookInput>;
export type ListWebhookEventsInput = z.infer<typeof listWebhookEventsInput>;

export interface WebhookSummary {
  id: number | null;
  name: string | null;
  status: string | null;
  topic: string | null;
  deliveryUrl: string | null;
  hasSecret: boolean;
  dateCreated: string | null;
  dateModified: string | null;
}

/** Webhook records include the signing secret; it is never returned. */
export function summarizeWebhook(value: unknown): WebhookSummary {
  const record = expectRecord(value, 'webhook');
  return {
    id: asCount(record.id),
    name: asString(record.name),
    status: asString(record.status),
    topic: asString(record.topic),
    deliveryUrl: asString(record.delivery_url),
    hasSecret: typeof record.secret === 'string' ? record.secret !== '' : true,
    dateCreated: asString(record.date_created),
    dateModified: asString(record.date_modified),
  };
}

export function registerWebhookTools(server: McpServer, runtime: Runtime): void {
  defineTool(server, runtime, {
    name: toolNames.listWebhooks,
    title: 'List webhooks',
    description: 'List the webhooks configured in WooCommerce with topic, status, and delivery URL. Secrets are never returned.',
    input: listWebhooksInput,
    annotations: READ,
    write: false,
    run: listWebhooks,
  });
  defineTool(server, runtime, {
    name: toolNames.getWebhook,
    title: 'Get webhook',
    description: 'Get one webhook by ID. The secret is never returned.',
    input: getWebhookInput,
    annotations: READ,
    write: false,
    run: getWebhook,
  });
  defineTool(server, runtime, {
    name: toolNames.createWebhook,
    title: 'Create webhook',
    description:
      "Create a webhook for a topic such as order.created. It is signed with this store's configured webhook secret, so deliveries to this server's receiver can be verified. The secret is never shown.",
    input: createWebhookInput,
    annotations: CREATE,
    write: true,
    run: createWebhook,
  });
  defineTool(server, runtime, {
    name: toolNames.updateWebhook,
    title: 'Update webhook',
    description: "Rename, pause, resume, or disable a webhook, change its delivery URL, or reset its secret to this store's configured secret.",
    input: updateWebhookInput,
    annotations: UPDATE,
    write: true,
    run: updateWebhook,
  });
  defineTool(server, runtime, {
    name: toolNames.deleteWebhook,
    title: 'Delete webhook',
    description: 'Delete a webhook permanently.',
    input: deleteWebhookInput,
    annotations: DESTRUCTIVE,
    write: true,
    run: deleteWebhook,
  });
  defineTool(server, runtime, {
    name: toolNames.listWebhookEvents,
    title: 'List webhook events',
    description:
      'List recent webhook deliveries received by this server for the store, newest first. Pass sinceId to poll for new ones. Events are kept in memory only.',
    input: listWebhookEventsInput,
    annotations: READ,
    write: false,
    run: listWebhookEvents,
  });
}

export async function listWebhooks(ctx: ToolContext, input: ListWebhooksInput) {
  const paging = pageQuery(input, ctx.defaultPerPage);
  const response = await ctx.client.get('webhooks', { ...paging, status: input.status });
  return {
    items: expectArray(response.data, 'webhook list').map(summarizeWebhook),
    pagination: {
      page: paging.page,
      perPage: paging.per_page,
      total: response.pagination.total,
      totalPages: response.pagination.totalPages,
    },
  };
}

export async function getWebhook(ctx: ToolContext, input: GetWebhookInput) {
  return summarizeWebhook((await ctx.client.get(`webhooks/${input.id}`)).data);
}

function requireSecret(ctx: ToolContext): string {
  if (ctx.webhookSecret === null) {
    throw new InputError(
      `Store "${ctx.storeId}" has no webhook secret. Set webhookSecret or webhookSecretEnv in the store config (or WOOCOMMERCE_WEBHOOK_SECRET) first.`,
    );
  }
  return ctx.webhookSecret;
}

export async function createWebhook(ctx: ToolContext, input: CreateWebhookInput) {
  const response = await ctx.client.post('webhooks', {
    name: input.name,
    topic: input.topic,
    delivery_url: input.deliveryUrl,
    status: input.status ?? 'active',
    secret: requireSecret(ctx),
  });
  return summarizeWebhook(response.data);
}

export async function updateWebhook(ctx: ToolContext, input: UpdateWebhookInput) {
  const payload = compact({
    name: input.name,
    status: input.status,
    delivery_url: input.deliveryUrl,
    secret: input.rotateSecret === true ? requireSecret(ctx) : undefined,
  });
  if (Object.keys(payload).length === 0) throw new InputError('Pass at least one webhook field to change.');
  return summarizeWebhook((await ctx.client.put(`webhooks/${input.id}`, payload)).data);
}

export async function deleteWebhook(ctx: ToolContext, input: DeleteWebhookInput) {
  const response = await ctx.client.delete(`webhooks/${input.id}`, { force: true });
  return { deleted: true, webhook: summarizeWebhook(response.data) };
}

export function presentEvent(event: WebhookEvent, includePayload: boolean, redact: boolean) {
  if (!includePayload) return summarizeEvent(event);
  return { ...summarizeEvent(event), payload: redact ? redactPersonalData(event.payload) : event.payload };
}

export async function listWebhookEvents(ctx: ToolContext, input: ListWebhookEventsInput) {
  const events = ctx.events.list({
    store: ctx.storeId,
    topic: input.topic,
    sinceId: input.sinceId,
    limit: input.limit ?? 20,
  });
  return {
    store: ctx.storeId,
    buffered: ctx.events.count(ctx.storeId),
    receiverEnabled: ctx.webhookSecret !== null,
    // The registry masks personal data for stores with redactPii, so the payload is passed through here.
    events: events.map((event) => presentEvent(event, input.includePayload ?? false, false)),
  };
}
