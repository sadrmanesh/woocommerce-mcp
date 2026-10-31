import { McpServer } from '@modelcontextprotocol/server';

import { ApprovalVerifier } from './approval.js';
import { createAuditLog, type AuditLog } from './audit.js';
import { type AppConfig, clientOptions } from './config.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import type { Runtime } from './tools/context.js';
import { registerTools } from './tools/register.js';
import { VERSION } from './version.js';
import { WebhookEventStore } from './webhooks.js';
import { type ClientHooks, WooCommerceClient } from './woocommerce/client.js';

const INSTRUCTIONS = [
  'Use these tools to read and manage WooCommerce stores through the REST API.',
  'Call woocommerce_list_stores first when more than one store may be configured, and pass its id as store. Without store, the default store is used.',
  'List tools return a short summary and pagination. Get tools return the REST resource without _links.',
  'Write tools are refused for read-only stores, which is the default.',
  'When a write tool returns status confirmation_required, nothing was changed: show the request to the user and call the tool again with confirm: true and the returned previewId only after they approve it. If the confirm fails with stale_preview, the store data changed since the preview: request a fresh preview and show it to the user again. dryRun: true always previews without writing.',
  'Refunds cannot be undone. create_refund records a manual refund unless apiRefund is true.',
  'Prices are decimal strings or numbers. Report dates are YYYY-MM-DD. Order and product date filters are ISO-8601 date-times.',
  'Prefer draft status when creating products unless the user asked to publish.',
  'Some stores mask customer personal data; masked values look like [redacted] or j***@example.com. Do not try to recover them.',
  'Recent webhook deliveries are readable with woocommerce_list_webhook_events and the woocommerce://stores/{store}/events resources.',
].join(' ');

/** Added to the instructions when WOOCOMMERCE_APPROVAL_SECRET is set. */
const APPROVAL_INSTRUCTIONS =
  'This server requires a signed approval for every write. After the user reviews a confirmation_required preview, they approve its previewId outside this conversation and give you an approval token. Call the tool again with the same arguments, confirm: true, the previewId, and approval set to that token. You cannot create an approval yourself, so never try. If the confirm fails with approval_expired, approval_mismatch, approval_replayed, or stale_preview, request a fresh preview and ask the user for a new approval.';

export interface RuntimeOptions {
  audit?: AuditLog;
  hooks?: ClientHooks;
  scopesEnforced?: boolean;
  events?: WebhookEventStore;
  /** Clock for approval tokens, in Unix seconds. For tests. */
  approvalNow?: () => number;
}

/** Builds one client per configured store plus the shared tool runtime. */
export function createRuntime(config: AppConfig, options: RuntimeOptions = {}): Runtime {
  return {
    stores: config.stores.map((store) => ({
      config: store,
      client: new WooCommerceClient(clientOptions(config, store), options.hooks),
    })),
    defaultStore: config.defaultStore,
    defaultPerPage: config.defaultPerPage,
    requireConfirmation: config.requireConfirmation,
    approval:
      config.approvalSecret === null
        ? null
        : new ApprovalVerifier({
            secret: config.approvalSecret,
            maxTtlSeconds: config.approvalTtlSeconds,
            ...(options.approvalNow ? { now: options.approvalNow } : {}),
          }),
    audit: options.audit ?? createAuditLog(config.auditLog),
    scopesEnforced: options.scopesEnforced ?? config.httpAuth !== null,
    tools: config.tools,
    events: options.events ?? new WebhookEventStore(config.webhookBuffer),
    trackingMode: config.trackingMode,
  };
}

export interface CreateServerOptions {
  runtime: Runtime;
}

export function createServer(options: CreateServerOptions): McpServer {
  const instructions = options.runtime.approval === null ? INSTRUCTIONS : `${INSTRUCTIONS} ${APPROVAL_INSTRUCTIONS}`;
  const server = new McpServer({ name: 'woocommerce-mcp', version: VERSION }, { instructions });
  registerTools(server, options.runtime);
  registerResources(server, options.runtime);
  registerPrompts(server);
  return server;
}
