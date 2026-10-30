import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OAuthError } from '@modelcontextprotocol/server';

import { createTokenVerifier } from '../src/auth.js';
import type { HttpAuthConfig } from '../src/config.js';
import { createFetchMock, jsonResponse } from './helpers.js';

const base: HttpAuthConfig = {
  tokens: ['w'.repeat(32)],
  readTokens: ['r'.repeat(32)],
  introspection: null,
  issuer: null,
  resource: null,
  requiredScopes: [],
};

describe('bearer token verifier', () => {
  it('maps static tokens to scopes and rejects unknown tokens', async () => {
    const verifier = createTokenVerifier(base, { now: () => 1_000_000 });
    const writer = await verifier.verifyAccessToken('w'.repeat(32));
    assert.deepEqual(writer.scopes, ['woocommerce:read', 'woocommerce:write']);
    assert.equal(writer.expiresAt, 1_000 + 3_600);
    assert.match(writer.clientId, /^static:[0-9a-f]{12}$/);
    const reader = await verifier.verifyAccessToken('r'.repeat(32));
    assert.deepEqual(reader.scopes, ['woocommerce:read']);
    await assert.rejects(() => verifier.verifyAccessToken('z'.repeat(32)), OAuthError);
  });

  it('introspects other tokens, caches active ones, and rejects inactive ones', async () => {
    const now = 1_700_000_000_000;
    const { fetchImpl, requests } = createFetchMock(async (request) => {
      const token = new URLSearchParams(request.body ?? '').get('token');
      if (token === 'good') {
        return jsonResponse({ active: true, scope: 'woocommerce:read mcp', client_id: 'app', exp: now / 1000 + 600, aud: 'https://mcp.example.com/mcp' });
      }
      if (token === 'noexp') return jsonResponse({ active: true });
      return jsonResponse({ active: false });
    });
    const verifier = createTokenVerifier(
      {
        ...base,
        introspection: { url: 'https://auth.example.com/introspect', clientId: 'mcp', clientSecret: 's3cret' },
        issuer: 'https://auth.example.com/',
      },
      { fetchImpl, now: () => now },
    );
    const info = await verifier.verifyAccessToken('good');
    assert.deepEqual(info.scopes, ['woocommerce:read', 'mcp']);
    assert.equal(info.clientId, 'app');
    assert.equal(info.resource?.href, 'https://mcp.example.com/mcp');
    await verifier.verifyAccessToken('good');
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.headers.get('authorization'), `Basic ${Buffer.from('mcp:s3cret').toString('base64')}`);
    await assert.rejects(() => verifier.verifyAccessToken('bad'), /not active/);
    await assert.rejects(() => verifier.verifyAccessToken('noexp'), /no expiry/);
  });

  it('picks the configured resource from a token with several audiences', async () => {
    const now = 1_700_000_000_000;
    const { fetchImpl } = createFetchMock(async () =>
      jsonResponse({
        active: true,
        scope: 'woocommerce:read',
        exp: now / 1000 + 600,
        aud: ['https://api.example.com/', 'https://mcp.example.com/mcp'],
      }),
    );
    const verifier = createTokenVerifier(
      {
        ...base,
        introspection: { url: 'https://auth.example.com/introspect', clientId: 'mcp', clientSecret: 's3cret' },
        issuer: 'https://auth.example.com/',
        resource: 'https://mcp.example.com/mcp',
      },
      { fetchImpl, now: () => now },
    );
    const info = await verifier.verifyAccessToken('multi');
    assert.equal(info.resource?.href, 'https://mcp.example.com/mcp');
  });

  it('reports an unreachable introspection endpoint as a server error', async () => {
    const verifier = createTokenVerifier(
      { ...base, introspection: { url: 'https://auth.example.com/introspect', clientId: 'a', clientSecret: 'b' } },
      { fetchImpl: async () => new Response('down', { status: 503 }) },
    );
    await assert.rejects(() => verifier.verifyAccessToken('other'), (error: unknown) => {
      assert.ok(error instanceof OAuthError);
      assert.equal(error.code, 'server_error');
      return true;
    });
  });
});
