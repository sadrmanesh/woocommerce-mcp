import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

export interface WebhookEvent {
  /** Sequence number, unique for the life of the process. */
  id: number;
  store: string;
  /** Topic from X-WC-Webhook-Topic, such as order.created. */
  topic: string | null;
  resource: string | null;
  event: string | null;
  webhookId: number | null;
  deliveryId: string | null;
  /** Id of the order, product, customer, or coupon in the payload, when present. */
  resourceId: number | null;
  receivedAt: string;
  payload: unknown;
}

export interface WebhookEventSummary {
  id: number;
  store: string;
  topic: string | null;
  resourceId: number | null;
  webhookId: number | null;
  receivedAt: string;
}

export interface EventQuery {
  store: string;
  topic?: string;
  sinceId?: number;
  limit?: number;
}

/** Keeps the most recent deliveries per store in memory. Nothing is written to disk. */
export class WebhookEventStore {
  private readonly events = new Map<string, WebhookEvent[]>();
  private nextId = 1;
  private readonly listeners = new Set<(event: WebhookEvent) => void>();

  constructor(
    private readonly capacity: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  add(event: Omit<WebhookEvent, 'id' | 'receivedAt'>): WebhookEvent {
    const stored: WebhookEvent = { ...event, id: this.nextId, receivedAt: this.now().toISOString() };
    this.nextId += 1;
    const key = event.store.toLowerCase();
    const list = this.events.get(key) ?? [];
    list.push(stored);
    if (list.length > this.capacity) list.splice(0, list.length - this.capacity);
    this.events.set(key, list);
    for (const listener of this.listeners) listener(stored);
    return stored;
  }

  /** Newest first. */
  list(query: EventQuery): WebhookEvent[] {
    const list = this.events.get(query.store.toLowerCase()) ?? [];
    const topic = query.topic;
    return list
      .filter((event) => (topic === undefined ? true : matchesTopic(topic, event.topic)))
      .filter((event) => (query.sinceId === undefined ? true : event.id > query.sinceId))
      .reverse()
      .slice(0, query.limit ?? 50);
  }

  get(store: string, id: number): WebhookEvent | undefined {
    return (this.events.get(store.toLowerCase()) ?? []).find((event) => event.id === id);
  }

  count(store: string): number {
    return this.events.get(store.toLowerCase())?.length ?? 0;
  }

  onEvent(listener: (event: WebhookEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function summarizeEvent(event: WebhookEvent): WebhookEventSummary {
  return {
    id: event.id,
    store: event.store,
    topic: event.topic,
    resourceId: event.resourceId,
    webhookId: event.webhookId,
    receivedAt: event.receivedAt,
  };
}

/** `order.*` matches every order topic; an exact topic matches itself. */
export function matchesTopic(pattern: string, topic: string | null): boolean {
  if (topic === null) return false;
  if (pattern.endsWith('.*')) return topic.startsWith(pattern.slice(0, -1));
  return pattern === topic;
}

/** WooCommerce signs the raw body with HMAC-SHA256 and sends it base64 encoded in X-WC-Webhook-Signature. */
export function verifyWebhookSignature(body: Buffer, secret: string, signature: string | undefined): boolean {
  if (signature === undefined || signature === '') return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function signWebhookBody(body: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

/** WooCommerce sends `webhook_id=<id>` as a form post, without a signature, when a webhook is saved. */
export function isPingBody(body: Buffer): boolean {
  return /^webhook_id=\d{1,20}$/.test(body.toString('utf8').trim());
}
