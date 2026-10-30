import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lowStockReport } from '../src/tools/analytics.js';
import { couponPerformance, endSale, scheduleSale, updateCoupon } from '../src/tools/coupons.js';
import { customerOrders, customerSegments, listCustomers } from '../src/tools/customers.js';
import {
  fulfillOrder,
  getOrderTracking,
  listOrderNotes,
  TRACKING_META_KEY,
  trackingNote,
} from '../src/tools/fulfillment.js';
import { listShippingZones, listTaxRates } from '../src/tools/shipping.js';
import { createWebhook, listWebhookEvents, listWebhooks, summarizeWebhook } from '../src/tools/webhooks.js';
import { WebhookEventStore } from '../src/webhooks.js';
import { InputError, PlannedWrite } from '../src/woocommerce/errors.js';
import { clientWith, createFetchMock, jsonResponse, queryParam, toolContext, type RecordedRequest } from './helpers.js';

const pages = { headers: { 'x-wp-total': '1', 'x-wp-totalpages': '1' } };

function body(request: RecordedRequest | undefined): Record<string, unknown> {
  return JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
}

describe('low stock report with variations', () => {
  it('checks each variation of variable products', async () => {
    const { fetchImpl, requests } = createFetchMock(async (request) => {
      if (request.url.includes('/products/20/variations')) {
        return jsonResponse(
          [
            { id: 21, sku: 'TEE-S', manage_stock: true, stock_quantity: 1, stock_status: 'instock', attributes: [{ option: 'S' }] },
            { id: 22, sku: 'TEE-M', manage_stock: true, stock_quantity: 40, stock_status: 'instock', attributes: [{ option: 'M' }] },
            { id: 23, sku: 'TEE-L', manage_stock: 'parent', stock_quantity: null, stock_status: 'outofstock', attributes: [] },
          ],
          pages,
        );
      }
      return jsonResponse(
        [
          { id: 10, name: 'Mug', type: 'simple', manage_stock: true, stock_quantity: 3, stock_status: 'instock' },
          { id: 20, name: 'Tee', type: 'variable', manage_stock: false, stock_status: 'instock' },
          { id: 30, name: 'Kit', type: 'variable', manage_stock: true, stock_quantity: 0, stock_status: 'outofstock' },
        ],
        pages,
      );
    });
    const report = await lowStockReport(toolContext(clientWith(fetchImpl)), { threshold: 5 });
    assert.equal(report.scanned, 3);
    assert.equal(report.variationsScanned, 3);
    assert.deepEqual(
      report.items.map((item) => [item.type, item.id, item.parentId, item.name]),
      [
        ['variation', 23, 20, 'Tee'],
        ['product', 30, null, 'Kit'],
        ['variation', 21, 20, 'Tee - S'],
        ['product', 10, null, 'Mug'],
      ],
    );
    assert.equal(requests.filter((request) => request.url.includes('variations')).length, 1);
  });

  it('skips variations when asked', async () => {
    const { fetchImpl, requests } = createFetchMock(async () =>
      jsonResponse([{ id: 20, name: 'Tee', type: 'variable', manage_stock: false, stock_status: 'outofstock' }], pages),
    );
    const report = await lowStockReport(toolContext(clientWith(fetchImpl)), { includeVariations: false });
    assert.equal(report.items[0]?.type, 'product');
    assert.equal(requests.length, 1);
  });
});

