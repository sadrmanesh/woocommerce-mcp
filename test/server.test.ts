import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { type AuditEntry, memoryAuditLog } from '../src/audit.js';
import type { AppConfig } from '../src/config.js';
import { main } from '../src/index.js';
import { PROMPT_NAMES } from '../src/prompts.js';
import { createServer } from '../src/server.js';
import { TOOL_NAMES, toolNames, WRITE_TOOLS } from '../src/tools/names.js';
import { VERSION } from '../src/version.js';
import { createFetchMock, jsonResponse, testRuntime, testStore, type RecordedRequest } from './helpers.js';

describe('MCP server', () => {
  it('matches the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(pkg.version, VERSION);
    assert.equal(VERSION, '0.3.2');
    assert.equal(TOOL_NAMES.length, 47);
    assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length);
  });

  it('rejects a start without store credentials', async () => {
    await assert.rejects(
      () => main({ PATH: '/usr/bin' }, { loadDotEnv: false, signals: false, quiet: true }),
      /Invalid configuration/,
    );
  });

  it('advertises every tool and enforces read-only mode over the protocol', async () => {
    const { fetchImpl, requests } = createFetchMock(async (request) => productResponse(request));
    await withClient(fetchImpl, {}, async (client) => {
      const listed = await client.listTools();
      const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
      for (const name of TOOL_NAMES) {
        const tool = byName.get(name);
        assert.ok(tool, `missing tool ${name}`);
        assert.equal(tool.annotations?.readOnlyHint, !WRITE_TOOLS.has(name), `readOnlyHint for ${name}`);
        const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
        if (name !== toolNames.listStores) assert.ok('store' in properties, `${name} takes store`);
        assert.equal('confirm' in properties, WRITE_TOOLS.has(name), `${name} confirm flag`);
      }
      assert.equal(byName.get(toolNames.createProduct)?.annotations?.destructiveHint, false);
      assert.equal(byName.get(toolNames.updateOrderStatus)?.annotations?.destructiveHint, true);
      assert.equal(byName.get(toolNames.createRefund)?.annotations?.destructiveHint, true);
      assert.equal(byName.get(toolNames.updateStock)?.annotations?.idempotentHint, true);

      const beforeInvalid = requests.length;
      const invalid = await client.callTool({ name: toolNames.getProduct, arguments: { id: 0 } });
      assert.equal(invalid.isError, true);
      assert.match(textOf(invalid), /Input validation error/);
      assert.equal(requests.length, beforeInvalid);

      const listedProducts = await client.callTool({
        name: toolNames.listProducts,
        arguments: { search: 'scarf', perPage: 5 },
      });
      assert.equal(listedProducts.isError, undefined);
      const text = textOf(listedProducts);
      assert.match(text, /Wool scarf/);
      assert.equal(text.includes('_links'), false);

      const blocked = await client.callTool({ name: toolNames.createProduct, arguments: { name: 'Hat', confirm: true } });
      assert.equal(blocked.isError, true);
      assert.match(textOf(blocked), /read_only/);
      assert.equal(
        requests.some((request) => request.method === 'POST'),
        false,
      );
    });
  });

  it('asks for confirmation before a write and applies it on confirm', async () => {
    const { fetchImpl, requests } = createFetchMock(async (request) => productResponse(request));
    const audit = memoryAuditLog();
    await withClient(fetchImpl, { stores: [testStore({ readOnly: false })] }, async (client) => {
      const preview = await client.callTool({ name: toolNames.createProduct, arguments: { name: 'Hat', status: 'draft' } });
      assert.notEqual(preview.isError, true);
      const planned = JSON.parse(textOf(preview)) as { status: string; request: { method: string; path: string; body: unknown } };
      assert.equal(planned.status, 'confirmation_required');
      assert.equal(planned.request.method, 'POST');
      assert.equal(planned.request.path, 'products');
      assert.deepEqual(planned.request.body, { name: 'Hat', status: 'draft' });
      assert.equal(requests.length, 0);

      const created = await client.callTool({
        name: toolNames.createProduct,
        arguments: { name: 'Hat', status: 'draft', confirm: true },
      });
      assert.notEqual(created.isError, true);
      const post = requests.find((request) => request.method === 'POST');
      assert.ok(post);
      assert.deepEqual(JSON.parse(post.body ?? '{}'), { name: 'Hat', status: 'draft' });
    }, audit);
    assert.deepEqual(
      audit.entries.map((entry: AuditEntry) => entry.outcome),
      ['confirmation_required', 'applied'],
    );
    assert.equal(audit.entries[1]?.tool, toolNames.createProduct);
    assert.equal(audit.entries[1]?.store, 'default');
  });

  it('routes calls to the named store and lists stores', async () => {
    const { fetchImpl, requests } = createFetchMock(async (request) => productResponse(request));
    const stores = [testStore({ id: 'eu', url: 'https://eu.example.com' }), testStore({ id: 'us', url: 'https://us.example.com' })];
    await withClient(fetchImpl, { stores, defaultStore: 'eu' }, async (client) => {
      const listed = JSON.parse(textOf(await client.callTool({ name: toolNames.listStores, arguments: {} }))) as {
        stores: { id: string; default: boolean; host: string }[];
      };
      assert.deepEqual(
        listed.stores.map((store) => [store.id, store.default, store.host]),
        [
          ['eu', true, 'eu.example.com'],
          ['us', false, 'us.example.com'],
        ],
      );
      await client.callTool({ name: toolNames.listProducts, arguments: {} });
      await client.callTool({ name: toolNames.listProducts, arguments: { store: 'us' } });
      assert.match(requests[0]?.url ?? '', /^https:\/\/eu\.example\.com\//);
      assert.match(requests[1]?.url ?? '', /^https:\/\/us\.example\.com\//);
      const unknown = await client.callTool({ name: toolNames.listProducts, arguments: { store: 'mars' } });
      assert.equal(unknown.isError, true);
      assert.match(textOf(unknown), /unknown_store/);
    });
  });

  it('serves store resources and prompts', async () => {
    const { fetchImpl, requests } = createFetchMock(async (request) => {
      if (request.url.includes('/orders/5')) return jsonResponse({ id: 5, status: 'processing', _links: {} });
      return jsonResponse({ id: 7, name: 'Wool scarf', _links: {} });
    });
    await withClient(fetchImpl, {}, async (client) => {
      const resources = await client.listResources();
      assert.ok(resources.resources.some((resource) => resource.uri === 'woocommerce://stores'));
      const templates = await client.listResourceTemplates();
      assert.deepEqual(templates.resourceTemplates.map((template) => template.uriTemplate).sort(), [
        'woocommerce://stores/{store}/events',
        'woocommerce://stores/{store}/events/{id}',
        'woocommerce://stores/{store}/orders/{id}',
        'woocommerce://stores/{store}/products/{id}',
      ]);
      const product = await client.readResource({ uri: 'woocommerce://stores/default/products/7' });
      const first = product.contents[0];
      assert.ok(first && 'text' in first);
      assert.match(first.text, /Wool scarf/);
      assert.equal(first.text.includes('_links'), false);
      const order = await client.readResource({ uri: 'woocommerce://stores/default/orders/5' });
      assert.ok(order.contents[0] && 'text' in order.contents[0]);
      assert.match(requests[1]?.url ?? '', /orders\/5/);

      const prompts = await client.listPrompts();
      assert.deepEqual(prompts.prompts.map((prompt) => prompt.name).sort(), [...PROMPT_NAMES].sort());
      const briefing = await client.getPrompt({ name: 'sales_briefing', arguments: { period: 'month', store: 'default' } });
      const message = briefing.messages[0];
      assert.ok(message && message.content.type === 'text');
      assert.match(message.content.text, /last month/);
      assert.match(message.content.text, /woocommerce_sales_analytics/);
    });
  });
});

async function withClient(
  fetchImpl: typeof fetch,
  overrides: Partial<AppConfig>,
  run: (client: Client) => Promise<void>,
  audit = memoryAuditLog(),
): Promise<void> {
  const runtime = testRuntime(fetchImpl, overrides, { audit });
  const handler = createMcpHandler(() => createServer({ runtime }));
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'woocommerce-mcp-test', version: '0.3.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  try {
    await run(client);
  } finally {
    await client.close();
    await handler.close();
  }
}

function productResponse(request: RecordedRequest): Response {
  if (request.method === 'POST') return jsonResponse({ id: 9, name: 'Hat', status: 'draft' });
  return jsonResponse(
    [
      {
        id: 7,
        name: 'Wool scarf',
        sku: 'SCARF',
        price: '25.00',
        stock_status: 'instock',
        _links: { self: [] },
      },
    ],
    { headers: { 'x-wp-total': '1', 'x-wp-totalpages': '1' } },
  );
}

function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('Expected a text result');
  }
  return block.text;
}
