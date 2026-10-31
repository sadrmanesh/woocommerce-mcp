import { createHash } from 'node:crypto';

import type { RecordedRead } from '../woocommerce/client.js';
import type { PlannedRequest } from '../woocommerce/errors.js';
import { asCount, isRecord } from '../woocommerce/json.js';
import { canonicalJson } from './preview-id.js';

/**
 * Fields that often decide what a write computes. They are part of the state
 * fingerprint for every record a preview read, even when the write does not set them.
 */
const WATCHED_FIELDS = [
  'status',
  'type',
  'price',
  'regular_price',
  'sale_price',
  'date_on_sale_from_gmt',
  'date_on_sale_to_gmt',
  'manage_stock',
  'stock_quantity',
  'stock_status',
  'total',
] as const;

/** Most records listed in a preview. The fingerprint always covers all of them. */
export const MAX_LISTED_PRECONDITIONS = 50;

/** One record a write was computed from, as shown in a preview or a stale_preview error. */
export interface Precondition {
  resource: string;
  dateModified: string | null;
  /** Current values of the fields the planned write sets on this record. */
  before?: Record<string, Scalar>;
  /** Values the planned write sets on this record, already computed: a +10% change shows the new price. */
  after?: Record<string, Scalar>;
}

type Scalar = string | number | boolean | null;

function isScalar(value: unknown): value is Scalar {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

export interface PreviewState {
  /** First 16 hex characters of the SHA-256 of everything the preview read. */
  stateId: string;
  recordCount: number;
  records: Precondition[];
  truncated: boolean;
}

const STATE_ID = /^[0-9a-f]{16}$/;
const PREVIEW_ID = /^(pv_[0-9a-f]{16})(?:_([0-9a-f]{16}))?$/;

/** Appends the state part to an arguments-only preview id when the preview read store data. */
export function combinePreviewId(argumentsId: string, state: PreviewState | null): string {
  return state === null ? argumentsId : `${argumentsId}_${state.stateId}`;
}

/**
 * Splits a supplied preview id into its arguments part and optional state part.
 * An id that does not parse is returned whole as the arguments part, so it can never match.
 */
export function splitPreviewId(id: string): { argumentsId: string; stateId: string | null } {
  const match = PREVIEW_ID.exec(id);
  if (!match) return { argumentsId: id, stateId: null };
  const stateId = match[2];
  return { argumentsId: match[1] ?? id, stateId: stateId !== undefined && STATE_ID.test(stateId) ? stateId : null };
}

/**
 * Fingerprints the reads a planning run made. Returns null when the tool read
 * nothing, so writes that do not depend on store state keep a plain preview id.
 */
export function captureState(reads: RecordedRead[], planned: PlannedRequest | null): PreviewState | null {
  if (reads.length === 0) return null;
  const fingerprint: unknown[] = [];
  const records: Precondition[] = [];
  for (const read of reads) {
    const items = Array.isArray(read.data) ? read.data : [read.data];
    const entries: unknown[] = [];
    for (const item of items) {
      const id = isRecord(item) ? asCount(item.id) : null;
      if (!isRecord(item) || id === null) {
        // Not a record with an id, such as settings or a total: fingerprint it whole.
        entries.push({ value: item });
        continue;
      }
      const resource = Array.isArray(read.data) ? `${read.path}/${id}` : read.path;
      const dateModified = dateModifiedOf(item);
      const writtenRow = writtenValues(planned, resource);
      const written = Object.keys(writtenRow).sort();
      const values: Record<string, unknown> = {};
      for (const key of new Set<string>([...WATCHED_FIELDS, ...written])) {
        if (key in item) values[key] = item[key];
      }
      entries.push({ resource, dateModified, values });
      const before: Record<string, Scalar> = {};
      const after: Record<string, Scalar> = {};
      for (const key of written) {
        const current = item[key];
        const next = writtenRow[key];
        if (isScalar(current) || current === undefined) before[key] = current ?? null;
        if (isScalar(next)) after[key] = next;
      }
      records.push({
        resource,
        dateModified,
        ...(Object.keys(before).length > 0 ? { before } : {}),
        ...(Object.keys(after).length > 0 ? { after } : {}),
      });
    }
    fingerprint.push({ path: read.path, query: read.query, entries });
  }
  const stateId = createHash('sha256').update(canonicalJson(fingerprint)).digest('hex').slice(0, 16);
  return {
    stateId,
    recordCount: records.length,
    records: records.slice(0, MAX_LISTED_PRECONDITIONS),
    truncated: records.length > MAX_LISTED_PRECONDITIONS,
  };
}

function dateModifiedOf(item: Record<string, unknown>): string | null {
  for (const key of ['date_modified_gmt', 'date_modified']) {
    const value = item[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** Values the planned request sets on one record: a direct update of its path, or its row in a batch. */
function writtenValues(planned: PlannedRequest | null, resource: string): Record<string, unknown> {
  if (planned === null || !isRecord(planned.body)) return {};
  const body = planned.body;
  if (planned.path === resource) return body;
  if (planned.path.endsWith('/batch') && Array.isArray(body.update)) {
    const base = planned.path.slice(0, -'/batch'.length);
    for (const row of body.update) {
      if (!isRecord(row)) continue;
      const id = asCount(row.id);
      if (id !== null && `${base}/${id}` === resource) {
        const { id: _id, ...rest } = row;
        return rest;
      }
    }
  }
  return {};
}