describe('promotions', () => {
  it('reports coupon usage from order coupon lines', async () => {
    const { fetchImpl, requests } = createFetchMock(async () =>
      jsonResponse(
        [
          { id: 1, total: '90.00', coupon_lines: [{ code: 'FALL10', discount: '10.00' }] },
          { id: 2, total: '45.00', coupon_lines: [{ code: 'fall10', discount: '5.00' }, { code: 'SHIP', discount: '0' }] },
          { id: 3, total: '20.00', coupon_lines: [] },
        ],
        pages,
      ),
    );
    const report = await couponPerformance(toolContext(clientWith(fetchImpl)), { after: '2026-10-01T00:00:00Z' });
    assert.equal(report.scanned, 3);
    assert.equal(report.ordersWithCoupons, 2);
    assert.deepEqual(report.coupons[0], { code: 'fall10', orders: 2, discount: '15.00', revenue: '135.00' });
    assert.equal(queryParam(requests[0]?.url ?? '', 'status'), 'processing,completed');
  });

  it('schedules a percentage sale and skips products without their own price', async () => {
    const { fetchImpl, requests } = createFetchMock(async (request) => {
      if (request.method === 'POST') return jsonResponse({ update: [{ id: 1, name: 'Mug' }] });
      return jsonResponse([
        { id: 1, name: 'Mug', type: 'simple', regular_price: '19.99' },
        { id: 2, name: 'Tee', type: 'variable', regular_price: '' },
      ]);
    });
    const result = await scheduleSale(toolContext(clientWith(fetchImpl), { readOnly: false }), {
      productIds: [1, 2, 3],
      discountPercent: 25,
      startsAt: '2026-11-27',
      endsAt: '2026-11-30',
    });
    assert.deepEqual(result.changes, [{ id: 1, name: 'Mug', regularPrice: '19.99', salePrice: '14.99' }]);
    assert.deepEqual(
      result.skipped.map((entry) => entry.id),
      [2, 3],
    );
    assert.deepEqual(body(requests[1]), {
      update: [{ id: 1, sale_price: '14.99', date_on_sale_from: '2026-11-27', date_on_sale_to: '2026-11-30' }],
    });
  });

  it('rejects a sale that ends before it starts', async () => {
    const { fetchImpl } = createFetchMock(async () => jsonResponse([]));
    await assert.rejects(
      () =>
        scheduleSale(toolContext(clientWith(fetchImpl)), {
          productIds: [1],
          discountPercent: 10,
          startsAt: '2026-12-01',
          endsAt: '2026-11-01',
        }),
      InputError,
    );
  });

  it('ends a sale by clearing price and dates', async () => {
    const { fetchImpl, requests } = createFetchMock(async (request) => {
      if (request.method === 'POST') return jsonResponse({ update: [{ id: 1 }] });
      return jsonResponse([
        { id: 1, sale_price: '9.00' },
        { id: 2, sale_price: '' },
      ]);
    });
    const result = await endSale(toolContext(clientWith(fetchImpl)), { productIds: [1, 2] });
    assert.deepEqual(result.cleared, [1]);
    assert.deepEqual(body(requests[1]), {
      update: [{ id: 1, sale_price: '', date_on_sale_from: null, date_on_sale_to: null }],
    });
  });

  it('sends null to clear a coupon expiry and refuses an empty update', async () => {
    const { fetchImpl, requests } = createFetchMock(async () => jsonResponse({ id: 4, code: 'X', _links: {} }));
    const ctx = toolContext(clientWith(fetchImpl));
    await updateCoupon(ctx, { id: 4, dateExpires: null, amount: 15 });
    assert.deepEqual(body(requests[0]), { amount: '15', date_expires: null });
    await assert.rejects(() => updateCoupon(ctx, { id: 4 }), InputError);
  });
});

