import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig, toolAllowed } from '../src/config.js';
import { maskEmail, maskPhone, redactPersonalData } from '../src/redact.js';
import { matchesToolPattern } from '../src/tools/names.js';
import {
  isPingBody,
  matchesTopic,
  signWebhookBody,
  verifyWebhookSignature,
  WebhookEventStore,
} from '../src/webhooks.js';
import { ResponseCache } from '../src/woocommerce/cache.js';
import { RateLimiter } from '../src/woocommerce/rate-limit.js';
import { clientWith, createFetchMock, jsonResponse, validEnv } from './helpers.js';

describe('RateLimiter', () => {
  it('allows a burst, then spaces requests at the configured rate', () => {
    let now = 0;
    const limiter = new RateLimiter(5, 2, () => now);
    assert.equal(limiter.reserve(), 0);
    assert.equal(limiter.reserve(), 0);
    assert.equal(limiter.reserve(), 200);
    assert.equal(limiter.reserve(), 400);
    now = 1_000;
    assert.equal(limiter.reserve(), 0);
  });

  it('is a no-op when the rate is zero', () => {
    const limiter = new RateLimiter(0, 1);
    for (let index = 0; index < 50; index += 1) assert.equal(limiter.reserve(), 0);
  });
});

describe('ResponseCache', () => {
  it('expires entries after the TTL and evicts the least recently used', () => {
    let now = 0;
    const cache = new ResponseCache<string>(1_000, 2, () => now);
    cache.set('a', 'A');
    cache.set('b', 'B');
    assert.equal(cache.get('a'), 'A');
    cache.set('c', 'C');
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('a'), 'A');
    now = 1_001;
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.stats().hits, 2);
  });

  it('stores nothing when the TTL is zero', () => {
    const cache = new ResponseCache<string>(0, 10);
    cache.set('a', 'A');
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.stats().enabled, false);
  });
});

