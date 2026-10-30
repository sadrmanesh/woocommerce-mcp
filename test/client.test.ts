import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WooCommerceApiError } from '../src/woocommerce/errors.js';
import { clientWith, createFetchMock, jsonResponse, queryParam, testConfig } from './helpers.js';
import { WooCommerceClient } from '../src/woocommerce/client.js';

describe('WooCommerceClient', () => {
  it('maps a WooCommerce error payload and scrubs secrets', () => {
    const { fetchImpl } = createFetchMock(async () =>
      jsonResponse(
        {
          code: 'woocommerce_rest_cannot_view',
          message: 'Invalid key cs_test_secret',
          data: { status: 401, hint: 'ck_test_key' },
        },
        { status: 401 },
      ),
    );
    const client = clientWith(fetchImpl);
    return assert.rejects(
      () => client.get('products/9'),
      (error: unknown) => {
        assert.ok(error instanceof WooCommerceApiError);
        assert.equal(error.status, 401);
        assert.equal(error.code, 'woocommerce_rest_cannot_view');
        assert.equal(error.message.includes('cs_test_secret'), false);
        assert.match(error.message, /\[redacted\]/);
        assert.equal(JSON.stringify(error.data).includes('ck_test_key'), false);
        return true;
      },
    );
  });

  it('reads pagination headers', async () => {
    const { fetchImpl } = createFetchMock(async () =>
      jsonResponse([{ id: 1 }], { headers: { 'x-wp-total': '40', 'x-wp-totalpages': '4' } }),
    );
    const response = await clientWith(fetchImpl).get('products', { page: 2, per_page: 10 });
    assert.deepEqual(response.pagination, { page: 2, perPage: 10, total: 40, totalPages: 4 });
  });

  it('retries a rate-limited read and then a rate-limited write', async () => {
    const sleeps: number[] = [];
    let reads = 0;
    const { fetchImpl, requests } = createFetchMock(async (request) => {
      if (request.method === 'GET') {
        reads += 1;
        if (reads === 1) return jsonResponse({ message: 'slow down' }, { status: 429, headers: { 'retry-after': '1' } });
        return jsonResponse({ id: 1 });
      }
      if (requests.filter((item) => item.method === 'POST').length === 1) {
        return jsonResponse({ message: 'slow down' }, { status: 429, headers: { 'retry-after': '0' } });
      }
      return jsonResponse({ id: 2 });
    });
    const client = new WooCommerceClient(testConfig(), {
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0,
      now: () => 1_000,
    });
    await client.get('products');
    await client.post('products', { name: 'Hat' });
    assert.deepEqual(sleeps, [1_000, 0]);
    assert.equal(requests.length, 4);
  });

  it('does not retry a write that failed with HTTP 500', async () => {
    const { fetchImpl, requests } = createFetchMock(async () =>
      jsonResponse({ message: 'broken', code: 'internal_server_error' }, { status: 500 }),
    );
    await assert.rejects(() => clientWith(fetchImpl).post('orders/1/notes', { note: 'Hi' }), (error: unknown) => {
      assert.ok(error instanceof WooCommerceApiError);
      assert.equal(error.status, 500);
      return true;
    });
    assert.equal(requests.length, 1);
  });

  it('retries a transient gateway failure for reads only', async () => {
    let attempts = 0;
    const { fetchImpl, requests } = createFetchMock(async () => {
      attempts += 1;
      if (attempts === 1) return new Response('bad gateway', { status: 503 });
      return jsonResponse([{ id: 1 }]);
    });
    const sleeps: number[] = [];
    const client = new WooCommerceClient(testConfig(), {
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0,
    });
    const response = await client.get('reports/sales');
    assert.deepEqual(response.data, [{ id: 1 }]);
    assert.deepEqual(sleeps, [250]);
    assert.equal(requests.length, 2);
  });

  it('returns a long Retry-After instead of sleeping inside the tool', async () => {
    const { fetchImpl, requests } = createFetchMock(async () =>
      jsonResponse({ message: 'later' }, { status: 429, headers: { 'retry-after': '30' } }),
    );
    await assert.rejects(() => clientWith(fetchImpl).get('products'), (error: unknown) => {
      assert.ok(error instanceof WooCommerceApiError);
      assert.equal(error.retryAfterMs, 30_000);
      assert.equal(error.code, 'rate_limited');
      return true;
    });
    assert.equal(requests.length, 1);
  });

  it('does not follow redirects or leak the secret from a transport error', async () => {
    const redirected = createFetchMock(
      async () =>
        new Response(null, {
          status: 301,
          headers: { location: 'https://evil.example/steal?consumer_secret=cs_test_secret' },
        }),
    );
    await assert.rejects(() => clientWith(redirected.fetchImpl).get('products'), (error: unknown) => {
      assert.ok(error instanceof WooCommerceApiError);
      assert.equal(error.code, 'redirect');
      assert.equal(error.message.includes('cs_test_secret'), false);
      assert.equal(error.message.includes('evil.example'), false);
      return true;
    });
    assert.equal(redirected.requests.length, 1);

    const timedOut = createFetchMock(async () => {
      throw new DOMException('timed out https://store.example.com/?secret=cs_test_secret', 'TimeoutError');
    });
    await assert.rejects(() => clientWith(timedOut.fetchImpl, { maxRetries: 0 }).get('products'), (error: unknown) => {
      assert.ok(error instanceof WooCommerceApiError);
      assert.equal(error.code, 'timeout');
      assert.equal(error.message.includes('cs_test_secret'), false);
      return true;
    });
  });

  it('rejects an unsafe path before any request', async () => {
    const { fetchImpl, requests } = createFetchMock(async () => jsonResponse({}));
    await assert.rejects(() => clientWith(fetchImpl).get('../wp/v2/users'), (error: unknown) => {
      assert.ok(error instanceof WooCommerceApiError);
      assert.equal(error.code, 'invalid_path');
      return true;
    });
    assert.equal(requests.length, 0);
  });

  it('rejects a successful body that is not JSON and a body over 5 MB', async () => {
    const invalid = createFetchMock(async () => new Response('<html>nope</html>', { status: 200 }));
    await assert.rejects(() => clientWith(invalid.fetchImpl).get('products'), (error: unknown) => {
      assert.ok(error instanceof WooCommerceApiError);
      assert.equal(error.code, 'invalid_response');
      return true;
    });

    const huge = createFetchMock(async () => new Response('x'.repeat(5_000_001), { status: 200 }));
    await assert.rejects(() => clientWith(huge.fetchImpl).get('products'), (error: unknown) => {
      assert.ok(error instanceof WooCommerceApiError);
      assert.equal(error.code, 'response_too_large');
      return true;
    });
  });

  it('logs the method and path without the secret when debug is on', async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const { fetchImpl } = createFetchMock(async () => jsonResponse([]));
      await clientWith(fetchImpl, { debug: true, authMode: 'query' }).get('products', { search: 'hat' });
    } finally {
      console.error = original;
    }
    assert.ok(lines.some((line) => line.includes('GET products')));
    assert.ok(lines.every((line) => !line.includes('cs_test_secret')));
  });

  it('puts OAuth parameters on the query string for oauth1 mode', async () => {
    const { fetchImpl, requests } = createFetchMock(async () => jsonResponse([]));
    await clientWith(fetchImpl, { authMode: 'oauth1' }).get('products', { page: 1 });
    const url = requests[0]?.url ?? '';
    assert.equal(queryParam(url, 'oauth_signature_method'), 'HMAC-SHA1');
    assert.equal(url.includes('cs_test_secret'), false);
    assert.equal(requests[0]?.headers.get('authorization'), null);
  });
});
