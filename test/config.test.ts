import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type AppConfig, authWarnings, clientOptions, loadConfig, type StoreConfig } from '../src/config.js';
import { ConfigError } from '../src/woocommerce/errors.js';
import { validEnv } from './helpers.js';

describe('loadConfig', () => {
  it('defaults to one read-only store with basic auth on https', () => {
    const config = loadConfig({ ...validEnv, PATH: '/usr/bin' });
    assert.equal(config.stores.length, 1);
    const store = only(config);
    assert.equal(store.id, 'default');
    assert.equal(store.readOnly, true);
    assert.equal(store.authMode, 'basic');
    assert.equal(store.apiVersion, 'wc/v3');
    assert.equal(store.url, 'https://store.example.com');
    assert.equal(config.defaultStore, 'default');
    assert.equal(config.transport, 'stdio');
    assert.equal(config.defaultPerPage, 10);
    assert.equal(config.maxRetries, 2);
    assert.equal(config.timeoutMs, 30_000);
    assert.equal(config.httpHost, '127.0.0.1');
    assert.equal(config.httpPath, '/mcp');
    assert.equal(config.userAgent, 'woocommerce-mcp/0.5.0');
    assert.equal(config.requireConfirmation, true);
    assert.equal(config.auditLog, null);
    assert.equal(config.telemetry, false);
    assert.equal(config.httpAuth, null);
  });

  it('treats an explicit false flag as permission to write', () => {
    assert.equal(only(loadConfig({ ...validEnv, WOOCOMMERCE_READ_ONLY: 'false' })).readOnly, false);
    assert.equal(only(loadConfig({ ...validEnv, WOOCOMMERCE_READ_ONLY: 'no' })).readOnly, false);
    assert.equal(only(loadConfig({ ...validEnv, WOOCOMMERCE_READ_ONLY: 'YES' })).readOnly, true);
    assert.equal(loadConfig({ ...validEnv, WOOCOMMERCE_REQUIRE_CONFIRMATION: 'false' }).requireConfirmation, false);
  });

  it('uses oauth1 for http unless a mode is set', () => {
    const store = only(loadConfig({ ...validEnv, WOOCOMMERCE_URL: 'http://store.example.com/shop/' }));
    assert.equal(store.url, 'http://store.example.com/shop');
    assert.equal(store.authMode, 'oauth1');
    assert.equal(only(loadConfig({ ...validEnv, WOOCOMMERCE_AUTH_MODE: 'query' })).authMode, 'query');
  });

  it('normalizes the store URL', () => {
    const store = only(loadConfig({ ...validEnv, WOOCOMMERCE_URL: 'https://store.example.com:443/shop/' }));
    assert.equal(store.url, 'https://store.example.com/shop');
  });

  it('builds client options from the shared and per-store settings', () => {
    const config = loadConfig({ ...validEnv, WOOCOMMERCE_TIMEOUT_MS: '9000' });
    const options = clientOptions(config, only(config));
    assert.equal(options.url, 'https://store.example.com');
    assert.equal(options.timeoutMs, 9_000);
    assert.equal(options.consumerSecret, 'cs_test_secret');
  });

  it('reports every missing or invalid value together', () => {
    assert.throws(
      () =>
        loadConfig({
          WOOCOMMERCE_URL: 'ftp://store.example.com',
          WOOCOMMERCE_CONSUMER_KEY: 'has space',
          MCP_HTTP_HOST: '0.0.0.0',
          WOOCOMMERCE_DEFAULT_PER_PAGE: '500',
        }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /WOOCOMMERCE_URL/);
        assert.match(error.message, /WOOCOMMERCE_CONSUMER_KEY/);
        assert.match(error.message, /WOOCOMMERCE_CONSUMER_SECRET/);
        assert.match(error.message, /MCP_HTTP_HOST/);
        assert.match(error.message, /WOOCOMMERCE_DEFAULT_PER_PAGE/);
        return true;
      },
    );
  });

  it('rejects credentials and query strings in the store URL', () => {
    assert.throws(() => loadConfig({ ...validEnv, WOOCOMMERCE_URL: 'https://ck:cs@store.example.com' }), /credentials/);
    assert.throws(() => loadConfig({ ...validEnv, WOOCOMMERCE_URL: 'https://store.example.com/?rest_route=/' }), /query string/);
  });
});

describe('authWarnings', () => {
  it('warns when basic auth would cross the network in clear text', () => {
    const config = loadConfig({
      ...validEnv,
      WOOCOMMERCE_URL: 'http://store.example.com',
      WOOCOMMERCE_AUTH_MODE: 'basic',
    });
    assert.ok(authWarnings(config).some((warning) => warning.includes('http://')));
  });

  it('warns when the secret is placed in the query string', () => {
    const config = loadConfig({ ...validEnv, WOOCOMMERCE_AUTH_MODE: 'query' });
    assert.ok(authWarnings(config).some((warning) => warning.includes('Query-string')));
  });

  it('stays quiet for https basic auth and http oauth1', () => {
    assert.deepEqual(authWarnings(loadConfig(validEnv)), []);
    assert.deepEqual(authWarnings(loadConfig({ ...validEnv, WOOCOMMERCE_URL: 'http://store.example.com' })), []);
  });
});