describe('customers and segments', () => {
  it('masks personal data when asked', async () => {
    const { fetchImpl } = createFetchMock(async () =>
      jsonResponse([{ id: 1, email: 'sara@example.com', first_name: 'Sara', last_name: 'A', role: 'customer' }], pages),
    );
    const page = await listCustomers(toolContext(clientWith(fetchImpl)), { redactPii: true });
    assert.equal(page.items[0]?.email, 's***@example.com');
    assert.equal(page.items[0]?.firstName, '[redacted]');
  });

  it('summarizes one customer history', async () => {
    const { fetchImpl, requests } = createFetchMock(async (request) => {
      if (request.url.includes('/customers/7')) return jsonResponse({ id: 7, email: 'a@example.com' });
      return jsonResponse(
        [
          { id: 3, status: 'completed', total: '30.00', date_created_gmt: '2026-10-20T10:00:00' },
          { id: 2, status: 'refunded', total: '50.00', date_created_gmt: '2026-09-01T10:00:00' },
          { id: 1, status: 'processing', total: '10.00', date_created_gmt: '2026-08-01T10:00:00' },
        ],
        pages,
      );
    });
    const result = (await customerOrders(toolContext(clientWith(fetchImpl)), { customerId: 7, recent: 2 })) as Record<
      string,
      unknown
    >;
    assert.equal(result.orders, 3);
    assert.equal(result.paidOrders, 2);
    assert.equal(result.totalSpent, '40.00');
    assert.equal(result.averageOrderValue, '20.00');
    assert.equal(result.firstOrder, '2026-08-01T10:00:00');
    assert.equal((result.recent as unknown[]).length, 2);
    assert.equal(queryParam(requests[1]?.url ?? '', 'customer'), '7');
  });

  it('groups shoppers into VIP, repeat, one-time, at-risk, and guest segments', async () => {
    const order = (id: number, customer: number, email: string, total: string, date: string) => ({
      id,
      customer_id: customer,
      total,
      date_created_gmt: date,
      billing: { email, first_name: 'N', last_name: String(id) },
    });
    const { fetchImpl } = createFetchMock(async () =>
      jsonResponse(
        [
          order(1, 5, 'big@example.com', '500.00', '2026-05-01T00:00:00'),
          order(2, 5, 'big@example.com', '300.00', '2026-10-25T00:00:00'),
          order(3, 6, 'old@example.com', '20.00', '2026-04-01T00:00:00'),
          order(4, 6, 'old@example.com', '20.00', '2026-05-01T00:00:00'),
          order(5, 0, 'Guest@Example.com', '15.00', '2026-10-01T00:00:00'),
          order(6, 0, '', '5.00', '2026-10-01T00:00:00'),
        ],
        pages,
      ),
    );
    const result = (await customerSegments(toolContext(clientWith(fetchImpl)), {
      after: '2026-01-01T00:00:00Z',
      before: '2026-10-30T00:00:00Z',
      vipShare: 10,
    })) as { customers: number; unattributedOrders: number; segments: Record<string, { customers: number; spent: string; members: { email: string | null; customerName: string | null }[] }> };
    assert.equal(result.customers, 3);
    assert.equal(result.unattributedOrders, 1);
    assert.equal(result.segments.vip?.members[0]?.email, 'big@example.com');
    assert.equal(result.segments.repeat?.customers, 2);
    assert.equal(result.segments.oneTime?.customers, 1);
    assert.deepEqual(
      result.segments.atRisk?.members.map((member) => member.email),
      ['old@example.com'],
    );
    assert.equal(result.segments.guests?.members[0]?.email, 'guest@example.com');
    assert.equal(result.segments.vip?.spent, '800.00');

    const masked = (await customerSegments(toolContext(clientWith(fetchImpl)), {
      after: '2026-01-01T00:00:00Z',
      redactPii: true,
    })) as typeof result;
    assert.equal(masked.segments.vip?.members[0]?.email, 'b***@example.com');
    assert.equal(masked.segments.vip?.members[0]?.customerName, '[redacted]');
  });
});

