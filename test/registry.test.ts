import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createAuditLog, memoryAuditLog } from '../src/audit.js';
import { SCOPES } from '../src/config.js';
import { createProduct } from '../src/tools/products.js';
import { CREATE, READ, runTool, type ToolSpec } from '../src/tools/registry.js';
import { createProductInput, getProductInput } from '../src/tools/schemas.js';
import { getProduct } from '../src/tools/products.js';
import { createFetchMock, jsonResponse, resultText, testRuntime, testStore } from './helpers.js';

const createSpec: ToolSpec<typeof createProductInput> = {
  name: 'woocommerce_create_product',
  title: 'Create product',
  description: 'Create a product.',
  input: createProductInput,
  annotations: CREATE,
  write: true,
  run: createProduct,
};

const getSpec: ToolSpec<typeof getProductInput> = {
  name: 'woocommerce_get_product',
  title: 'Get product',
  description: 'Get a product.',
  input: getProductInput,
  annotations: READ,
  write: false,
  run: getProduct,
};

const writable = { stores: [testStore({ readOnly: false })] };

function parse(result: Parameters<typeof resultText>[0]): Record<string, unknown> {
  return JSON.parse(resultText(result)) as Record<string, unknown>;
}

describe('write guard', () => {
  it('previews with dryRun even when confirmation is off', async () => {
    const { fetchImpl, requests } = createFetchMock(async () => jsonResponse({ id: 9 }));
    const audit = memoryAuditLog();
    const runtime = testRuntime(fetchImpl, { ...writable, requireConfirmation: false }, { audit });
    const result = await runTool(runtime, createSpec, { name: 'Hat', dryRun: true, confirm: true });
    const body = parse(result);
    assert.equal(body.status, 'dry_run');
    assert.deepEqual(body.request, { method: 'POST', path: 'products', query: {}, body: { name: 'Hat' } });
    assert.equal(requests.length, 0);
    assert.equal(audit.entries[0]?.outcome, 'dry_run');
    assert.deepEqual(audit.entries[0]?.arguments, { name: 'Hat' });

    await runTool(runtime, createSpec, { name: 'Hat' });
    assert.equal(requests.length, 1);
    assert.equal(audit.entries[1]?.outcome, 'applied');
  });

  it('refuses writes to a read-only store and without the write scope', async () => {
    const { fetchImpl, requests } = createFetchMock(async () => jsonResponse({ id: 9 }));
    const audit = memoryAuditLog();
    const readOnly = testRuntime(fetchImpl, {}, { audit });
    const refused = await runTool(readOnly, createSpec, { name: 'Hat', confirm: true });
    assert.equal(refused.isError, true);
    assert.match(resultText(refused), /store \\"default\\" is in read-only mode/);

    const scoped = testRuntime(fetchImpl, writable, { audit, scopesEnforced: true });
    const readToken = { token: 't', clientId: 'reader', scopes: [SCOPES.read], expiresAt: 2e9 };
    const forbidden = await runTool(scoped, createSpec, { name: 'Hat', confirm: true }, readToken);
    assert.equal(forbidden.isError, true);
    assert.match(resultText(forbidden), /insufficient_scope/);
    const read = await runTool(scoped, getSpec, { id: 9 }, readToken);
    assert.notEqual(read.isError, true);

    const writeToken = { ...readToken, clientId: 'writer', scopes: [SCOPES.read, SCOPES.write] };
    const applied = await runTool(scoped, createSpec, { name: 'Hat', confirm: true }, writeToken);
    assert.notEqual(applied.isError, true);
    assert.deepEqual(
      audit.entries.map((entry) => [entry.outcome, entry.client ?? null]),
      [
        ['refused', null],
        ['refused', 'reader'],
        ['applied', 'writer'],
      ],
    );
    assert.deepEqual(
      requests.map((request) => request.method),
      ['GET', 'POST'],
    );
  });

  it('reports an unknown store and API failures as tool errors', async () => {
    const { fetchImpl } = createFetchMock(async () =>
      jsonResponse({ code: 'woocommerce_rest_cannot_create', message: 'Sorry, you cannot create resources.' }, { status: 401 }),
    );
    const audit = memoryAuditLog();
    const runtime = testRuntime(fetchImpl, writable, { audit });
    const unknown = await runTool(runtime, getSpec, { id: 1, store: 'nope' });
    assert.equal(unknown.isError, true);
    assert.match(resultText(unknown), /unknown_store/);
    const failed = await runTool(runtime, createSpec, { name: 'Hat', confirm: true });
    assert.equal(failed.isError, true);
    assert.equal(audit.entries.at(-1)?.outcome, 'failed');
    assert.match(audit.entries.at(-1)?.error?.message ?? '', /cannot create/);
  });
});

describe('audit log', () => {
  it('appends JSON lines to a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'woo-audit-'));
    try {
      const path = join(dir, 'audit.jsonl');
      const log = createAuditLog(path);
      const entry = {
        time: '2026-10-30T12:00:00.000Z',
        tool: 'woocommerce_update_stock',
        store: 'default',
        outcome: 'applied' as const,
        arguments: { productId: 1, stockQuantity: 3 },
      };
      await log.record(entry);
      await log.record({ ...entry, outcome: 'dry_run' });
      const lines = (await readFile(path, 'utf8')).trim().split('\n');
      assert.equal(lines.length, 2);
      assert.deepEqual(JSON.parse(lines[0] ?? '{}'), entry);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never fails the call when the log cannot be written', async () => {
    const original = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const log = createAuditLog('/nonexistent-dir/audit.jsonl');
      const entry = { time: 't', tool: 'x', store: 's', outcome: 'applied' as const, arguments: {} };
      await log.record(entry);
      await log.record(entry);
    } finally {
      console.error = original;
    }
    assert.equal(lines.length, 1);
  });
});
