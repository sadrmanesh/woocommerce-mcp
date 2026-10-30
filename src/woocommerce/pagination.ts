export interface Pagination {
  page: number | null;
  perPage: number | null;
  total: number | null;
  totalPages: number | null;
}

export function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.round(Number(trimmed) * 1000));
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return Math.max(0, parsed - now);
}

export function readTotalHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}
