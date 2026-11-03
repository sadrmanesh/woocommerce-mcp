import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { createServer } from '../src/server.js';
import { TOOL_NAMES, WRITE_TOOLS } from '../src/tools/names.js';
import { createFetchMock, jsonResponse, testRuntime, testStore } from './helpers.js';

// Every tool the server registers, spelled out so a rename or removal is caught here.
const READ_TOOLS = [
  'woocommerce_list_stores',
  'woocommerce_list_products',
  'woocommerce_search_products',
  'woocommerce_get_product',
  'woocommerce_list_orders',
  'woocommerce_get_order',
  'woocommerce_list_order_notes',
  'woocommerce_get_order_tracking',
  'woocommerce_list_refunds',
  'woocommerce_get_refund',
  'woocommerce_list_customers',
  'woocommerce_get_customer',
  'woocommerce_customer_orders',
  'woocommerce_customer_segments',
  'woocommerce_get_stock',
  'woocommerce_get_store_summary',
  'woocommerce_sales_analytics',
  'woocommerce_low_stock_report',
  'woocommerce_list_coupons',
  'woocommerce_get_coupon',
  'woocommerce_coupon_performance',
  'woocommerce_list_webhooks',
  'woocommerce_get_webhook',
  'woocommerce_list_webhook_events',
  'woocommerce_list_shipping_zones',
  'woocommerce_list_shipping_methods',
  'woocommerce_list_tax_rates',
  'woocommerce_list_tax_classes',
] as const;

const WRITE_TOOL_NAMES = [
  'woocommerce_create_product',
  'woocommerce_update_product',
  'woocommerce_bulk_update_products',
  'woocommerce_bulk_adjust_prices',
  'woocommerce_update_order_status',
  'woocommerce_add_order_note',
  'woocommerce_delete_order_note',
  'woocommerce_fulfill_order',
  'woocommerce_create_refund',
  'woocommerce_update_customer',
  'woocommerce_update_stock',
  'woocommerce_create_coupon',
  'woocommerce_update_coupon',
  'woocommerce_delete_coupon',
  'woocommerce_schedule_sale',
  'woocommerce_end_sale',
  'woocommerce_create_webhook',
  'woocommerce_update_webhook',
  'woocommerce_delete_webhook',
] as const;

const ALL_TOOLS: readonly string[] = [...READ_TOOLS, ...WRITE_TOOL_NAMES];

interface ListedTool {
  name: string;
  description?: string;
  inputSchema: { type?: string; properties?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
}

async function listTools(): Promise<Map<string, ListedTool>> {
  const { fetchImpl } = createFetchMock(async () => jsonResponse([]));
  const runtime = testRuntime(fetchImpl, { stores: [testStore({ readOnly: false })] });
  const handler = createMcpHandler(() => createServer({ runtime }));
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'woocommerce-mcp-test', version: '0.6.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    return new Map(listed.tools.map((tool) => [tool.name, tool as ListedTool]));
  } finally {
    await client.close();
    await handler.close();
  }
}

describe('tool coverage', () => {
  it('lists exactly the registered tool names', () => {
    assert.deepEqual([...ALL_TOOLS].sort(), [...TOOL_NAMES].sort());
    assert.deepEqual([...WRITE_TOOL_NAMES].sort(), [...WRITE_TOOLS].sort());
  });

  it('advertises the same set of tools over the protocol', async () => {
    const tools = await listTools();
    assert.deepEqual([...tools.keys()].sort(), [...ALL_TOOLS].sort());
  });

  for (const name of READ_TOOLS) {
    it(`${name} is a read-only tool with a description and input schema`, async () => {
      const tool = (await toolsOnce()).get(name);
      assert.ok(tool, `${name} is not registered`);
      assert.ok(tool.description && tool.description.length > 20);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.inputSchema.properties?.confirm, undefined);
    });
  }

  for (const name of WRITE_TOOL_NAMES) {
    it(`${name} is a write tool that takes dryRun, confirm and previewId`, async () => {
      const tool = (await toolsOnce()).get(name);
      assert.ok(tool, `${name} is not registered`);
      assert.ok(tool.description?.includes('Write tool'));
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.annotations?.readOnlyHint, false);
      for (const field of ['dryRun', 'confirm', 'previewId']) {
        assert.ok(tool.inputSchema.properties?.[field], `${name} is missing ${field}`);
      }
    });
  }
});

let cached: Promise<Map<string, ListedTool>> | undefined;
function toolsOnce(): Promise<Map<string, ListedTool>> {
  cached ??= listTools();
  return cached;
}
