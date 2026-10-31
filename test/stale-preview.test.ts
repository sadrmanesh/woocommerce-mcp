import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { memoryAuditLog } from '../src/audit.js';
import { bulkAdjustPrices } from '../src/tools/bulk.js';
import { previewIdFor } from '../src/tools/preview-id.js';
import { captureState, splitPreviewId } from '../src/tools/preview-state.js';
import { runTool, type ToolSpec, UPDATE } from '../src/tools/registry.js';
import { bulkAdjustPricesInput } from '../src/tools/schemas.js';
import { createFetchMock, jsonResponse, resultText, testRuntime, testStore } from './helpers.js';

const adjustSpec: ToolSpec<typeof bulkAdjustPricesInput> = {
  name: 'woocommerce_bulk_adjust_prices',
  title: 'Bulk adjust prices',
  description: 'Adjust prices.',
  input: bulkAdjustPricesInput,
  annotations: UPDATE,
  write: true,
  run: bulkAdjustPrices,
};

const writable = { stores: [testStore({ readOnly: false })] };
const raise = { productIds: [12], mode: 'percent' as const, change: 10 };

function parse(result: Parameters<typeof resultText>[0]): Record<string, unknown> {
  return JSON.parse(resultText(result)) as Record<string, unknown>;
}

/** A one-product store whose price and modification date the test can change between calls. */
function mockStore() {
  const product = {
    id: 12,
    name: 'Hat',
    type: 'simple',
    regular_price: '20.00',
    sale_price: '',
    date_modified_gmt: '2026-10-30T10:00:00',
  };
  const writes: unknown[] = [];
  const { fetchImpl, requests } = createFetchMock(async (request) => {
    if (request.method === 'GET') return jsonResponse([{ ...product }]);
    const body = JSON.parse(request.body ?? '{}') as { update: { id: number; regular_price?: string }[] };
    writes.push(body);
    for (const row of body.update) if (row.regular_price !== undefined) product.regular_price = row.regular_price;
    return jsonResponse({ update: body.update.map((row) => ({ ...product, ...row })) });
  });
  return { product, writes, requests, fetchImpl };
}