describe('order notes and fulfillment', () => {
  it('lists notes by type', async () => {
    const { fetchImpl, requests } = createFetchMock(async () =>
      jsonResponse([{ id: 1, note: 'Packed', customer_note: false, author: 'system' }]),
    );
    const result = await listOrderNotes(toolContext(clientWith(fetchImpl)), { orderId: 9, type: 'internal' });
    assert.equal(result.notes[0]?.note, 'Packed');
    assert.equal(queryParam(requests[0]?.url ?? '', 'type'), 'internal');
  });

  it('stores tracking in order meta, completes the order, and notifies the customer', async () => {
    const existing = [{ carrier: 'Post', tracking_number: 'A1', tracking_url: null, shipped_at: '2026-10-01' }];
    const { fetchImpl, requests } = createFetchMock(async (request) => {
      if (request.method === 'POST') return jsonResponse({ id: 77, note: 'shipped', customer_note: true });
      if (request.method === 'PUT') return jsonResponse({ id: 9, status: 'completed', total: '10.00' });
      return jsonResponse({ id: 9, status: 'processing', meta_data: [{ id: 1, key: TRACKING_META_KEY, value: existing }] });
    });
    const result = await fulfillOrder(toolContext(clientWith(fetchImpl), { readOnly: false }), {
      orderId: 9,
      carrier: 'DHL',
      trackingNumber: 'JD0001',
      trackingUrl: 'https://track.example.com/JD0001',
      shippedAt: '2026-10-30',
    });
    assert.equal(result.noteId, 77);
    assert.equal(result.order?.status, 'completed');
    const put = body(requests[1]);
    assert.equal(put.status, 'completed');
    const meta = put.meta_data as { key: string; value: unknown[] }[];
    assert.equal(meta[0]?.key, TRACKING_META_KEY);
    assert.equal(meta[0]?.value.length, 2);
    const note = body(requests[2]);
    assert.equal(note.customer_note, true);
    assert.match(String(note.note), /JD0001/);
    assert.match(String(note.note), /track\.example\.com/);
  });

  it('plans the first write when previewing', async () => {
    const { fetchImpl } = createFetchMock(async () => jsonResponse({ id: 9, meta_data: [] }));
    await assert.rejects(
      () =>
        fulfillOrder(toolContext(clientWith(fetchImpl).planning()), {
          orderId: 9,
          carrier: 'DHL',
          trackingNumber: 'JD0001',
        }),
      (error: unknown) => error instanceof PlannedWrite && error.request.method === 'PUT',
    );
  });

  it('uses the Shipment Tracking extension when configured', async () => {
    const { fetchImpl, requests } = createFetchMock(async (request) => {
      if (request.url.includes('shipment-trackings') && request.method === 'GET') {
        return jsonResponse([{ tracking_provider: '', custom_tracking_provider: 'DHL', tracking_number: 'JD0001', date_shipped: '1730246400' }]);
      }
      return jsonResponse({ id: 9, status: 'completed' });
    });
    const ctx = toolContext(clientWith(fetchImpl), { trackingMode: 'shipment-tracking' });
    await fulfillOrder(ctx, { orderId: 9, carrier: 'DHL', trackingNumber: 'JD0001', notifyCustomer: false });
    assert.match(requests[0]?.url ?? '', /wp-json\/wc-shipment-tracking\/v3\/orders\/9\/shipment-trackings/);
    assert.equal(body(requests[0]).custom_tracking_provider, 'DHL');
    assert.match(requests[1]?.url ?? '', /wc\/v3\/orders\/9/);
    assert.equal(requests.length, 2);
    const tracking = await getOrderTracking(ctx, { orderId: 9 });
    assert.equal(tracking.shipments[0]?.carrier, 'DHL');
  });

  it('reads tracking back from order meta', async () => {
    const { fetchImpl } = createFetchMock(async () =>
      jsonResponse({
        id: 9,
        status: 'completed',
        meta_data: [{ key: TRACKING_META_KEY, value: [{ carrier: 'DHL', tracking_number: 'JD0001' }] }],
      }),
    );
    const tracking = await getOrderTracking(toolContext(clientWith(fetchImpl)), { orderId: 9 });
    assert.equal(tracking.shipments[0]?.trackingNumber, 'JD0001');
    assert.equal(trackingNote({ carrier: 'DHL', trackingNumber: 'X', trackingUrl: null }).includes('Track it'), false);
  });
});

