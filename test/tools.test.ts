import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { listCoupons, createCoupon } from '../src/tools/coupons.js';
import { getCustomer, listCustomers } from '../src/tools/customers.js';
import { getStock, updateStock } from '../src/tools/inventory.js';
import { addOrderNote, listOrders, updateOrderStatus } from '../src/tools/orders.js';
import { createProduct, listProducts, searchProducts, updateProduct } from '../src/tools/products.js';
import { execute } from '../src/tools/result.js';
import {
  createProductInput,
  isoDateSchema,
  listProductsInput,
  updateStockInput,
} from '../src/tools/schemas.js';
import { getStoreSummary } from '../src/tools/summary.js';
import { InputError } from '../src/woocommerce/errors.js';
import { clientWith, createFetchMock, jsonResponse, queryParam, toolContext } from './helpers.js';

describe('product tools', () => {
  it('lists and searches with pagination and filters', async () => {
    const { fetchImpl, requests } = createFetchMock(async () =>
      jsonResponse(
        [
          {
            id: 7,
            name: 'Wool scarf',
            sku: 'SCARF',
            type: 'simple',
            status: 'publish',
            price: '25.00',
            regular_price: '25.00',
            sale_price: '',
            stock_status: 'instock',
            stock_quantity: 4,
            manage_stock: true,
            permalink: 'https://store.example.com/p/scarf',
            _links: { self: [{ href: 'https://store.example.com/wp-json/wc/v3/products/7' }] },
          },
        ],
        { headers: { 'x-wp-total': '12', 'x-wp-totalpages': '2' } },
      ),
    );
    const ctx = toolContext(clientWith(fetchImpl));
    const page = await listProducts(ctx, { search: 'scarf', page: 2, perPage: 5, stockStatus: 'instock' });
    assert.equal(page.items[0]?.name, 'Wool scarf');
    assert.equal(page.items[0]?.sku, 'SCARF');
    assert.equal(page.pagination.total, 12);
    assert.equal(page.pagination.page, 2);
    const listed = requests[0]?.url ?? '';
    assert.equal(queryParam(listed, 'search'), 'scarf');
    assert.equal(queryParam(listed, 'page'), '2');
    assert.equal(queryParam(listed, 'per_page'), '5');
    assert.equal(queryParam(listed, 'stock_status'), 'instock');
    assert.equal(
      requests[0]?.headers.get('authorization'),
      `Basic ${Buffer.from('ck_test_key:cs_test_secret').toString('base64')}`,
    );

    await searchProducts(ctx, { query: 'wool', perPage: 3 });
    assert.equal(queryParam(requests[1]?.url ?? '', 'search'), 'wool');
    assert.equal(queryParam(requests[1]?.url ?? '', 'per_page'), '3');
  });

  it('creates a draft with stock management and updates only the fields provided', async () => {
    const { fetchImpl, requests } = createFetchMock(async (request) => {
      const body = JSON.parse(request.body ?? '{}') as { name?: string };
      return jsonResponse({ id: 9, name: body.name ?? 'Updated', _links: { self: [] } });
    });
    const ctx = toolContext(clientWith(fetchImpl));
    await createProduct(ctx, {
      name: 'Hat',
      status: 'draft',
      regularPrice: 19.5,
      stockQuantity: 3,
      images: [{ src: 'https://cdn.example.com/hat.jpg' }],
    });
    assert.equal(requests[0]?.method, 'POST');
    assert.deepEqual(JSON.parse(requests[0]?.body ?? '{}'), {
      name: 'Hat',
      status: 'draft',
      regular_price: '19.5',
      stock_quantity: 3,
      manage_stock: true,
      images: [{ src: 'https://cdn.example.com/hat.jpg' }],
    });

    await updateProduct(ctx, { id: 9, salePrice: '', manageStock: false, stockQuantity: 0 });
    assert.ok(requests[1]?.url.endsWith('/products/9'));
    assert.deepEqual(JSON.parse(requests[1]?.body ?? '{}'), {
      sale_price: '',
      manage_stock: false,
      stock_quantity: 0,
    });

    await assert.rejects(() => updateProduct(ctx, { id: 9 }), InputError);
    assert.equal(requests.length, 2);
  });
});

