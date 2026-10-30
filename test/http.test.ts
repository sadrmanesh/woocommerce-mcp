import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { startHttpServer, isMcpPath } from '../src/http.js';
import { createServer as createMcpServer } from '../src/server.js';
import { toolNames } from '../src/tools/names.js';
import { WooCommerceClient } from '../src/woocommerce/client.js';
import { createFetchMock, jsonResponse, testConfig } from './helpers.js';

describe('streamable HTTP', () => {
  it('accepts the configured path and a trailing slash only', () => {
    assert.equal(isMcpPath('/mcp', '/mcp'), true);
    assert.equal(isMcpPath('/mcp/', '/mcp'), true);
    assert.equal(isMcpPath('/other', '/mcp'), false);
    assert.equal(isMcpPath('/', '/'), true);
    assert.equal(isMcpPath('//', '/'), false);
  });

  it('serves MCP on loopback and rejects a foreign Host header', async () => {
    const port = await freePort();
    const { fetchImpl } = createFetchMock(async () =>
      jsonResponse([{ id: 7, name: 'Wool scarf', price: '25.00' }], {
        headers: { 'x-wp-total': '1', 'x-wp-totalpages': '1' },
      }),
    );
    const config = testConfig({ transport: 'http', httpPort: port, readOnly: true });
    const woo = new WooCommerceClient(config, { fetchImpl, sleep: async () => undefined, random: () => 0 });
    const handle = await startHttpServer(() => createMcpServer({ config, client: woo }), config, {
      signals: false,
      quiet: true,
    });
    const client = new Client(
      { name: 'woocommerce-mcp-test', version: '0.1.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    try {
      const missing = await fetch(`http://127.0.0.1:${handle.port}/nope`);
      assert.equal(missing.status, 404);

      const forbidden = await rawPost(handle.port, 'evil.example', '/mcp');
      assert.equal(forbidden.status, 403);

      const transport = new StreamableHTTPClientTransport(new URL(handle.url));
      await client.connect(transport);
      const listed = await client.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === toolNames.listProducts));
      const result = await client.callTool({ name: toolNames.listProducts, arguments: {} });
      assert.notEqual(result.isError, true);
      const block = result.content[0];
      assert.ok(block && block.type === 'text' && block.text.includes('Wool scarf'));
    } finally {
      await client.close();
      await handle.close();
    }
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('No TCP port')));
        return;
      }
      const { port } = address;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function rawPost(port: number, hostHeader: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          host: hostHeader,
          'content-type': 'application/json',
          'content-length': '2',
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    request.on('error', reject);
    request.end('{}');
  });
}
