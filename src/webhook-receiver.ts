import type { IncomingMessage } from 'node:http';

import { isPingBody, MAX_WEBHOOK_BODY_BYTES, verifyWebhookSignature, type WebhookEventStore } from './webhooks.js';

export interface WebhookReceiverOptions {
  /** Base path, such as /webhooks/woocommerce. Deliveries go to `${path}/{storeId}`. */
  path: string;
  events: WebhookEventStore;
  /** Returns the canonical store id and its secret, or null when the store is unknown or has no secret. */
  storeSecret: (storeId: string) => { id: string; secret: string } | null;
}

export type ReceiverResult = { status: number; body: Record<string, unknown> };

/** Returns the store segment when the path belongs to the receiver, otherwise null. */
export function webhookStoreFromPath(pathname: string, basePath: string): string | null {
  const prefix = basePath.endsWith('/') ? basePath : `${basePath}/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length).replace(/\/$/, '');
  return /^[A-Za-z0-9_-]{1,40}$/.test(rest) ? rest : null;
}

class BodyTooLarge extends Error {}

export async function readBody(request: IncomingMessage, limit = MAX_WEBHOOK_BODY_BYTES): Promise<Buffer> {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function numberHeader(request: IncomingMessage, name: string): number | null {
  const raw = header(request, name);
  return raw !== undefined && /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

/**
 * Verifies a WooCommerce webhook delivery and stores it. Deliveries are authenticated by their HMAC signature,
 * not by the MCP bearer token, because WooCommerce cannot send one.
 */
export async function receiveWebhook(
  request: IncomingMessage,
  storeSegment: string,
  options: WebhookReceiverOptions,
): Promise<ReceiverResult> {
  if (request.method !== 'POST') return { status: 405, body: { error: 'Method not allowed' } };
  const store = options.storeSecret(storeSegment);
  // Unknown stores and stores without a secret look the same from outside.
  if (store === null) return { status: 404, body: { error: 'Not found' } };
  let body: Buffer;
  try {
    body = await readBody(request);
  } catch (error) {
    if (error instanceof BodyTooLarge) return { status: 413, body: { error: 'Payload too large' } };
    throw error;
  }
  const signature = header(request, 'x-wc-webhook-signature');
  if (signature === undefined && isPingBody(body)) {
    // WooCommerce pings the URL when a webhook is saved. Nothing is stored.
    return { status: 200, body: { status: 'ok' } };
  }
  if (!verifyWebhookSignature(body, store.secret, signature)) {
    return { status: 401, body: { error: 'Invalid signature' } };
  }
  let payload: unknown;
  try {
    payload = body.length === 0 ? null : JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: { error: 'Body is not JSON' } };
  }
  const resourceId =
    payload !== null && typeof payload === 'object' && 'id' in payload && typeof payload.id === 'number' ? payload.id : null;
  const event = options.events.add({
    store: store.id,
    topic: header(request, 'x-wc-webhook-topic') ?? null,
    resource: header(request, 'x-wc-webhook-resource') ?? null,
    event: header(request, 'x-wc-webhook-event') ?? null,
    webhookId: numberHeader(request, 'x-wc-webhook-id'),
    deliveryId: header(request, 'x-wc-webhook-delivery-id') ?? null,
    resourceId,
    payload,
  });
  return { status: 202, body: { status: 'accepted', id: event.id } };
}
