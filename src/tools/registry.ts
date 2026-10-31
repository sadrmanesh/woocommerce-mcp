import type { AuthInfo, McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { ApprovalError } from '../approval.js';
import type { AuditApproval, AuditEntry, AuditOutcome } from '../audit.js';
import { SCOPES, toolAllowed } from '../config.js';
import { redactPersonalData } from '../redact.js';
import { withSpan } from '../telemetry.js';
import {
  ForbiddenError,
  PlannedWrite,
  PreviewMismatchError,
  ReadOnlyModeError,
  StalePreviewError,
  ToolDisabledError,
} from '../woocommerce/errors.js';
import type { RecordedRead, WooCommerceClient } from '../woocommerce/client.js';
import { resolveStore, type Runtime, type ToolContext } from './context.js';
import { previewIdFor } from './preview-id.js';
import { captureState, combinePreviewId, type PreviewState, splitPreviewId } from './preview-state.js';
import { jsonResult as plainJsonResult, serializeError, type ToolResult } from './result.js';

export const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const CREATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export const UPDATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export const WRITE_NOTE =
  'Write tool: refused while the store is read-only. Pass dryRun: true to preview the request. When confirmation is required (the default), call once to get a preview, then again with confirm: true and the returned previewId to apply it. A confirm with a previewId is refused with stale_preview if the store data the change was computed from has changed since the preview.';

const storeField = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .optional()
  .describe('Store id from woocommerce_list_stores. Defaults to the default store');

const writeFields = {
  dryRun: z.boolean().optional().describe('Preview the WooCommerce request without sending it'),
  confirm: z.boolean().optional().describe('Apply the change. Required when the server asks for confirmation'),
  previewId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'previewId from the preview of this change. The call is refused if the arguments differ from the preview, or if the store data it was computed from has changed since',
    ),
};

/** Added to write tools when WOOCOMMERCE_APPROVAL_SECRET is set. */
export const APPROVAL_NOTE =
  'This server requires a signed approval: a confirm must also pass approval, a token the user creates for this previewId outside the conversation. You cannot create one yourself.';

const approvalField = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .optional()
  .describe(
    'Signed approval token for this previewId, given to you by the user. Required with confirm: true when the server requires signed approvals',
  );

type AnyObject = z.ZodObject<z.ZodRawShape>;

export interface ToolSpec<S extends AnyObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  write: boolean;
  run: (ctx: ToolContext, input: z.infer<S>) => Promise<unknown>;
}

interface CallMeta {
  store?: string;
  dryRun?: boolean;
  confirm?: boolean;
  previewId?: string;
  approval?: string;
}

export function defineTool<S extends AnyObject>(server: McpServer, runtime: Runtime, spec: ToolSpec<S>): void {
  if (!toolAllowed(runtime.tools, spec.name)) return;
  // Hide tools that no configured store allows.
  if (!runtime.stores.some((store) => toolAllowed(store.config.tools, spec.name))) return;
  const signed = runtime.approval !== null;
  const schema = spec.write
    ? spec.input.extend({ store: storeField, ...writeFields, ...(signed ? { approval: approvalField } : {}) })
    : spec.input.extend({ store: storeField });
  const note = signed ? `${WRITE_NOTE} ${APPROVAL_NOTE}` : WRITE_NOTE;
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.write ? `${spec.description} ${note}` : spec.description,
      inputSchema: schema,
      annotations: spec.annotations,
    },
    async (input: Record<string, unknown>, ctx) =>
      runTool(runtime, spec, input as z.infer<S> & CallMeta, ctx.http?.authInfo),
  );
}

