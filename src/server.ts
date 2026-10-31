import { McpServer } from '@modelcontextprotocol/server';

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
  'When a write tool returns status confirmation_required, nothing was changed: show the request to the user and call the tool again with confirm: true and the returned previewId only after they approve it. dryRun: true always previews without writing.',
  'Refunds cannot be undone. create_refund records a manual refund unless apiRefund is true.',
  'Prices are decimal strings or numbers. Report dates are YYYY-MM-DD. Order and product date filters are ISO-8601 date-times.',
  'Prefer draft status when creating products unless the user asked to publish.',
  'Some stores mask customer personal data; masked values look like [redacted] or j***@example.com. Do not try to recover them.',
  'Recent webhook deliveries are readable with woocommerce_list_webhook_events and the woocommerce://stores/{store}/events resources.',
].join(' ');

export interface RuntimeOptions {
  audit?: AuditLog;
  hooks?: ClientHooks;
  scopesEnforced?: boolean;
  events?: WebhookEventStore;
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
  const server = new McpServer({ name: 'woocommerce-mcp', version: VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, options.runtime);
  registerResources(server, options.runtime);
  registerPrompts(server);
  return server;
}
