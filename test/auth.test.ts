import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { authorize, encodeRfc3986 } from '../src/woocommerce/auth.js';

const baseString =
  'GET&https%3A%2F%2Fstore.example.com%2Fwp-json%2Fwc%2Fv3%2Fproducts&oauth_consumer_key%3Dck_test%26oauth_nonce%3Dnonce1234567890nonce1234567890%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1700000000%26page%3D1%26per_page%3D10';

describe('authorize', () => {
  it('percent-encodes RFC 3986 reserved characters', () => {
    assert.equal(encodeRfc3986("a b!*'()"), 'a%20b%21%2A%27%28%29');
  });

  it('signs OAuth 1.0a requests without putting the secret in the query', () => {
    const expected = createHmac('sha1', 'cs_test&').update(baseString).digest('base64');
    const signed = authorize({
      method: 'get',
      url: 'https://store.example.com/wp-json/wc/v3/products',
      query: { page: '1', per_page: '10' },
      consumerKey: 'ck_test',
      consumerSecret: 'cs_test',
      mode: 'oauth1',
      timestamp: 1_700_000_000,
      nonce: 'nonce1234567890nonce1234567890',
    });
    const signature = queryParam(signed.url, 'oauth_signature');
    assert.equal(signature, expected);
    assert.equal(queryParam(signed.url, 'oauth_consumer_key'), 'ck_test');
    assert.equal(signed.url.includes('cs_test'), false);
    assert.deepEqual(signed.headers, {});
  });

  it('percent-encodes the consumer secret in the signing key', () => {
    const expected = createHmac('sha1', 'cs%2Ftest%2B1&').update(baseString).digest('base64');
    const signed = authorize({
      method: 'GET',
      url: 'https://store.example.com/wp-json/wc/v3/products',
      query: { per_page: '10', page: '1' },
      consumerKey: 'ck_test',
      consumerSecret: 'cs/test+1',
      mode: 'oauth1',
      timestamp: 1_700_000_000,
      nonce: 'nonce1234567890nonce1234567890',
    });
    assert.equal(queryParam(signed.url, 'oauth_signature'), expected);
  });

  it('sends HTTP Basic without the secret in the URL', () => {
    const signed = authorize({
      method: 'GET',
      url: 'https://store.example.com/wp-json/wc/v3/orders',
      query: { per_page: '10' },
      consumerKey: 'ck_test',
      consumerSecret: 'cs_test',
      mode: 'basic',
      timestamp: 1,
      nonce: 'n',
    });
    assert.equal(signed.headers.Authorization, `Basic ${Buffer.from('ck_test:cs_test').toString('base64')}`);
    assert.equal(signed.url, 'https://store.example.com/wp-json/wc/v3/orders?per_page=10');
  });

  it('can place the key and secret in the query string when asked', () => {
    const signed = authorize({
      method: 'GET',
      url: 'https://store.example.com/wp-json/wc/v3/products',
      query: {},
      consumerKey: 'ck_test',
      consumerSecret: 'cs_test',
      mode: 'query',
      timestamp: 1,
      nonce: 'n',
    });
    assert.equal(queryParam(signed.url, 'consumer_key'), 'ck_test');
    assert.equal(queryParam(signed.url, 'consumer_secret'), 'cs_test');
    assert.deepEqual(signed.headers, {});
  });
});

function queryParam(url: string, name: string): string | null {
  const query = url.split('?')[1] ?? '';
  for (const part of query.split('&')) {
    const separator = part.indexOf('=');
    const key = decodeURIComponent(separator === -1 ? part : part.slice(0, separator));
    if (key !== name) continue;
    return decodeURIComponent(separator === -1 ? '' : part.slice(separator + 1));
  }
  return null;
}