export async function runTool<S extends AnyObject>(
  runtime: Runtime,
  spec: ToolSpec<S>,
  input: z.infer<S> & CallMeta,
  authInfo?: AuthInfo,
): Promise<ToolResult> {
  const { store: storeId, dryRun, confirm, previewId: suppliedPreviewId, approval: approvalToken, ...rest } = input;
  const args = rest as z.infer<S>;
  return withSpan(
    `tool ${spec.name}`,
    { 'mcp.tool.name': spec.name, 'woocommerce.store': storeId ?? runtime.defaultStore, 'mcp.tool.write': spec.write },
    async (span) => {
      let storeLabel = storeId ?? runtime.defaultStore;
      // Set once the store is known: links this call to its preview in the audit log.
      let link: Pick<AuditEntry, 'previewId' | 'previewMatch' | 'stateMatch'> = {};
      // Set on confirms when signed approvals are required.
      let approvalAudit: AuditApproval | undefined;
      const audit = async (outcome: AuditOutcome, extra: Partial<AuditEntry> = {}): Promise<void> => {
        if (!spec.write) return;
        span.setAttribute('woocommerce.write.outcome', outcome);
        await runtime.audit.record({
          time: new Date().toISOString(),
          tool: spec.name,
          store: storeLabel,
          outcome,
          arguments: args as Record<string, unknown>,
          ...(authInfo ? { client: authInfo.clientId } : {}),
          ...link,
          ...(approvalAudit ? { approval: approvalAudit } : {}),
          ...extra,
        });
      };

      try {
        const handle = resolveStore(runtime, storeId);
        storeLabel = handle.config.id;
        if (!toolAllowed(handle.config.tools, spec.name)) throw new ToolDisabledError(spec.name, handle.config.id);
        const jsonResult = (value: unknown): ToolResult =>
          plainJsonResult(handle.config.redactPii ? redactPersonalData(value) : value);
        const ctx: ToolContext = {
          client: handle.client,
          readOnly: handle.config.readOnly,
          defaultPerPage: runtime.defaultPerPage,
          storeId: handle.config.id,
          events: runtime.events,
          trackingMode: runtime.trackingMode,
          webhookSecret: handle.config.webhookSecret,
        };
        if (!spec.write) return jsonResult(await spec.run(ctx, args));

        if (runtime.scopesEnforced && authInfo && !authInfo.scopes.includes(SCOPES.write)) {
          throw new ForbiddenError(`Refused to run ${spec.name}: the access token lacks the ${SCOPES.write} scope.`);
        }
        const argumentsId = previewIdFor(spec.name, handle.config.id, args as Record<string, unknown>);
        const verifier = runtime.approval;
        // Signed approvals only make sense with a preview to approve, so they imply confirmation.
        const confirmationRequired = runtime.requireConfirmation || verifier !== null;
        const preview = dryRun === true || (confirmationRequired && confirm !== true);
        const supplied = !preview && suppliedPreviewId !== undefined ? splitPreviewId(suppliedPreviewId) : null;
        link =
          supplied !== null
            ? { previewId: suppliedPreviewId, previewMatch: supplied.argumentsId === argumentsId }
            : { previewId: argumentsId };
        if (handle.config.readOnly) throw new ReadOnlyModeError(spec.name, handle.config.id);

        if (!preview) {
          if (link.previewMatch === false) {
            throw new PreviewMismatchError(spec.name, handle.config.id, suppliedPreviewId ?? '');
          }
          if (verifier !== null) {
            approvalAudit = { mode: 'signed', result: 'missing' };
            if (suppliedPreviewId === undefined) {
              throw new ApprovalError(
                'approval_required',
                `Refused to run ${spec.name}: this server requires a signed approval for every write, and an approval is bound to a previewId. Nothing was sent to the store. Call the tool without confirm to get a preview, show it to the user, and ask them to approve its previewId.`,
              );
            }
            const claims = verifier.consume(approvalToken, {
              previewId: suppliedPreviewId,
              tool: spec.name,
              store: handle.config.id,
            });
            approvalAudit = { mode: 'signed', result: 'verified', tokenId: claims.jti, ...(claims.by ? { by: claims.by } : {}) };
            // The approval covers the exact preview, so the full id must match the store as it is now.
            const { state } = await plan(spec, ctx, handle.client, args);
            const currentStateId = state?.stateId ?? null;
            if (supplied?.stateId === null && currentStateId !== null) {
              throw new PreviewMismatchError(spec.name, handle.config.id, suppliedPreviewId, 'missing_state');
            }
            if (supplied?.stateId) {
              link = { ...link, stateMatch: currentStateId === supplied.stateId };
              if (!link.stateMatch) {
                const shown = state === null ? [] : state.records;
                throw new StalePreviewError(spec.name, handle.config.id, {
                  previewStateId: supplied.stateId,
                  currentStateId,
                  current: handle.config.redactPii ? redactPersonalData(shown) : shown,
                });
              }
            }
          } else if (supplied?.stateId) {
            // Re-run the plan on fresh reads and compare the state it was computed from.
            const { state } = await plan(spec, ctx, handle.client, args);
            const currentStateId = state?.stateId ?? null;
            link = { ...link, stateMatch: currentStateId === supplied.stateId };
            if (!link.stateMatch) {
              const stale = { previewStateId: supplied.stateId, currentStateId };
              const shown = state === null ? [] : state.records;
              throw new StalePreviewError(spec.name, handle.config.id, {
                ...stale,
                current: handle.config.redactPii ? redactPersonalData(shown) : shown,
              });
            }
          }
          const result = await spec.run(ctx, args);
          await audit('applied');
          return jsonResult(result);
        }

        const planned = await plan(spec, ctx, handle.client, args);
        const previewId = combinePreviewId(argumentsId, planned.state);
        link = { previewId };
        const preconditions = planned.state === null ? {} : { preconditions: showState(planned.state, handle.config.redactPii) };
        if (planned.write === null) {
          // The tool finished without needing a write, for example an empty change set.
          await audit(dryRun === true ? 'dry_run' : 'confirmation_required');
          return jsonResult({ status: 'no_change', store: handle.config.id, previewId, ...preconditions, result: planned.result });
        }
        // Previews echo the caller's own arguments, so they are not masked.
        const request = { method: planned.write.method, path: planned.write.path };
        const plannedRequest = { ...planned.write, body: hideSecrets(planned.write.body) };
        if (dryRun === true) {
          await audit('dry_run', { request });
          return plainJsonResult({
            status: 'dry_run',
            store: handle.config.id,
            previewId,
            message: 'Nothing was sent to the store. This is the request the tool would make.',
            request: plannedRequest,
            ...preconditions,
          });
        }
        await audit('confirmation_required', {
          request,
          ...(verifier !== null && planned.state !== null ? { preconditions: auditState(planned.state, handle.config.redactPii) } : {}),
        });
        return plainJsonResult({
          status: 'confirmation_required',
          store: handle.config.id,
          previewId,
          message:
            'The change was NOT applied. Review the request below with the user, then call this tool again with the same arguments, confirm: true, and this previewId.',
          request: plannedRequest,
          ...preconditions,
        });
      } catch (error) {
        const payload = serializeError(error);
        const refused =
          error instanceof ReadOnlyModeError ||
          error instanceof ForbiddenError ||
          error instanceof ToolDisabledError ||
          error instanceof PreviewMismatchError ||
          error instanceof StalePreviewError ||
          error instanceof ApprovalError;
        if (error instanceof ApprovalError) {
          approvalAudit = {
            mode: 'signed',
            result: APPROVAL_RESULTS[error.code],
            ...(error.tokenId ? { tokenId: error.tokenId } : {}),
            ...(error.by ? { by: error.by } : {}),
          };
        }
        await audit(refused ? 'refused' : 'failed', {
          error: { code: payload.error.code, message: payload.error.message },
          ...(error instanceof StalePreviewError
            ? { stale: { previewStateId: error.details.previewStateId, currentStateId: error.details.currentStateId } }
            : {}),
        });
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
    },
  );
}

interface Plan {
  /** The first write the tool would send, or null when it finished without one. */
  write: PlannedWrite['request'] | null;
  /** The tool's own result when it finished without a write. */
  result: unknown;
  /** Fingerprint of the store data the plan read, or null when it read nothing. */
  state: PreviewState | null;
}

/**
 * Runs a write tool on a planning client that reads fresh data and stops at
 * the first write, recording every read so the plan's inputs can be fingerprinted.
 */
async function plan<S extends AnyObject>(
  spec: ToolSpec<S>,
  ctx: ToolContext,
  client: WooCommerceClient,
  args: z.infer<S>,
): Promise<Plan> {
  const reads: RecordedRead[] = [];
  const planner = client.planning({ fresh: true, onRead: (read) => reads.push(read) });
  try {
    const result = await spec.run({ ...ctx, client: planner }, args);
    return { write: null, result, state: captureState(reads, null) };
  } catch (error) {
    if (!(error instanceof PlannedWrite)) throw error;
    return { write: error.request, result: null, state: captureState(reads, error.request) };
  }
}

/** The preconditions block of a preview: what the write was computed from. */
function showState(state: PreviewState, redact: boolean): Record<string, unknown> {
  const records = redact ? redactPersonalData(state.records) : state.records;
  return {
    stateId: state.stateId,
    recordCount: state.recordCount,
    records,
    ...(state.truncated ? { truncated: true } : {}),
    note: 'A confirm with this previewId is refused with stale_preview if these records change before it is applied.',
  };
}

const APPROVAL_RESULTS: Record<ApprovalError['code'], AuditApproval['result']> = {
  approval_required: 'missing',
  approval_invalid: 'invalid',
  approval_expired: 'expired',
  approval_mismatch: 'mismatch',
  approval_replayed: 'replayed',
};

/** What a preview's audit entry keeps of its preconditions, so an approver can review it later. */
function auditState(state: PreviewState, redact: boolean): NonNullable<AuditEntry['preconditions']> {
  return {
    stateId: state.stateId,
    recordCount: state.recordCount,
    records: redact ? (redactPersonalData(state.records) as PreviewState['records']) : state.records,
    ...(state.truncated ? { truncated: true } : {}),
  };
}

/** Webhook secrets come from config and must never be echoed into a preview. */
export function hideSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hideSecrets);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        key === 'secret' && typeof child === 'string' ? '[configured secret]' : hideSecrets(child),
      ]),
    );
  }
  return value;
}
