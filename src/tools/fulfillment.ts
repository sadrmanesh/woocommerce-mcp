import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

import type { WooCommerceClient } from '../woocommerce/client.js';
import { asCount, asString, compact, expectArray, expectRecord, isRecord } from '../woocommerce/json.js';
import { summarizeNote, summarizeOrder } from '../woocommerce/present.js';
import type { Runtime, ToolContext } from './context.js';
import { toolNames } from './names.js';
import { defineTool, DESTRUCTIVE, READ, UPDATE } from './registry.js';
import { deleteOrderNoteInput, fulfillOrderInput, getOrderTrackingInput, listOrderNotesInput } from './schemas.js';

export type ListOrderNotesInput = z.infer<typeof listOrderNotesInput>;
export type DeleteOrderNoteInput = z.infer<typeof deleteOrderNoteInput>;
export type GetOrderTrackingInput = z.infer<typeof getOrderTrackingInput>;
export type FulfillOrderInput = z.infer<typeof fulfillOrderInput>;

/** Order meta key used to store shipments when the Shipment Tracking extension is not used. */
export const TRACKING_META_KEY = 'woocommerce_mcp_tracking';
export const SHIPMENT_TRACKING_NAMESPACE = 'wc-shipment-tracking/v3';

export interface Shipment {
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: string | null;
  source: 'meta' | 'shipment-tracking';
}

export function registerFulfillmentTools(server: McpServer, runtime: Runtime): void {
  defineTool(server, runtime, {
    name: toolNames.listOrderNotes,
    title: 'List order notes',
    description: 'List the notes on an order, newest first. Filter to customer-visible or internal notes.',
    input: listOrderNotesInput,
    annotations: READ,
    write: false,
    run: listOrderNotes,
  });
  defineTool(server, runtime, {
    name: toolNames.deleteOrderNote,
    title: 'Delete order note',
    description: 'Delete one note from an order permanently. Notes have no trash.',
    input: deleteOrderNoteInput,
    annotations: DESTRUCTIVE,
    write: true,
    run: deleteOrderNote,
  });
  defineTool(server, runtime, {
    name: toolNames.getOrderTracking,
    title: 'Get order tracking',
    description: 'Read the shipments and tracking numbers recorded on an order.',
    input: getOrderTrackingInput,
    annotations: READ,
    write: false,
    run: getOrderTracking,
  });
  defineTool(server, runtime, {
    name: toolNames.fulfillOrder,
    title: 'Fulfill order',
    description:
      'Record a shipment with carrier and tracking number, mark the order completed, and add a customer note with the tracking details. The preview shows the first request; the status change and note follow it when you confirm.',
    input: fulfillOrderInput,
    annotations: UPDATE,
    write: true,
    run: fulfillOrder,
  });
}

export async function listOrderNotes(ctx: ToolContext, input: ListOrderNotesInput) {
  const response = await ctx.client.get(`orders/${input.orderId}/notes`, { type: input.type ?? 'any' });
  return {
    orderId: input.orderId,
    notes: expectArray(response.data, 'order notes').map((note) => summarizeNote(note, input.orderId)),
  };
}

export async function deleteOrderNote(ctx: ToolContext, input: DeleteOrderNoteInput) {
  const response = await ctx.client.delete(`orders/${input.orderId}/notes/${input.noteId}`, { force: true });
  return { deleted: true, note: summarizeNote(response.data, input.orderId) };
}

function trackingClient(ctx: ToolContext): WooCommerceClient {
  return ctx.client.withNamespace(SHIPMENT_TRACKING_NAMESPACE);
}

export function shipmentsFromMeta(order: Record<string, unknown>): Shipment[] {
  const meta = Array.isArray(order.meta_data) ? order.meta_data.filter(isRecord) : [];
  const entry = meta.find((item) => item.key === TRACKING_META_KEY);
  const value = entry?.value;
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    carrier: asString(item.carrier),
    trackingNumber: asString(item.tracking_number),
    trackingUrl: asString(item.tracking_url),
    shippedAt: asString(item.shipped_at),
    source: 'meta' as const,
  }));
}

