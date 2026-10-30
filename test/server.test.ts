import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { main } from '../src/index.js';
import { createServer } from '../src/server.js';
import { TOOL_NAMES, toolNames } from '../src/tools/names.js';
import { VERSION } from '../src/version.js';
import { WooCommerceClient } from '../src/woocommerce/client.js';
import { createFetchMock, jsonResponse, testConfig, type RecordedRequest } from './helpers.js';

describe('MCP server', () => {
  it('matches the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(pkg.version, VERSION);
    assert.equal(TOOL_NAMES.length, 16);
  });

  it('rejects a start without store credentials', async () => {
    await assert.rejects(
      () => main({ PATH: '/usr/bin' }, { loadDotEnv: false, signals: false, quiet: true }),
      /Invalid configuration/,
    );
  });

  it('advertises every tool and enforces read-only mode over the protocol', async () => {
    const { fetchImpl, requests } = createFetchMock(async (request) => productResponse(request));
    await withClient(fetchImpl, { readOnly: true }, async (client) => {
      const listed = await client.listTools();
      const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
      for (const name of TOOL_NAMES) {
        assert.ok(byName.has(name), `missing tool ${name}`);
      }
      assert.equal(byName.get(toolNames.listProducts)?.annotations?.readOnlyHint, true);
      assert.equal(byName.get(toolNames.getStoreSummary)?.annotations?.readOnlyHint, true);
      assert.equal(byName.get(toolNames.createProduct)?.annotations?.readOnlyHint, false);
      assert.equal(byName.get(toolNames.createProduct)?.annotations?.destructiveHint, false);
      assert.equal(byName.get(toolNames.updateOrderStatus)?.annotations?.destructiveHint, true);
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

      const blocked = await client.callTool({
        name: toolNames.createProduct,
        arguments: { name: 'Hat' },
      });
      assert.equal(blocked.isError, true);
      assert.match(textOf(blocked), /read_only/);
      assert.equal(
        requests.some((request) => request.method === 'POST'),
        false,
      );
    });
  });

  it('creates a product when writes are enabled', async () => {
    const { fetchImpl, requests } = createFetchMock(async (request) => productResponse(request));
    await withClient(fetchImpl, { readOnly: false }, async (client) => {
      const created = await client.callTool({
        name: toolNames.createProduct,
        arguments: { name: 'Hat', status: 'draft' },
      });
      assert.notEqual(created.isError, true);
      const post = requests.find((request) => request.method === 'POST');
      assert.ok(post);
      assert.deepEqual(JSON.parse(post.body ?? '{}'), { name: 'Hat', status: 'draft' });
    });
  });
});

async function withClient(
  fetchImpl: typeof fetch,
  overrides: { readOnly: boolean },
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const config = testConfig(overrides);
  const woo = new WooCommerceClient(config, {
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
    nonce: () => 'n'.repeat(32),
    timestamp: () => 1_700_000_000,
  });
  const handler = createMcpHandler(() => createServer({ config, client: woo }));
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client(
    { name: 'woocommerce-mcp-test', version: '0.1.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
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
