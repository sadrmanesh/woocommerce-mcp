import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { memoryAuditLog } from '../src/audit.js';
import { startHttpServer } from '../src/http.js';
import { createServer } from '../src/server.js';
import { getCustomer } from '../src/tools/customers.js';
import { toolNames } from '../src/tools/names.js';
import { hideSecrets, READ, CREATE, runTool, type ToolSpec } from '../src/tools/registry.js';
import { createWebhookInput, getCustomerRedactableInput } from '../src/tools/schemas.js';
import { createWebhook } from '../src/tools/webhooks.js';
import { webhookStoreFromPath } from '../src/webhook-receiver.js';
import { signWebhookBody, WebhookEventStore } from '../src/webhooks.js';
import type { AppConfig } from '../src/config.js';
import { createFetchMock, jsonResponse, resultText, testConfig, testRuntime, testStore } from './helpers.js';

const customerSpec: ToolSpec<typeof getCustomerRedactableInput> = {
  name: toolNames.getCustomer,
  title: 'Get customer',
  description: 'Get a customer.',
  input: getCustomerRedactableInput,
  annotations: READ,
  write: false,
  run: getCustomer,
};

const webhookSpec: ToolSpec<typeof createWebhookInput> = {
  name: toolNames.createWebhook,
  title: 'Create webhook',
  description: 'Create a webhook.',
  input: createWebhookInput,
  annotations: CREATE,
  write: true,
  run: createWebhook,
};

const SECRET = 'store-webhook-secret-123';

describe('per-store policy in the registry', () => {
  it('masks personal data for stores with redactPii', async () => {
    const { fetchImpl } = createFetchMock(async () =>
      jsonResponse({ id: 1, email: 'sara@example.com', first_name: 'Sara', billing: { phone: '09120001234' } }),
    );
    const runtime = testRuntime(fetchImpl, { stores: [testStore({ redactPii: true })] });
    const text = resultText(await runTool(runtime, customerSpec, { id: 1 }));
    assert.equal(text.includes('sara@example.com'), false);
    assert.match(text, /s\*\*\*@example\.com/);
    assert.match(text, /\*\*\*34/);
  });

  it('refuses a tool the store denies and audits it as refused', async () => {
    const { fetchImpl, requests } = createFetchMock(async () => jsonResponse({ id: 1 }));
    const audit = memoryAuditLog();
    const runtime = testRuntime(
      fetchImpl,
      { stores: [testStore({ readOnly: false, webhookSecret: SECRET, tools: { allow: [], deny: ['*webhook*'] } })] },
      { audit },
    );
    const result = await runTool(runtime, webhookSpec, {
      name: 'Orders',
      topic: 'order.created',
      deliveryUrl: 'https://mcp.example.com/webhooks/woocommerce/default',
      confirm: true,
    });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /tool_disabled/);
    assert.equal(requests.length, 0);
    assert.equal(audit.entries[0]?.outcome, 'refused');
  });

  it('never echoes the configured webhook secret in a preview', async () => {
    const { fetchImpl, requests } = createFetchMock(async () => jsonResponse({ id: 1 }));
    const runtime = testRuntime(fetchImpl, { stores: [testStore({ readOnly: false, webhookSecret: SECRET })] });
    const result = await runTool(runtime, webhookSpec, {
      name: 'Orders',
      topic: 'order.created',
      deliveryUrl: 'https://mcp.example.com/webhooks/woocommerce/default',
    });
    const text = resultText(result);
    assert.match(text, /confirmation_required/);
    assert.equal(text.includes(SECRET), false);
    assert.match(text, /\[configured secret\]/);
    assert.equal(requests.length, 0);
    assert.deepEqual(hideSecrets({ a: [{ secret: 'x' }], secret: 1 }), { a: [{ secret: '[configured secret]' }], secret: 1 });
  });
});

describe('tool allow and deny lists', () => {
  it('hides globally denied tools and keeps the rest', async () => {
    const { fetchImpl } = createFetchMock(async () => jsonResponse([]));
    const names = await listToolNames(fetchImpl, { tools: { allow: [], deny: ['delete_*', 'create_webhook'] } });
    assert.equal(names.includes(toolNames.deleteCoupon), false);
    assert.equal(names.includes(toolNames.createWebhook), false);
    assert.ok(names.includes(toolNames.listWebhooks));
  });

  it('exposes only allowed tools', async () => {
    const { fetchImpl } = createFetchMock(async () => jsonResponse([]));
    const names = await listToolNames(fetchImpl, { tools: { allow: ['list_*'], deny: [] } });
    assert.ok(names.length > 5);
    assert.ok(names.every((name) => name.startsWith('woocommerce_list_')));
  });
});

