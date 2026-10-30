import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadEnvFile, parseEnvFile } from '../src/env-file.js';
import { ConfigError } from '../src/woocommerce/errors.js';

describe('parseEnvFile', () => {
  it('reads assignments, quotes, and comments', () => {
    const values = parseEnvFile(`
# comment
WOOCOMMERCE_URL=https://store.example.com
export WOOCOMMERCE_READ_ONLY="false"
WOOCOMMERCE_CONSUMER_SECRET='cs secret'
EMPTY=
`);
    assert.equal(values.WOOCOMMERCE_URL, 'https://store.example.com');
    assert.equal(values.WOOCOMMERCE_READ_ONLY, 'false');
    assert.equal(values.WOOCOMMERCE_CONSUMER_SECRET, 'cs secret');
    assert.equal(values.EMPTY, '');
  });

  it('rejects a malformed line without echoing the value', () => {
    assert.throws(
      () => parseEnvFile('NOT A LINE cs_test_secret\n'),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.message.includes('cs_test_secret'), false);
        assert.match(error.message, /line 1/);
        return true;
      },
    );
  });
});

describe('loadEnvFile', () => {
  it('fills only keys that are not already set', () => {
    const directory = mkdtempSync(join(tmpdir(), 'woocommerce-mcp-'));
    const file = join(directory, '.env');
    writeFileSync(file, 'WOOCOMMERCE_URL=https://from-file.example\nWOOCOMMERCE_CONSUMER_KEY=ck_file\n');
    const target: NodeJS.ProcessEnv = { WOOCOMMERCE_URL: 'https://from-env.example' };
    loadEnvFile(target, file);
    assert.equal(target.WOOCOMMERCE_URL, 'https://from-env.example');
    assert.equal(target.WOOCOMMERCE_CONSUMER_KEY, 'ck_file');
    loadEnvFile(target, join(directory, 'missing.env'));
    assert.equal(target.WOOCOMMERCE_CONSUMER_SECRET, undefined);
  });
});