describe('stale preview detection', () => {
  it('shows absolute before and after values and a state part in the previewId', async () => {
    const store = mockStore();
    const runtime = testRuntime(store.fetchImpl, writable);
    const preview = parse(await runTool(runtime, adjustSpec, raise));
    assert.equal(preview.status, 'confirmation_required');
    assert.match(String(preview.previewId), /^pv_[0-9a-f]{16}_[0-9a-f]{16}$/);
    const preconditions = preview.preconditions as Record<string, unknown>;
    assert.equal(String(preview.previewId).endsWith(`_${String(preconditions.stateId)}`), true);
    assert.equal(preconditions.recordCount, 1);
    assert.deepEqual(preconditions.records, [
      {
        resource: 'products/12',
        dateModified: '2026-10-30T10:00:00',
        before: { regular_price: '20.00' },
        after: { regular_price: '22.00' },
      },
    ]);
    assert.equal(store.writes.length, 0);
  });

  it('applies a confirm when the store still matches the preview', async () => {
    const store = mockStore();
    const audit = memoryAuditLog();
    const runtime = testRuntime(store.fetchImpl, writable, { audit });
    const preview = parse(await runTool(runtime, adjustSpec, raise));
    const applied = await runTool(runtime, adjustSpec, { ...raise, confirm: true, previewId: String(preview.previewId) });
    assert.notEqual(applied.isError, true);
    assert.deepEqual(store.writes, [{ update: [{ id: 12, regular_price: '22.00' }] }]);
    const last = audit.entries.at(-1);
    assert.equal(last?.outcome, 'applied');
    assert.equal(last?.previewId, preview.previewId);
    assert.equal(last?.previewMatch, true);
    assert.equal(last?.stateMatch, true);
  });

  it('refuses with stale_preview when the price changed after the preview', async () => {
    const store = mockStore();
    const audit = memoryAuditLog();
    const runtime = testRuntime(store.fetchImpl, writable, { audit });
    const preview = parse(await runTool(runtime, adjustSpec, raise));
    store.product.regular_price = '25.00';

    const refused = await runTool(runtime, adjustSpec, { ...raise, confirm: true, previewId: String(preview.previewId) });
    assert.equal(refused.isError, true);
    const error = (parse(refused).error ?? {}) as Record<string, unknown>;
    assert.equal(error.code, 'stale_preview');
    assert.match(String(error.message), /fresh preview/);
    const details = error.details as Record<string, unknown>;
    const { stateId } = splitPreviewId(String(preview.previewId));
    assert.equal(details.previewStateId, stateId);
    assert.notEqual(details.currentStateId, stateId);
    assert.deepEqual(details.current, [
      {
        resource: 'products/12',
        dateModified: '2026-10-30T10:00:00',
        before: { regular_price: '25.00' },
        after: { regular_price: '27.50' },
      },
    ]);
    assert.equal(store.writes.length, 0);
    assert.equal(store.requests.filter((request) => request.method !== 'GET').length, 0);

    const last = audit.entries.at(-1);
    assert.equal(last?.outcome, 'refused');
    assert.equal(last?.error?.code, 'stale_preview');
    assert.equal(last?.previewMatch, true);
    assert.equal(last?.stateMatch, false);
    assert.deepEqual(last?.stale, { previewStateId: stateId, currentStateId: details.currentStateId });

    // A fresh preview shows the new values and its id applies.
    const fresh = parse(await runTool(runtime, adjustSpec, raise));
    assert.notEqual(fresh.previewId, preview.previewId);
    await runTool(runtime, adjustSpec, { ...raise, confirm: true, previewId: String(fresh.previewId) });
    assert.deepEqual(store.writes, [{ update: [{ id: 12, regular_price: '27.50' }] }]);
  });

  it('refuses with stale_preview when only date_modified changed', async () => {
    const store = mockStore();
    const runtime = testRuntime(store.fetchImpl, writable);
    const preview = parse(await runTool(runtime, adjustSpec, raise));
    store.product.date_modified_gmt = '2026-10-31T09:30:00';
    const refused = await runTool(runtime, adjustSpec, { ...raise, confirm: true, previewId: String(preview.previewId) });
    assert.match(resultText(refused), /stale_preview/);
    assert.equal(store.writes.length, 0);
  });

  it('reads fresh data for the check even when responses are cached', async () => {
    const store = mockStore();
    const runtime = testRuntime(store.fetchImpl, { ...writable, cacheTtlMs: 60_000 });
    const preview = parse(await runTool(runtime, adjustSpec, raise));
    store.product.regular_price = '25.00';
    const refused = await runTool(runtime, adjustSpec, { ...raise, confirm: true, previewId: String(preview.previewId) });
    assert.match(resultText(refused), /stale_preview/);
    assert.equal(store.writes.length, 0);
  });

  it('keeps v0.4.0 behavior for a confirm without a previewId or with an arguments-only id', async () => {
    const store = mockStore();
    const audit = memoryAuditLog();
    const runtime = testRuntime(store.fetchImpl, writable, { audit });
    await runTool(runtime, adjustSpec, raise);
    store.product.regular_price = '25.00';

    const plain = await runTool(runtime, adjustSpec, { ...raise, confirm: true });
    assert.notEqual(plain.isError, true);
    assert.deepEqual(store.writes, [{ update: [{ id: 12, regular_price: '27.50' }] }]);
    const last = audit.entries.at(-1);
    assert.equal(last?.outcome, 'applied');
    assert.equal(last?.previewId, previewIdFor(adjustSpec.name, 'default', raise));
    assert.equal(last?.previewMatch, undefined);
    assert.equal(last?.stateMatch, undefined);

    const argumentsOnly = previewIdFor(adjustSpec.name, 'default', raise);
    const applied = await runTool(runtime, adjustSpec, { ...raise, confirm: true, previewId: argumentsOnly });
    assert.notEqual(applied.isError, true);
    assert.equal(audit.entries.at(-1)?.previewMatch, true);
    assert.equal(audit.entries.at(-1)?.stateMatch, undefined);
  });

  it('reports preview_mismatch for changed arguments and stale_preview for changed state', async () => {
    const store = mockStore();
    const audit = memoryAuditLog();
    const runtime = testRuntime(store.fetchImpl, writable, { audit });
    const preview = parse(await runTool(runtime, adjustSpec, raise));
    store.product.regular_price = '25.00';

    // Different arguments are a mismatch, checked before any state is read.
    const before = store.requests.length;
    const mismatch = await runTool(runtime, adjustSpec, {
      ...raise,
      change: 20,
      confirm: true,
      previewId: String(preview.previewId),
    });
    assert.match(resultText(mismatch), /preview_mismatch/);
    assert.doesNotMatch(resultText(mismatch), /stale_preview/);
    assert.equal(store.requests.length, before);
    assert.equal(audit.entries.at(-1)?.error?.code, 'preview_mismatch');
    assert.equal(audit.entries.at(-1)?.stale, undefined);

    const stale = await runTool(runtime, adjustSpec, { ...raise, confirm: true, previewId: String(preview.previewId) });
    assert.match(resultText(stale), /stale_preview/);
    assert.doesNotMatch(resultText(stale), /preview_mismatch/);
    assert.equal(audit.entries.at(-1)?.error?.code, 'stale_preview');
    assert.equal(store.writes.length, 0);
  });

  it('flags a removed product as stale', async () => {
    const store = mockStore();
    const runtime = testRuntime(store.fetchImpl, writable);
    const preview = parse(await runTool(runtime, adjustSpec, raise));
    const { fetchImpl } = createFetchMock(async () => jsonResponse([]));
    const emptied = testRuntime(fetchImpl, writable);
    const refused = await runTool(emptied, adjustSpec, { ...raise, confirm: true, previewId: String(preview.previewId) });
    assert.match(resultText(refused), /stale_preview/);
  });
});