describe('webhook receiver', () => {
  it('maps receiver paths to store ids', () => {
    assert.equal(webhookStoreFromPath('/webhooks/woocommerce/main', '/webhooks/woocommerce'), 'main');
    assert.equal(webhookStoreFromPath('/webhooks/woocommerce/main/', '/webhooks/woocommerce'), 'main');
    assert.equal(webhookStoreFromPath('/webhooks/woocommerce/a/b', '/webhooks/woocommerce'), null);
    assert.equal(webhookStoreFromPath('/mcp', '/webhooks/woocommerce'), null);
  });

  it('accepts signed deliveries, answers pings, and rejects the rest', async () => {
    const { fetchImpl } = createFetchMock(async () => jsonResponse([]));
    const events = new WebhookEventStore(10);
    const store = testStore({ id: 'main', webhookSecret: SECRET, redactPii: true });
    const config = testConfig({
      transport: 'http',
      httpPort: 0,
      stores: [store, testStore({ id: 'nosecret' })],
      defaultStore: 'main',
    });
    const runtime = testRuntime(fetchImpl, config);
    runtime.events = events;
    const handle = await startHttpServer(() => createServer({ runtime }), config, {
      signals: false,
      quiet: true,
      webhooks: {
        path: config.webhookPath,
        events,
        storeSecret: (id) => (id.toLowerCase() === 'main' ? { id: 'main', secret: SECRET } : null),
      },
    });
    const base = `http://127.0.0.1:${handle.port}${config.webhookPath}`;
    const payload = JSON.stringify({ id: 55, status: 'processing', billing: { email: 'sara@example.com' } });
    const post = (path: string, body: string, headers: Record<string, string> = {}) =>
      fetch(`${base}/${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
    try {
      const accepted = await post('main', payload, {
        'x-wc-webhook-signature': signWebhookBody(payload, SECRET),
        'x-wc-webhook-topic': 'order.created',
        'x-wc-webhook-resource': 'order',
        'x-wc-webhook-event': 'created',
        'x-wc-webhook-id': '3',
        'x-wc-webhook-delivery-id': 'abc',
      });
      assert.equal(accepted.status, 202);
      assert.equal(events.count('main'), 1);
      const stored = events.list({ store: 'main' })[0];
      assert.equal(stored?.topic, 'order.created');
      assert.equal(stored?.resourceId, 55);
      assert.equal(stored?.webhookId, 3);

      assert.equal((await post('main', payload, { 'x-wc-webhook-signature': 'bad' })).status, 401);
      assert.equal((await post('main', payload)).status, 401);
      assert.equal(
        (
          await fetch(`${base}/main`, {
            method: 'POST',
            body: 'webhook_id=3',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
          })
        ).status,
        200,
      );
      assert.equal((await post('nosecret', payload)).status, 404);
      assert.equal((await post('unknown', payload)).status, 404);
      assert.equal((await fetch(`${base}/main`)).status, 405);
      assert.equal(events.count('main'), 1);

      const client = new Client({ name: 'woocommerce-mcp-test', version: '0.3.0' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
      try {
        const list = await client.readResource({ uri: 'woocommerce://stores/main/events' });
        const listed = list.contents[0];
        assert.ok(listed && 'text' in listed);
        assert.match(listed.text, /order\.created/);
        const one = await client.readResource({ uri: `woocommerce://stores/main/events/${stored?.id ?? 0}` });
        const detail = one.contents[0];
        assert.ok(detail && 'text' in detail);
        assert.equal(detail.text.includes('sara@example.com'), false, 'payload is masked for redactPii stores');
        assert.match(detail.text, /s\*\*\*@example\.com/);
      } finally {
        await client.close();
      }
    } finally {
      await handle.close();
    }
  });

  it('rejects oversized deliveries', async () => {
    const { fetchImpl } = createFetchMock(async () => jsonResponse([]));
    const events = new WebhookEventStore(10);
    const config = testConfig({ transport: 'http', httpPort: 0 });
    const runtime = testRuntime(fetchImpl, config);
    const handle = await startHttpServer(() => createServer({ runtime }), config, {
      signals: false,
      quiet: true,
      webhooks: { path: config.webhookPath, events, storeSecret: () => ({ id: 'default', secret: SECRET }) },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}${config.webhookPath}/default`, {
        method: 'POST',
        body: 'x'.repeat(1_000_001),
      });
      assert.equal(response.status, 413);
    } finally {
      await handle.close();
    }
  });
});

describe('MCP Registry metadata', () => {
  it('keeps server.json in step with package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string;
      version: string;
      mcpName: string;
    };
    const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8')) as {
      name: string;
      version: string;
      packages: { identifier: string; version: string; environmentVariables: { name: string }[] }[];
    };
    assert.equal(server.name, pkg.mcpName);
    assert.equal(server.version, pkg.version);
    assert.equal(server.packages[0]?.identifier, pkg.name);
    assert.equal(server.packages[0]?.version, pkg.version);
    assert.ok(server.packages[0]?.environmentVariables.some((variable) => variable.name === 'WOOCOMMERCE_URL'));
  });
});

async function listToolNames(fetchImpl: typeof fetch, overrides: Partial<AppConfig>): Promise<string[]> {
  const runtime = testRuntime(fetchImpl, overrides);
  const handler = createMcpHandler(() => createServer({ runtime }));
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'woocommerce-mcp-test', version: '0.3.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
    await handler.close();
  }
}
