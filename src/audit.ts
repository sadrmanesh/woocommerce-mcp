import { appendFile } from 'node:fs/promises';

export type AuditOutcome = 'applied' | 'dry_run' | 'confirmation_required' | 'refused' | 'failed';

/** How a confirm's signed approval was checked. Present only when signed approvals are required. */
export interface AuditApproval {
  mode: 'signed';
  result: 'verified' | 'missing' | 'invalid' | 'expired' | 'mismatch' | 'replayed';
  /** Token id (jti) of a correctly signed token. Never the token itself. */
  tokenId?: string;
  /** Approver label from the token, when the signer set one. */
  by?: string;
}

export interface AuditEntry {
  time: string;
  tool: string;
  store: string;
  outcome: AuditOutcome;
  arguments: Record<string, unknown>;
  request?: { method: string; path: string };
  /**
   * Fingerprint of tool, store, and arguments. Previews return it, and a
   * confirm call can send it back so the applied entry links to its preview.
   */
  previewId?: string;
  /** Present when the call supplied a previewId: whether it matched the arguments. */
  previewMatch?: boolean;
  /**
   * Present when a confirm sent a previewId with a state part: whether the
   * store data the write is computed from still matched the preview.
   */
  stateMatch?: boolean;
  /** Set on a stale_preview refusal: the state id of the preview and of the store now. */
  stale?: { previewStateId: string; currentStateId: string | null };
  /** Signed approval check for this confirm, when signed approvals are required. */
  approval?: AuditApproval;
  /**
   * On a confirmation_required entry while signed approvals are required:
   * the records the preview read, with before and after values, so the
   * approve command can show them.
   */
  preconditions?: {
    stateId: string;
    recordCount: number;
    records: { resource: string; dateModified: string | null; before?: Record<string, unknown>; after?: Record<string, unknown> }[];
    truncated?: boolean;
  };
  error?: { code: string; message: string };
  client?: string;
}

export interface AuditLog {
  record: (entry: AuditEntry) => Promise<void>;
}

/** Discards entries. Used when WOOCOMMERCE_AUDIT_LOG is unset. */
export const noopAuditLog: AuditLog = {
  record: async () => undefined,
};

/**
 * Appends one JSON object per line. `stderr` writes to the process error
 * stream, which keeps container logs complete without a mounted volume.
 * A failed write is reported once on stderr and never fails the tool call.
 */
export function createAuditLog(target: string | null): AuditLog {
  if (target === null) return noopAuditLog;
  let warned = false;
  return {
    record: async (entry) => {
      const line = `${JSON.stringify(entry)}\n`;
      try {
        if (target === 'stderr') {
          process.stderr.write(`audit ${line}`);
        } else {
          await appendFile(target, line, { encoding: 'utf8', mode: 0o600 });
        }
      } catch (error) {
        if (!warned) {
          warned = true;
          const reason = error instanceof Error ? error.message : String(error);
          console.error(`woocommerce-mcp could not write the audit log: ${reason}`);
        }
      }
    },
  };
}

/** In-memory audit log for tests and embedding. */
export function memoryAuditLog(): AuditLog & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    record: async (entry) => {
      entries.push(entry);
    },
  };
}
