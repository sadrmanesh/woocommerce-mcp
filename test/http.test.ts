import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { startHttpServer, isMcpPath } from '../src/http.js';
import { createServer as createMcpServer } from '../src/server.js';
import { toolNames } from '../src/tools/names.js';
import { createFetchMock, jsonResponse, testConfig, testRuntime, testStore } from './helpers.js';

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
    const config = testConfig({ transport: 'http', httpPort: port });
    const runtime = testRuntime(fetchImpl);
    const handle = await startHttpServer(() => createMcpServer({ runtime }), config, {
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

describe('HTTP bearer authentication', () => {
  const writeToken = 'w'.repeat(32);
  const readToken = 'r'.repeat(32);

  it('challenges anonymous requests, serves metadata, and enforces scopes', async () => {
    const port = await freePort();
    const { fetchImpl, requests } = createFetchMock(async (request) =>
      request.method === 'POST' ? jsonResponse({ id: 9, name: 'Hat' }) : jsonResponse([]),
    );
    const config = testConfig({
      transport: 'http',
      httpPort: port,
      requireConfirmation: false,
      stores: [testStore({ readOnly: false })],
      httpAuth: {
        tokens: [writeToken],
        readTokens: [readToken],
        introspection: null,
        issuer: 'https://auth.example.com/',
        resource: null,
        requiredScopes: [],
      },
    });
    const runtime = testRuntime(fetchImpl, config);
    const handle = await startHttpServer(() => createMcpServer({ runtime }), config, { signals: false, quiet: true });
    try {
      const anonymous = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: '{}',
      });
      assert.equal(anonymous.status, 401);
      const challenge = anonymous.headers.get('www-authenticate') ?? '';
      assert.match(challenge, /^Bearer /);
      assert.match(challenge, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);

      const wrong = await fetch(handle.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${'x'.repeat(32)}`, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(wrong.status, 401);

      const metadata = await fetch(`http://127.0.0.1:${handle.port}/.well-known/oauth-protected-resource/mcp`);
      assert.equal(metadata.status, 200);
      const document = (await metadata.json()) as Record<string, unknown>;
      assert.deepEqual(document.authorization_servers, ['https://auth.example.com/']);
      assert.deepEqual(document.scopes_supported, ['woocommerce:read', 'woocommerce:write']);

      const health = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
      assert.equal(health.status, 200);

      const reader = await connect(handle.url, readToken);
      try {
        const listed = await reader.callTool({ name: toolNames.listProducts, arguments: {} });
        assert.notEqual(listed.isError, true);
        const denied = await reader.callTool({ name: toolNames.createProduct, arguments: { name: 'Hat' } });
        assert.equal(denied.isError, true);
        const block = denied.content[0];
        assert.ok(block && block.type === 'text' && block.text.includes('insufficient_scope'));
      } finally {
        await reader.close();
      }
      assert.equal(requests.filter((request) => request.method === 'POST').length, 0);

      const writer = await connect(handle.url, writeToken);
      try {
        const created = await writer.callTool({ name: toolNames.createProduct, arguments: { name: 'Hat' } });
        assert.notEqual(created.isError, true);
      } finally {
        await writer.close();
      }
      assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
    } finally {
      await handle.close();
    }
  });
});

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'woocommerce-mcp-test', version: '0.3.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  );
  return client;
}

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
