import { McpServer } from '@modelcontextprotocol/server';

import type { AppConfig } from './config.js';
import { registerTools } from './tools/register.js';
import { VERSION } from './version.js';
import type { WooCommerceClient } from './woocommerce/client.js';

const INSTRUCTIONS = [
  'Use these tools to read and manage one WooCommerce store through its REST API.',
  'List tools return a short summary and pagination. Get tools return the REST resource without _links.',
  'Write tools are refused while read-only mode is on, which is the default.',
  'Prices are decimal strings or numbers. Report dates are YYYY-MM-DD. Order and product date filters are ISO-8601 date-times.',
  'Prefer draft status when creating products unless the user asked to publish.',
].join(' ');

export interface CreateServerOptions {
  config: AppConfig;
  client: WooCommerceClient;
}

export function createServer(options: CreateServerOptions): McpServer {
  const server = new McpServer(
    { name: 'woocommerce-mcp', version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, {
    client: options.client,
    defaultPerPage: options.config.defaultPerPage,
    readOnly: options.config.readOnly,
  });
  return server;
}
