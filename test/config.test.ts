import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { authWarnings, loadConfig } from '../src/config.js';
import { ConfigError } from '../src/woocommerce/errors.js';
import { validEnv } from './helpers.js';

describe('loadConfig', () => {
  it('defaults to read-only basic auth on https', () => {
    const config = loadConfig({ ...validEnv, PATH: '/usr/bin' });
    assert.equal(config.readOnly, true);
    assert.equal(config.authMode, 'basic');
    assert.equal(config.transport, 'stdio');
    assert.equal(config.apiVersion, 'wc/v3');
    assert.equal(config.defaultPerPage, 10);
    assert.equal(config.maxRetries, 2);
    assert.equal(config.timeoutMs, 30_000);
    assert.equal(config.httpHost, '127.0.0.1');
    assert.equal(config.httpPath, '/mcp');
    assert.equal(config.url, 'https://store.example.com');
    assert.equal(config.userAgent, 'woocommerce-mcp/0.1.0');
  });

  it('treats an explicit false flag as permission to write', () => {
    assert.equal(loadConfig({ ...validEnv, WOOCOMMERCE_READ_ONLY: 'false' }).readOnly, false);
    assert.equal(loadConfig({ ...validEnv, WOOCOMMERCE_READ_ONLY: 'no' }).readOnly, false);
    assert.equal(loadConfig({ ...validEnv, WOOCOMMERCE_READ_ONLY: 'YES' }).readOnly, true);
  });

  it('uses oauth1 for http unless a mode is set', () => {
    const config = loadConfig({ ...validEnv, WOOCOMMERCE_URL: 'http://store.example.com/shop/' });
    assert.equal(config.url, 'http://store.example.com/shop');
    assert.equal(config.authMode, 'oauth1');
    assert.equal(loadConfig({ ...validEnv, WOOCOMMERCE_AUTH_MODE: 'query' }).authMode, 'query');
  });

  it('normalizes the store URL', () => {
    const config = loadConfig({ ...validEnv, WOOCOMMERCE_URL: 'https://store.example.com:443/shop/' });
    assert.equal(config.url, 'https://store.example.com/shop');
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