describe('order, customer, coupon, and stock tools', () => {
  it('updates order status and adds a customer-visible note', async () => {
    const order = {
      id: 15,
      number: '1015',
      status: 'completed',
      currency: 'USD',
      total: '40.00',
      customer_id: 2,
      line_items: [
        { name: 'Hat', quantity: 1, total: '20.00' },
        { name: 'Scarf', quantity: 2, total: '20.00' },
        { name: 'Pin', quantity: 1, total: '0.00' },
        { name: 'Bag', quantity: 1, total: '0.00' },
      ],
    };
    const { fetchImpl, requests } = createFetchMock(async (request) => {
      if (request.url.includes('/notes')) {
        return jsonResponse({
          id: 3,
          note: 'Packed',
          customer_note: true,
          author: 'shop',
          date_created: '2026-10-30T12:00:00',
        });
      }
      if (request.method === 'GET' && !request.url.includes('/orders/15')) return jsonResponse([order]);
      return jsonResponse(order);
    });
    const ctx = toolContext(clientWith(fetchImpl));
    const orders = await listOrders(ctx, { status: 'processing', page: 1 });
    assert.equal(orders.items[0]?.lineItemCount, 4);
    assert.equal(orders.items[0]?.lineItems.length, 3);
    assert.equal(queryParam(requests[0]?.url ?? '', 'status'), 'processing');

    const updated = await updateOrderStatus(ctx, { id: 15, status: 'completed' });
    assert.equal(updated.status, 'completed');
    assert.deepEqual(JSON.parse(requests[1]?.body ?? '{}'), { status: 'completed' });

    const note = await addOrderNote(ctx, { orderId: 15, note: 'Packed', customerNote: true });
    assert.equal(note.customerNote, true);
    assert.ok(requests[2]?.url.includes('/orders/15/notes'));
    assert.deepEqual(JSON.parse(requests[2]?.body ?? '{}'), { note: 'Packed', customer_note: true });
  });

  it('lists customers and strips links from a single customer', async () => {
    const { fetchImpl, requests } = createFetchMock(async (request) => {
      if (request.url.includes('/customers/4')) {
        return jsonResponse({ id: 4, email: 'a@example.com', first_name: 'Ada', _links: { self: [] } });
      }
      return jsonResponse([{ id: 4, email: 'a@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'customer' }]);
    });
    const ctx = toolContext(clientWith(fetchImpl));
    const page = await listCustomers(ctx, { email: 'a@example.com' });
    assert.equal(page.items[0]?.email, 'a@example.com');
    assert.equal(queryParam(requests[0]?.url ?? '', 'email'), 'a@example.com');
    const customer = await getCustomer(ctx, { id: 4 });
    assert.equal(JSON.stringify(customer).includes('_links'), false);
  });

  it('updates variation stock', async () => {
    const { fetchImpl, requests } = createFetchMock(async () =>
      jsonResponse({ id: 9, parent_id: 4, sku: 'HAT-S', stock_quantity: 2, manage_stock: true, stock_status: 'instock' }),
    );
    const ctx = toolContext(clientWith(fetchImpl));
    const stock = await updateStock(ctx, { productId: 4, variationId: 9, stockQuantity: 2 });
    assert.equal(stock.variationId, 9);
    assert.equal(stock.stockQuantity, 2);
    assert.ok(requests[0]?.url.includes('/products/4/variations/9'));
    assert.deepEqual(JSON.parse(requests[0]?.body ?? '{}'), { stock_quantity: 2, manage_stock: true });
    await getStock(ctx, { productId: 4 });
    assert.match(requests[1]?.url ?? '', /\/products\/4$/);
    await assert.rejects(() => updateStock(ctx, { productId: 4 }), InputError);
  });

  it('lists and creates coupons', async () => {
    const { fetchImpl, requests } = createFetchMock(async (request) => {
      if (request.method === 'POST') return jsonResponse({ id: 8, code: 'FALL10', _links: { self: [] } });
      return jsonResponse([{ id: 8, code: 'FALL10', discount_type: 'percent', amount: '10.00', usage_count: 1 }]);
    });
    const ctx = toolContext(clientWith(fetchImpl));
    const page = await listCoupons(ctx, { code: 'FALL10' });
    assert.equal(page.items[0]?.discountType, 'percent');
    const created = await createCoupon(ctx, { code: 'FALL10', amount: '10', discountType: 'percent', productIds: [7] });
    assert.equal(JSON.stringify(created).includes('_links'), false);
    assert.deepEqual(JSON.parse(requests[1]?.body ?? '{}'), {
      code: 'FALL10',
      amount: '10',
      discount_type: 'percent',
      product_ids: [7],
    });
  });
});

describe('store summary', () => {
  it('reads sales, top sellers, and totals for the default month', async () => {
    const { fetchImpl, requests } = createFetchMock(async (request) => {
      if (request.url.includes('/reports/sales')) {
        return jsonResponse([
          {
            total_sales: '14.00',
            net_sales: '4.00',
            average_sales: '2.00',
            total_orders: 3,
            total_items: 6,
            total_tax: '0.00',
            total_shipping: '10.00',
            total_refunds: 1,
            total_discount: '0.00',
            totals_grouped_by: 'day',
            total_customers: 2,
            totals: {
              '2026-10-02': { sales: '0.00', orders: 0, items: 0, customers: 0 },
              '2026-10-01': { sales: '14.00', orders: 3, items: 6, customers: 2 },
            },
            _links: { about: [] },
          },
        ]);
      }
      if (request.url.includes('/top_sellers')) {
        return jsonResponse([{ title: 'Hat', product_id: 7, quantity: 3 }]);
      }
      if (request.url.includes('/orders/totals')) return jsonResponse([{ slug: 'completed', name: 'Completed', total: 3 }]);
      if (request.url.includes('/products/totals')) return jsonResponse([{ slug: 'simple', name: 'Simple', total: 4 }]);
      return jsonResponse([{ slug: 'paying', name: 'Paying customer', total: '2' }]);
    });
    const summary = await getStoreSummary(toolContext(clientWith(fetchImpl)), {});
    assert.equal(summary.period, 'month');
    assert.equal(summary.sales?.totalSales, '14.00');
    assert.deepEqual(
      summary.sales?.buckets.map((bucket) => bucket.date),
      ['2026-10-01', '2026-10-02'],
    );
    assert.equal(summary.topSellers[0]?.productId, 7);
    assert.equal(summary.ordersByStatus[0]?.slug, 'completed');
    assert.equal(summary.customersByType[0]?.total, '2');
    assert.equal(requests.length, 5);
    assert.equal(queryParam(requests[0]?.url ?? '', 'period'), 'month');
    assert.equal(JSON.stringify(summary).includes('_links'), false);
  });

  it('passes an explicit date range through and rejects an inverted range', async () => {
    const { fetchImpl, requests } = createFetchMock(async () => jsonResponse([]));
    const ctx = toolContext(clientWith(fetchImpl));
    await assert.rejects(
      () => getStoreSummary(ctx, { dateMin: '2026-10-20', dateMax: '2026-10-01' }),
      InputError,
    );
    assert.equal(requests.length, 0);
    await getStoreSummary(ctx, { dateMin: '2026-10-01', dateMax: '2026-10-15' });
    const salesUrl = requests.find((request) => request.url.includes('/reports/sales'))?.url ?? '';
    assert.equal(queryParam(salesUrl, 'period'), null);
    assert.equal(queryParam(salesUrl, 'date_min'), '2026-10-01');
    assert.equal(queryParam(salesUrl, 'date_max'), '2026-10-15');
  });
});

describe('input schemas and the write guard', () => {
  it('rejects invalid pages, dates, and coupon-like product input', () => {
    assert.equal(listProductsInput.safeParse({ perPage: 101 }).success, false);
    assert.equal(listProductsInput.safeParse({ page: 0 }).success, false);
    assert.equal(isoDateSchema.safeParse('2026-02-31').success, false);
    assert.equal(isoDateSchema.safeParse('2026-10-30').success, true);
    assert.equal(createProductInput.safeParse({}).success, false);
    assert.equal(createProductInput.safeParse({ name: 'Hat', unknown: true }).success, false);
    assert.equal(updateStockInput.safeParse({ productId: 1, stockQuantity: -1 }).success, false);
  });

  it('refuses a write before calling the store', async () => {
    let called = false;
    const { fetchImpl, requests } = createFetchMock(async () => jsonResponse({}));
    const result = await execute(toolContext(clientWith(fetchImpl), { readOnly: true }), 'woocommerce_create_product', true, async () => {
      called = true;
      return { id: 1 };
    });
    assert.equal(called, false);
    assert.equal(requests.length, 0);
    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content[0] && result.content[0].type === 'text' ? result.content[0].text : '{}') as {
      error: { code: string };
    };
    assert.equal(payload.error.code, 'read_only');
  });
});