describe('preview state fingerprint', () => {
  it('is absent when the plan read nothing', () => {
    assert.equal(captureState([], { method: 'POST', path: 'products', query: {}, body: { name: 'Hat' } }), null);
  });

  it('splits preview ids and never matches an unparseable one', () => {
    assert.deepEqual(splitPreviewId('pv_0123456789abcdef_fedcba9876543210'), {
      argumentsId: 'pv_0123456789abcdef',
      stateId: 'fedcba9876543210',
    });
    assert.deepEqual(splitPreviewId('pv_0123456789abcdef'), { argumentsId: 'pv_0123456789abcdef', stateId: null });
    assert.deepEqual(splitPreviewId('nonsense'), { argumentsId: 'nonsense', stateId: null });
  });

  it('ignores unrelated fields but tracks watched and written ones', () => {
    const planned = { method: 'PUT', path: 'orders/5', query: {}, body: { status: 'completed' } };
    const read = (extra: Record<string, unknown>) => [
      { path: 'orders/5', query: {}, data: { id: 5, status: 'processing', date_modified_gmt: 'T1', ...extra } },
    ];
    const base = captureState(read({ customer_note: 'a' }), planned);
    assert.equal(captureState(read({ customer_note: 'b' }), planned)?.stateId, base?.stateId);
    assert.notEqual(captureState(read({ status: 'on-hold' }), planned)?.stateId, base?.stateId);
    assert.deepEqual(base?.records, [
      { resource: 'orders/5', dateModified: 'T1', before: { status: 'processing' }, after: { status: 'completed' } },
    ]);
  });
});
