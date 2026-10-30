import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lowStockReport, periodKey, salesAnalytics } from '../src/tools/analytics.js';
import { adjustPrice, bulkAdjustPrices, bulkUpdateProducts } from '../src/tools/bulk.js';
import { createRefund, getRefund, listRefunds } from '../src/tools/refunds.js';
import { createRefundInput, salesAnalyticsInput } from '../src/tools/schemas.js';
import { InputError, PlannedWrite } from '../src/woocommerce/errors.js';
import { clientWith, createFetchMock, jsonResponse, queryParam, toolContext } from './helpers.js';

describe('refund tools', () => {
  it('lists, reads, and creates refunds', async () => {
    const { fetchImpl, requests } = createFetchMock(async (request) => {
      if (request.method === 'POST') return jsonResponse({ id: 31, amount: '5.00', reason: 'Damaged', _links: {} });
      if (request.url.includes('/refunds/31')) return jsonResponse({ id: 31, amount: '5.00', _links: {} });
      return jsonResponse([{ id: 31, amount: '5.00', reason: 'Damaged', refunded_payment: false, line_items: [{}] }], {
        headers: { 'x-wp-total': '1', 'x-wp-totalpages': '1' },
      });
    });
    const ctx = toolContext(clientWith(fetchImpl), { readOnly: false });
    const list = await listRefunds(ctx, { orderId: 12 });
    assert.equal(list.items[0]?.amount, '5.00');
    assert.equal(list.items[0]?.lineItemCount, 1);
    assert.match(requests[0]?.url ?? '', /orders\/12\/refunds\?/);
    assert.deepEqual(await getRefund(ctx, { orderId: 12, refundId: 31 }), { id: 31, amount: '5.00' });

    await createRefund(ctx, {
      orderId: 12,
      amount: 5,
      reason: 'Damaged',
      lineItems: [{ id: 99, quantity: 1, refundTotal: '5', refundTax: [{ id: 1, refundTotal: 0.5 }] }],
      restockItems: true,
    });
    const post = requests.at(-1);
    assert.equal(post?.method, 'POST');
    assert.deepEqual(JSON.parse(post?.body ?? '{}'), {
      amount: '5',
      reason: 'Damaged',
      line_items: [{ id: 99, quantity: 1, refund_total: '5', refund_tax: [{ id: 1, refund_total: '0.5' }] }],
      api_refund: false,
      restock_items: true,
    });
  });

  it('needs an amount or line items', async () => {
    const { fetchImpl, requests } = createFetchMock(async () => jsonResponse({}));
    const ctx = toolContext(clientWith(fetchImpl), { readOnly: false });
    await assert.rejects(() => createRefund(ctx, { orderId: 1 }), InputError);
    assert.equal(requests.length, 0);
    assert.equal(createRefundInput.safeParse({ orderId: 1, amount: '-1' }).success, false);
  });
});

describe('bulk product tools', () => {
  it('sends one batch and separates per-product errors', async () => {
    const { fetchImpl, requests } = createFetchMock(async () =>
      jsonResponse({
        update: [
          { id: 1, name: 'Mug', regular_price: '12.00', stock_quantity: 3 },
          { id: 2, error: { code: 'woocommerce_rest_product_invalid_id', message: 'Invalid ID.' } },
        ],
      }),
    );
    const ctx = toolContext(clientWith(fetchImpl), { readOnly: false });
    const outcome = await bulkUpdateProducts(ctx, {
      updates: [
        { id: 1, regularPrice: 12, stockQuantity: 3 },
        { id: 2, salePrice: '' },
      ],
    });
    assert.match(requests[0]?.url ?? '', /products\/batch$/);
    assert.deepEqual(JSON.parse(requests[0]?.body ?? '{}'), {
      update: [
        { id: 1, regular_price: '12', manage_stock: true, stock_quantity: 3 },
        { id: 2, sale_price: '' },
      ],
    });
    assert.equal(outcome.updated[0]?.regularPrice, '12.00');
    assert.deepEqual(outcome.errors, [{ id: 2, code: 'woocommerce_rest_product_invalid_id', message: 'Invalid ID.' }]);
  });

  it('rejects duplicate or empty updates before calling the store', async () => {
    const { fetchImpl, requests } = createFetchMock(async () => jsonResponse({}));
    const ctx = toolContext(clientWith(fetchImpl), { readOnly: false });
    await assert.rejects(() => bulkUpdateProducts(ctx, { updates: [{ id: 1, status: 'draft' }, { id: 1, status: 'publish' }] }), /more than once/);
    await assert.rejects(() => bulkUpdateProducts(ctx, { updates: [{ id: 1 }] }), /no fields/);
    assert.equal(requests.length, 0);
  });

  it('rounds price adjustments half away from zero', () => {
    assert.equal(adjustPrice(19.99, 'percent', 10, 2), 21.99);
    assert.equal(adjustPrice(10, 'percent', -15, 2), 8.5);
    assert.equal(adjustPrice(19.995, 'fixed', 0, 2), 20);
    assert.equal(adjustPrice(9.99, 'fixed', 1, 0), 11);
  });

  it('reads current prices, skips what it cannot change, and plans the batch', async () => {
    const { fetchImpl, requests } = createFetchMock(async () =>
      jsonResponse([
        { id: 1, name: 'Mug', type: 'simple', regular_price: '10.00', sale_price: '' },
        { id: 2, name: 'Kit', type: 'variable', regular_price: '' },
        { id: 3, name: 'Gift', type: 'simple', regular_price: '' },
      ]),
    );
    const client = clientWith(fetchImpl);
    const ctx = toolContext(client.planning(), { readOnly: false });
    await assert.rejects(
      () => bulkAdjustPrices(ctx, { productIds: [1, 2, 3, 4], mode: 'percent', change: 5 }),
      (error: unknown) => {
        assert.ok(error instanceof PlannedWrite);
        assert.equal(error.request.method, 'POST');
        assert.equal(error.request.path, 'products/batch');
        assert.deepEqual(error.request.body, { update: [{ id: 1, regular_price: '10.50' }] });
        return true;
      },
    );
    assert.equal(queryParam(requests[0]?.url ?? '', 'include'), '1,2,3,4');
    assert.equal(requests.length, 1);

    const sale = await bulkAdjustPrices(toolContext(client, { readOnly: false }), {
      productIds: [2, 3],
      mode: 'percent',
      change: -20,
      target: 'sale',
    });
    assert.equal(sale.result, null);
    assert.deepEqual(
      sale.skipped.map((entry) => entry.id),
      [2, 3],
    );
  });
});

