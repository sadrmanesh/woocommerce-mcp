import { type McpServer, ResourceNotFoundError, ResourceTemplate } from '@modelcontextprotocol/server';

import { redactPersonalData } from './redact.js';
import { resolveStore, type Runtime, type StoreHandle } from './tools/context.js';
import { listStores } from './tools/stores.js';
import { presentEvent } from './tools/webhooks.js';
import { expectRecord, stripLinks } from './woocommerce/json.js';

export const RESOURCE_URIS = {
  stores: 'woocommerce://stores',
  product: 'woocommerce://stores/{store}/products/{id}',
  order: 'woocommerce://stores/{store}/orders/{id}',
  events: 'woocommerce://stores/{store}/events',
  event: 'woocommerce://stores/{store}/events/{id}',
} as const;

function guarded(store: StoreHandle, data: unknown): unknown {
  return store.config.redactPii ? redactPersonalData(data) : data;
}

function single(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function numericId(value: string | string[] | undefined, uri: URL): number {
  const raw = single(value);
  if (!/^[1-9]\d{0,15}$/.test(raw)) throw new ResourceNotFoundError(uri.href);
  return Number(raw);
}

function json(uri: URL, data: unknown): { contents: { uri: string; mimeType: string; text: string }[] } {
  return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
}

export function registerResources(server: McpServer, runtime: Runtime): void {
  server.registerResource(
    'stores',
    RESOURCE_URIS.stores,
    {
      title: 'Configured stores',
      description: 'The WooCommerce stores this server can reach, with ids, default store, and write mode.',
      mimeType: 'application/json',
    },
    async (uri) => json(uri, listStores(runtime)),
  );

  const storeIds = (value: string): string[] =>
    runtime.stores.map((store) => store.config.id).filter((id) => id.startsWith(value));

  server.registerResource(
    'product',
    new ResourceTemplate(RESOURCE_URIS.product, { list: undefined, complete: { store: storeIds } }),
    {
      title: 'Product',
      description: 'One product as returned by the WooCommerce REST API, without _links.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const store = resolveStore(runtime, single(variables.store));
      const response = await store.client.get(`products/${numericId(variables.id, uri)}`);
      return json(uri, guarded(store, stripLinks(expectRecord(response.data, 'product'))));
    },
  );

  server.registerResource(
    'order',
    new ResourceTemplate(RESOURCE_URIS.order, { list: undefined, complete: { store: storeIds } }),
    {
      title: 'Order',
      description: 'One order as returned by the WooCommerce REST API, without _links. Contains customer personal data.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const store = resolveStore(runtime, single(variables.store));
      const response = await store.client.get(`orders/${numericId(variables.id, uri)}`);
      return json(uri, guarded(store, stripLinks(expectRecord(response.data, 'order'))));
    },
  );

  server.registerResource(
    'webhook-events',
    new ResourceTemplate(RESOURCE_URIS.events, { list: undefined, complete: { store: storeIds } }),
    {
      title: 'Webhook events',
      description: 'The 50 most recent webhook deliveries received for a store, newest first, without payloads.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const store = resolveStore(runtime, single(variables.store));
      const events = runtime.events.list({ store: store.config.id, limit: 50 });
      return json(uri, {
        store: store.config.id,
        buffered: runtime.events.count(store.config.id),
        events: events.map((event) => presentEvent(event, false, false)),
      });
    },
  );

  server.registerResource(
    'webhook-event',
    new ResourceTemplate(RESOURCE_URIS.event, { list: undefined, complete: { store: storeIds } }),
    {
      title: 'Webhook event',
      description: 'One webhook delivery with its payload. Payloads can contain customer personal data.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const store = resolveStore(runtime, single(variables.store));
      const event = runtime.events.get(store.config.id, numericId(variables.id, uri));
      if (!event) throw new ResourceNotFoundError(uri.href);
      return json(uri, presentEvent(event, true, store.config.redactPii));
    },
  );
}
