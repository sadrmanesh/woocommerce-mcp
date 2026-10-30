import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

import { startTelemetry, withSpan } from '../src/telemetry.js';
import { clientWith, createFetchMock, jsonResponse } from './helpers.js';

describe('tracing', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

  before(() => {
    trace.setGlobalTracerProvider(provider);
  });

  after(async () => {
    await provider.shutdown();
    trace.disable();
  });

  it('records a span per WooCommerce request with a route template', async () => {
    exporter.reset();
    const { fetchImpl } = createFetchMock(async () => jsonResponse({ id: 42 }));
    await clientWith(fetchImpl).get('orders/42');
    const span = exporter.getFinishedSpans().find((item) => item.name === 'woocommerce GET');
    assert.ok(span);
    assert.equal(span.attributes['woocommerce.path'], 'orders/{id}');
    assert.equal(span.attributes['http.response.status_code'], 200);
    assert.equal(span.attributes['server.address'], 'store.example.com');
  });

  it('marks failed spans as errors and rethrows', async () => {
    exporter.reset();
    await assert.rejects(() =>
      withSpan('failing', {}, async () => {
        throw new Error('boom');
      }),
    );
    const span = exporter.getFinishedSpans()[0];
    assert.equal(span?.status.code, 2);
    assert.equal(span?.events[0]?.name, 'exception');
  });

  it('explains how to install the exporter when it is missing', async () => {
    await assert.rejects(
      () =>
        startTelemetry(async (name) => {
          throw new Error(`Cannot find package '${name}'`);
        }),
      /npm install @opentelemetry\/sdk-trace-base/,
    );
  });
});