describe('webhooks', () => {
  it('never returns the webhook secret', async () => {
    const { fetchImpl } = createFetchMock(async () =>
      jsonResponse([{ id: 1, name: 'Orders', topic: 'order.created', secret: 'top-secret', delivery_url: 'https://x.example/h' }], pages),
    );
    const page = await listWebhooks(toolContext(clientWith(fetchImpl)), {});
    assert.equal(JSON.stringify(page).includes('top-secret'), false);
    assert.equal(page.items[0]?.hasSecret, true);
    assert.equal(summarizeWebhook({ id: 2, secret: '' }).hasSecret, false);
  });

  it('signs new webhooks with the configured store secret', async () => {
    const { fetchImpl, requests } = createFetchMock(async () => jsonResponse({ id: 3, topic: 'order.created' }));
    const input = { name: 'Orders', topic: 'order.created' as const, deliveryUrl: 'https://mcp.example.com/webhooks/woocommerce/default' };
    await assert.rejects(() => createWebhook(toolContext(clientWith(fetchImpl)), input), /no webhook secret/);
    await createWebhook(toolContext(clientWith(fetchImpl), { webhookSecret: 'store-webhook-secret' }), input);
    assert.equal(body(requests[0]).secret, 'store-webhook-secret');
    assert.equal(body(requests[0]).status, 'active');
  });

  it('lists received events for the current store', async () => {
    const events = new WebhookEventStore(10);
    const base = { resource: 'order', event: 'created', webhookId: 3, deliveryId: 'd1', resourceId: 55 };
    events.add({ ...base, store: 'default', topic: 'order.created', payload: { id: 55 } });
    events.add({ ...base, store: 'other', topic: 'order.created', payload: { id: 56 } });
    const { fetchImpl } = createFetchMock(async () => jsonResponse([]));
    const result = await listWebhookEvents(toolContext(clientWith(fetchImpl), { events }), {
      topic: 'order.*',
      includePayload: true,
    });
    assert.equal(result.events.length, 1);
    assert.deepEqual((result.events[0] as { payload: unknown }).payload, { id: 55 });
    assert.equal(result.receiverEnabled, false);
  });
});

describe('shipping and tax', () => {
  it('lists zones with locations and method settings', async () => {
    const { fetchImpl, requests } = createFetchMock(async (request) => {
      if (request.url.endsWith('/shipping/zones')) {
        return jsonResponse([
          { id: 0, name: 'Everywhere else', order: 0 },
          { id: 1, name: 'Iran', order: 1 },
        ]);
      }
      if (request.url.includes('/locations')) return jsonResponse([{ code: 'IR', type: 'country' }]);
      return jsonResponse([
        {
          instance_id: 4,
          method_id: 'flat_rate',
          title: 'Post',
          enabled: true,
          settings: { cost: { value: '50000' }, title: { value: 'Post' }, tax_status: { value: 'taxable' } },
        },
      ]);
    });
    const result = await listShippingZones(toolContext(clientWith(fetchImpl)), {});
    assert.equal(result.zones.length, 2);
    assert.deepEqual(result.zones[0]?.locations, []);
    assert.deepEqual(result.zones[1]?.locations, [{ code: 'IR', type: 'country' }]);
    assert.deepEqual((result.zones[1]?.methods as { settings: unknown }[])[0]?.settings, {
      title: 'Post',
      cost: '50000',
      tax_status: 'taxable',
    });
    assert.equal(requests.filter((request) => request.url.includes('zones/0/locations')).length, 0);
  });

  it('filters tax rates by class', async () => {
    const { fetchImpl, requests } = createFetchMock(async () =>
      jsonResponse([{ id: 1, country: 'DE', rate: '19.0000', name: 'MwSt', class: 'standard', postcodes: [], cities: [] }], pages),
    );
    const result = await listTaxRates(toolContext(clientWith(fetchImpl)), { taxClass: 'standard' });
    assert.equal(result.items[0]?.rate, '19.0000');
    assert.equal(queryParam(requests[0]?.url ?? '', 'class'), 'standard');
  });
});