describe('multi-store configuration', () => {
  const stores = JSON.stringify({
    defaultStore: 'us',
    stores: [
      { id: 'eu', label: 'Europe', url: 'https://eu.example.com', consumerKey: 'ck_eu_key', consumerSecretEnv: 'EU_SECRET' },
      {
        id: 'us',
        url: 'http://us.example.com/',
        consumerKey: 'ck_us_key',
        consumerSecret: 'cs_us_secret',
        readOnly: false,
      },
    ],
  });

  it('reads stores from inline JSON and resolves secret references', () => {
    const config = loadConfig({ WOOCOMMERCE_STORES: stores, EU_SECRET: 'cs_eu_secret' });
    assert.deepEqual(
      config.stores.map((store) => [store.id, store.label, store.readOnly, store.authMode]),
      [
        ['eu', 'Europe', true, 'basic'],
        ['us', null, false, 'oauth1'],
      ],
    );
    assert.equal(config.stores[0]?.consumerSecret, 'cs_eu_secret');
    assert.equal(config.defaultStore, 'us');
    assert.equal(loadConfig({ WOOCOMMERCE_STORES: stores, EU_SECRET: 'cs_eu_secret', WOOCOMMERCE_DEFAULT_STORE: 'EU' }).defaultStore, 'eu');
  });

  it('reads stores from a file and combines them with the single-store variables', () => {
    const files: string[] = [];
    const config = loadConfig(
      { ...validEnv, WOOCOMMERCE_STORE_ID: 'main', WOOCOMMERCE_STORES_FILE: '/etc/stores.json', EU_SECRET: 'cs_eu_secret' },
      (path) => {
        files.push(path);
        return stores;
      },
    );
    assert.deepEqual(files, ['/etc/stores.json']);
    assert.deepEqual(
      config.stores.map((store) => store.id),
      ['main', 'eu', 'us'],
    );
  });

  it('reports missing secrets, duplicates, and an unknown default', () => {
    assert.throws(() => loadConfig({ WOOCOMMERCE_STORES: stores }), /environment variable EU_SECRET is not set/);
    const duplicate = JSON.stringify([
      { id: 'a', url: 'https://a.example.com', consumerKey: 'ck_a_key', consumerSecret: 'cs_a_secret' },
      { id: 'A', url: 'https://b.example.com', consumerKey: 'ck_b_key', consumerSecret: 'cs_b_secret' },
    ]);
    assert.throws(() => loadConfig({ WOOCOMMERCE_STORES: duplicate }), /duplicate store id/);
    assert.throws(
      () => loadConfig({ ...validEnv, WOOCOMMERCE_DEFAULT_STORE: 'missing' }),
      /WOOCOMMERCE_DEFAULT_STORE/,
    );
    assert.throws(() => loadConfig({ WOOCOMMERCE_STORES: '{nope' }), /valid JSON/);
    assert.throws(
      () => loadConfig({ WOOCOMMERCE_STORES: '[]', WOOCOMMERCE_STORES_FILE: '/x' }),
      /not both/,
    );
  });
});

describe('HTTP authentication settings', () => {
  const token = 'a'.repeat(32);

  it('allows a public bind only with bearer auth', () => {
    assert.throws(() => loadConfig({ ...validEnv, MCP_HTTP_HOST: '0.0.0.0' }), /MCP_HTTP_HOST/);
    const config = loadConfig({ ...validEnv, MCP_HTTP_HOST: '0.0.0.0', MCP_HTTP_AUTH_TOKENS: token });
    assert.equal(config.httpHost, '0.0.0.0');
    assert.deepEqual(config.httpAuth?.tokens, [token]);
  });

  it('rejects short tokens and an introspection endpoint without an issuer', () => {
    assert.throws(() => loadConfig({ ...validEnv, MCP_HTTP_AUTH_TOKENS: 'short' }), /at least 24/);
    assert.throws(
      () =>
        loadConfig({
          ...validEnv,
          MCP_OAUTH_INTROSPECTION_URL: 'https://auth.example.com/introspect',
          MCP_OAUTH_CLIENT_ID: 'mcp',
          MCP_OAUTH_CLIENT_SECRET: 'secret',
        }),
      /MCP_OAUTH_ISSUER/,
    );
  });

  it('parses introspection, scopes, and allow lists', () => {
    const config = loadConfig({
      ...validEnv,
      MCP_OAUTH_INTROSPECTION_URL: 'https://auth.example.com/introspect',
      MCP_OAUTH_CLIENT_ID: 'mcp',
      MCP_OAUTH_CLIENT_SECRET: 'secret',
      MCP_OAUTH_ISSUER: 'https://auth.example.com',
      MCP_OAUTH_REQUIRED_SCOPES: 'mcp, woocommerce:read',
      MCP_HTTP_ALLOWED_HOSTS: 'mcp.example.com',
      MCP_HTTP_ALLOWED_ORIGINS: 'https://app.example.com',
    });
    assert.equal(config.httpAuth?.introspection?.clientId, 'mcp');
    assert.deepEqual(config.httpAuth?.requiredScopes, ['mcp', 'woocommerce:read']);
    assert.deepEqual(config.httpAllowedHosts, ['mcp.example.com']);
    assert.deepEqual(config.httpAllowedOrigins, ['https://app.example.com']);
  });

  it('warns about unauthenticated HTTP with a writable store', () => {
    const config = loadConfig({ ...validEnv, MCP_TRANSPORT: 'http', WOOCOMMERCE_READ_ONLY: 'false' });
    assert.ok(authWarnings(config).some((warning) => warning.includes('MCP_HTTP_AUTH_TOKENS')));
  });
});

function only(config: AppConfig): StoreConfig {
  const store = config.stores[0];
  assert.ok(store);
  return store;
}