function shipmentFromExtension(value: unknown): Shipment {
  const record = expectRecord(value, 'shipment tracking');
  return {
    carrier: asString(record.custom_tracking_provider) || asString(record.tracking_provider),
    trackingNumber: asString(record.tracking_number),
    trackingUrl: asString(record.custom_tracking_link) || asString(record.tracking_link),
    shippedAt: asString(record.date_shipped),
    source: 'shipment-tracking',
  };
}

export async function getOrderTracking(ctx: ToolContext, input: GetOrderTrackingInput) {
  if (ctx.trackingMode === 'shipment-tracking') {
    const response = await trackingClient(ctx).get(`orders/${input.orderId}/shipment-trackings`);
    return {
      orderId: input.orderId,
      mode: ctx.trackingMode,
      shipments: expectArray(response.data, 'shipment trackings').map(shipmentFromExtension),
    };
  }
  const order = expectRecord((await ctx.client.get(`orders/${input.orderId}`)).data, 'order');
  return {
    orderId: input.orderId,
    mode: ctx.trackingMode,
    status: asString(order.status),
    shipments: shipmentsFromMeta(order),
  };
}

export function trackingNote(shipment: Pick<Shipment, 'carrier' | 'trackingNumber' | 'trackingUrl'>): string {
  const lines = [`Your order has shipped with ${shipment.carrier ?? 'the carrier'}.`, `Tracking number: ${shipment.trackingNumber ?? ''}`];
  if (shipment.trackingUrl) lines.push(`Track it here: ${shipment.trackingUrl}`);
  return lines.join('\n');
}

export async function fulfillOrder(ctx: ToolContext, input: FulfillOrderInput) {
  const shippedAt = input.shippedAt ?? new Date().toISOString().slice(0, 10);
  const markCompleted = input.markCompleted ?? true;
  const notify = input.notifyCustomer ?? true;
  const shipment: Shipment = {
    carrier: input.carrier,
    trackingNumber: input.trackingNumber,
    trackingUrl: input.trackingUrl ?? null,
    shippedAt,
    source: ctx.trackingMode,
  };
  const steps: string[] = [];
  let order: unknown;

  if (ctx.trackingMode === 'shipment-tracking') {
    await trackingClient(ctx).post(
      `orders/${input.orderId}/shipment-trackings`,
      compact({
        custom_tracking_provider: input.carrier,
        tracking_number: input.trackingNumber,
        custom_tracking_link: input.trackingUrl,
        date_shipped: shippedAt,
      }),
    );
    steps.push('tracking added with the Shipment Tracking extension');
    if (markCompleted) {
      order = (await ctx.client.put(`orders/${input.orderId}`, { status: 'completed' })).data;
      steps.push('status set to completed');
    }
  } else {
    const current = expectRecord((await ctx.client.get(`orders/${input.orderId}`)).data, 'order');
    const shipments = shipmentsFromMeta(current).map((item) => ({
      carrier: item.carrier,
      tracking_number: item.trackingNumber,
      tracking_url: item.trackingUrl,
      shipped_at: item.shippedAt,
    }));
    shipments.push({
      carrier: input.carrier,
      tracking_number: input.trackingNumber,
      tracking_url: input.trackingUrl ?? null,
      shipped_at: shippedAt,
    });
    order = (
      await ctx.client.put(`orders/${input.orderId}`, {
        ...(markCompleted ? { status: 'completed' } : {}),
        meta_data: [{ key: TRACKING_META_KEY, value: shipments }],
      })
    ).data;
    steps.push(`tracking saved in the ${TRACKING_META_KEY} order meta`);
    if (markCompleted) steps.push('status set to completed');
  }

  let noteId: number | null = null;
  if (notify) {
    const note = await ctx.client.post(`orders/${input.orderId}/notes`, {
      note: trackingNote(shipment),
      customer_note: true,
    });
    noteId = isRecord(note.data) ? asCount(note.data.id) : null;
    steps.push('customer note added');
  }

  return {
    orderId: input.orderId,
    shipment,
    steps,
    noteId,
    order: order === undefined ? null : summarizeOrder(order),
  };
}