describe('client cache, rate limit, and retry', () => {
  it('serves repeated reads from the cache and clears it after a write', async () => {
    const { fetchImpl, requests } = createFetchMock(async (request) =>
      request.method === 'GET' ? jsonResponse([{ id: 1 }]) : jsonResponse({ id: 1 }),
    );
    const client = clientWith(fetchImpl, { cacheTtlMs: 60_000 });
    const first = await client.get('products', { per_page: 5 });
    (first.data as { id: number }[])[0]!.id = 99;
    const second = await client.get('products', { per_page: 5 });
    assert.deepEqual(second.data, [{ id: 1 }], 'cached data is copied, not shared');
    assert.equal(requests.length, 1);
    await client.put('products/1', { name: 'x' });
    await client.get('products', { per_page: 5 });
    assert.equal(requests.length, 3);
    assert.equal(client.stats().cache.hits, 1);
  });

  it('clears the cache even when a write fails', async () => {
    const { fetchImpl, requests } = createFetchMock(async (request) =>
      request.method === 'GET'
        ? jsonResponse([{ id: 1 }])
        : jsonResponse({ code: 'woocommerce_rest_invalid', message: 'Bad' }, { status: 400 }),
    );
    const client = clientWith(fetchImpl, { cacheTtlMs: 60_000, maxRetries: 0 });
    await client.get('products');
    await assert.rejects(client.put('products/1', { name: 'x' }));
    await client.get('products');
    assert.equal(requests.length, 3);
  });

  it('shares the cache with planning clients but never plans a cached write', async () => {
    const { fetchImpl, requests } = createFetchMock(async () => jsonResponse({ id: 1 }));
    const client = clientWith(fetchImpl, { cacheTtlMs: 60_000 });
    await client.get('products/1');
    await client.planning().get('products/1');
    assert.equal(requests.length, 1);
  });

  it('waits for the rate limiter before sending', async () => {
    const { fetchImpl } = createFetchMock(async () => jsonResponse([]));
    const sleeps: number[] = [];
    const client = clientWith(
      fetchImpl,
      { rateLimit: 1, rateBurst: 1 },
      {
        now: () => 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    await client.get('products');
    await client.get('orders');
    assert.deepEqual(sleeps, [1_000]);
  });

  it('backs off exponentially with jitter and honours a short Retry-After', async () => {
    let attempt = 0;
    const { fetchImpl } = createFetchMock(async () => {
      attempt += 1;
      if (attempt === 1) return new Response('busy', { status: 502 });
      if (attempt === 2) return new Response('busy', { status: 504 });
      if (attempt === 3) return jsonResponse({ message: 'slow down' }, { status: 429, headers: { 'retry-after': '2' } });
      return jsonResponse([]);
    });
    const sleeps: number[] = [];
    const client = clientWith(
      fetchImpl,
      { maxRetries: 3, retryBaseMs: 100, retryMaxMs: 5_000 },
      {
        random: () => 1,
        now: () => 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    await client.get('products');
    assert.deepEqual(sleeps, [100, 200, 2_000]);
  });

  it('rejects an unsafe extension namespace', () => {
    const { fetchImpl } = createFetchMock(async () => jsonResponse([]));
    assert.throws(() => clientWith(fetchImpl).withNamespace('../wp/v2'), /unsafe REST namespace/);
    assert.doesNotThrow(() => clientWith(fetchImpl).withNamespace('wc-shipment-tracking/v3'));
  });
});

describe('redactPersonalData', () => {
  it('masks names, addresses, emails, and phones at any depth', () => {
    const input = {
      id: 5,
      total: '10.00',
      billing: {
        first_name: 'Sara',
        last_name: 'Ahmadi',
        email: 'sara@example.com',
        phone: '+98 912 000 1234',
        address_1: '1 Main St',
        city: 'Tehran',
      },
      customer_note: 'Call me at sara@example.com',
      line_items: [{ name: 'Wool scarf', quantity: 1 }],
    };
    const output = redactPersonalData(input) as typeof input;
    assert.equal(output.billing.first_name, '[redacted]');
    assert.equal(output.billing.address_1, '[redacted]');
    assert.equal(output.billing.email, 's***@example.com');
    assert.equal(output.billing.phone, '***34');
    assert.equal(output.billing.city, 'Tehran');
    assert.equal(output.customer_note, 'Call me at s***@example.com');
    assert.equal(output.line_items[0]?.name, 'Wool scarf');
    assert.equal(input.billing.first_name, 'Sara', 'the input is not modified');
  });

  it('exposes the mask helpers', () => {
    assert.equal(maskEmail('a@b.co'), 'a***@b.co');
    assert.equal(maskPhone('0912'), '***12');
  });
});

describe('tool filters', () => {
  it('matches exact names, wildcards, and names without the prefix', () => {
    assert.equal(matchesToolPattern('woocommerce_list_orders', 'woocommerce_list_orders'), true);
    assert.equal(matchesToolPattern('list_orders', 'woocommerce_list_orders'), true);
    assert.equal(matchesToolPattern('*_webhook*', 'woocommerce_delete_webhook'), true);
    assert.equal(matchesToolPattern('delete_*', 'woocommerce_list_orders'), false);
  });

  it('lets deny win and treats an empty allow list as allow all', () => {
    assert.equal(toolAllowed({ allow: [], deny: [] }, 'woocommerce_list_orders'), true);
    assert.equal(toolAllowed({ allow: ['list_*'], deny: [] }, 'woocommerce_get_order'), false);
    assert.equal(toolAllowed({ allow: ['*'], deny: ['delete_*'] }, 'woocommerce_delete_coupon'), false);
  });
});

describe('v0.3.0 configuration', () => {
  it('reads performance, privacy, webhook, and filter settings', () => {
    const config = loadConfig({
      ...validEnv,
      WOOCOMMERCE_RATE_LIMIT: '2',
      WOOCOMMERCE_RATE_BURST: '4',
      WOOCOMMERCE_CACHE_TTL_MS: '30000',
      WOOCOMMERCE_REDACT_PII: 'true',
      WOOCOMMERCE_WEBHOOK_SECRET: 'a-very-long-webhook-secret',
      WOOCOMMERCE_TOOLS_DENY: 'delete_*',
      WOOCOMMERCE_TRACKING_MODE: 'shipment-tracking',
    });
    assert.equal(config.rateLimit, 2);
    assert.equal(config.rateBurst, 4);
    assert.equal(config.cacheTtlMs, 30_000);
    assert.equal(config.trackingMode, 'shipment-tracking');
    assert.deepEqual(config.tools.deny, ['delete_*']);
    assert.equal(config.stores[0]?.redactPii, true);
    assert.equal(config.stores[0]?.webhookSecret, 'a-very-long-webhook-secret');
  });

  it('defaults to a modest rate limit with caching off', () => {
    const config = loadConfig(validEnv);
    assert.equal(config.rateLimit, 5);
    assert.equal(config.cacheTtlMs, 0);
    assert.equal(config.stores[0]?.redactPii, false);
    assert.equal(config.stores[0]?.webhookSecret, null);
    assert.equal(config.webhookPath, '/webhooks/woocommerce');
  });

  it('rejects short secrets, unknown tool patterns, and clashing paths', () => {
    assert.throws(() => loadConfig({ ...validEnv, WOOCOMMERCE_WEBHOOK_SECRET: 'short' }), /at least 16/);
    assert.throws(() => loadConfig({ ...validEnv, WOOCOMMERCE_TOOLS_ALLOW: 'no_such_tool' }), /no_such_tool/);
    assert.throws(
      () => loadConfig({ ...validEnv, MCP_HTTP_PATH: '/hooks', WOOCOMMERCE_WEBHOOK_PATH: '/hooks' }),
      /WOOCOMMERCE_WEBHOOK_PATH/,
    );
    assert.throws(
      () => loadConfig({ ...validEnv, WOOCOMMERCE_RETRY_BASE_MS: '5000', WOOCOMMERCE_RETRY_MAX_MS: '1000' }),
      /RETRY/,
    );
  });

  it('reads per-store privacy, secrets, and tool lists', () => {
    const config = loadConfig({
      WOOCOMMERCE_STORES: JSON.stringify([
        {
          id: 'eu',
          url: 'https://eu.example.com',
          consumerKey: 'ck_eu',
          consumerSecret: 'cs_eu',
          redactPii: true,
          webhookSecretEnv: 'EU_HOOK',
          allowTools: ['list_*', 'get_*'],
        },
      ]),
      EU_HOOK: 'eu-webhook-secret-value',
    });
    const store = config.stores[0];
    assert.equal(store?.redactPii, true);
    assert.equal(store?.webhookSecret, 'eu-webhook-secret-value');
    assert.deepEqual(store?.tools.allow, ['list_*', 'get_*']);
  });
});

describe('webhook helpers', () => {
  it('verifies HMAC signatures in constant time', () => {
    const body = Buffer.from('{"id":1}');
    const signature = signWebhookBody(body, 'secret-secret-secret');
    assert.equal(verifyWebhookSignature(body, 'secret-secret-secret', signature), true);
    assert.equal(verifyWebhookSignature(body, 'another-secret-value', signature), false);
    assert.equal(verifyWebhookSignature(body, 'secret-secret-secret', undefined), false);
    assert.equal(verifyWebhookSignature(body, 'secret-secret-secret', 'bm9wZQ=='), false);
  });

  it('recognises the save ping and topic wildcards', () => {
    assert.equal(isPingBody(Buffer.from('webhook_id=12')), true);
    assert.equal(isPingBody(Buffer.from('{"id":1}')), false);
    assert.equal(matchesTopic('order.*', 'order.created'), true);
    assert.equal(matchesTopic('order.*', 'product.created'), false);
    assert.equal(matchesTopic('order.updated', 'order.updated'), true);
  });

  it('keeps the newest events per store up to its capacity', () => {
    const events = new WebhookEventStore(2, () => new Date('2026-10-30T10:00:00Z'));
    const base = { resource: null, event: null, webhookId: null, deliveryId: null, resourceId: null, payload: {} };
    events.add({ ...base, store: 'main', topic: 'order.created' });
    events.add({ ...base, store: 'main', topic: 'product.updated' });
    events.add({ ...base, store: 'main', topic: 'order.updated' });
    events.add({ ...base, store: 'other', topic: 'order.created' });
    assert.equal(events.count('main'), 2);
    assert.deepEqual(
      events.list({ store: 'MAIN' }).map((event) => event.id),
      [3, 2],
    );
    assert.deepEqual(
      events.list({ store: 'main', topic: 'order.*' }).map((event) => event.topic),
      ['order.updated'],
    );
    assert.deepEqual(
      events.list({ store: 'main', sinceId: 2 }).map((event) => event.id),
      [3],
    );
    assert.equal(events.get('main', 1), undefined);
  });
});