describe('analytics tools', () => {
  const order = (id: number, date: string, total: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    status: 'completed',
    currency: 'EUR',
    date_created_gmt: date,
    total,
    total_tax: '1.00',
    shipping_total: '2.00',
    discount_total: '0.00',
    payment_method_title: 'Card',
    line_items: [{ product_id: 7, name: 'Scarf', quantity: 2, total: '20.00' }],
    refunds: [],
    ...extra,
  });

  it('pages through orders and aggregates sales', async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) => order(index + 1, '2026-10-05T10:00:00', '10.00'));
    const pageTwo = [
      order(101, '2026-10-12T10:00:00', '30.10', {
        refunds: [{ id: 1, total: '-5.05' }],
        payment_method_title: '',
        payment_method: 'cod',
        line_items: [{ product_id: 8, name: 'Hat', quantity: 1, total: '25.00' }],
      }),
    ];
    const { fetchImpl, requests } = createFetchMock(async (request) => {
      const page = queryParam(request.url, 'page');
      return jsonResponse(page === '1' ? pageOne : pageTwo, { headers: { 'x-wp-total': '101', 'x-wp-totalpages': '2' } });
    });
    const result = await salesAnalytics(toolContext(clientWith(fetchImpl)), {
      after: '2026-10-01T00:00:00',
      groupBy: 'week',
      top: 1,
    });
    assert.equal(requests.length, 2);
    assert.equal(queryParam(requests[0]?.url ?? '', 'status'), 'processing,completed');
    assert.equal(queryParam(requests[0]?.url ?? '', 'per_page'), '100');
    assert.equal(result.orders, 101);
    assert.equal(result.currency, 'EUR');
    assert.equal(result.grossSales, '1030.10');
    assert.equal(result.refunds, '5.05');
    assert.equal(result.netSales, '1025.05');
    assert.equal(result.averageOrderValue, '10.20');
    assert.equal(result.itemsSold, 201);
    assert.deepEqual(result.series, [
      { period: '2026-10-05', orders: 100, total: '1000.00' },
      { period: '2026-10-12', orders: 1, total: '30.10' },
    ]);
    assert.deepEqual(result.topProducts, [{ productId: 7, name: 'Scarf', quantity: 200, total: '2000.00' }]);
    assert.deepEqual(
      result.paymentMethods.map((entry) => entry.method),
      ['Card', 'cod'],
    );
    assert.equal(result.truncated, false);
  });

  it('stops at maxOrders and says so', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => order(index + 1, '2026-10-05T10:00:00', '1.00'));
    const { fetchImpl, requests } = createFetchMock(async () => jsonResponse(rows, { headers: { 'x-wp-totalpages': '9' } }));
    const result = await salesAnalytics(toolContext(clientWith(fetchImpl)), { after: '2026-10-01T00:00:00', maxOrders: 150 });
    assert.equal(result.orders, 150);
    assert.equal(result.truncated, true);
    assert.equal(requests.length, 2);
  });

  it('buckets dates by day, week, and month in UTC', () => {
    assert.equal(periodKey('2026-10-30T23:30:00', 'day'), '2026-10-30');
    assert.equal(periodKey('2026-11-01T08:00:00Z', 'week'), '2026-10-26');
    assert.equal(periodKey('2026-10-30T23:30:00', 'month'), '2026-10');
    assert.equal(periodKey(null, 'day'), 'unknown');
    assert.equal(salesAnalyticsInput.safeParse({ after: '2026-10-01' }).success, false);
  });

  it('reports low and out-of-stock products, most urgent first', async () => {
    const { fetchImpl } = createFetchMock(async () =>
      jsonResponse([
        { id: 1, name: 'Mug', manage_stock: true, stock_quantity: 4, stock_status: 'instock' },
        { id: 2, name: 'Hat', manage_stock: true, stock_quantity: 40, stock_status: 'instock' },
        { id: 3, name: 'Kit', manage_stock: false, stock_quantity: null, stock_status: 'outofstock' },
        { id: 4, name: 'Pin', manage_stock: true, stock_quantity: 0, stock_status: 'outofstock' },
      ]),
    );
    const report = await lowStockReport(toolContext(clientWith(fetchImpl)), { threshold: 5 });
    assert.deepEqual(
      report.items.map((item) => item.id),
      [3, 4, 1],
    );
    assert.equal(report.scanned, 4);
    const managedOnly = await lowStockReport(toolContext(clientWith(fetchImpl)), { includeOutOfStock: false });
    assert.deepEqual(
      managedOnly.items.map((item) => item.id),
      [4, 1],
    );
  });
});
