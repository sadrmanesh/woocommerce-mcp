import type { AuthInfo, McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { AuditEntry, AuditOutcome } from '../audit.js';
import { SCOPES, toolAllowed } from '../config.js';
import { redactPersonalData } from '../redact.js';
import { withSpan } from '../telemetry.js';
import {
  ForbiddenError,
  PlannedWrite,
  PreviewMismatchError,
  ReadOnlyModeError,
  ToolDisabledError,
} from '../woocommerce/errors.js';
import { resolveStore, type Runtime, type ToolContext } from './context.js';
import { previewIdFor } from './preview-id.js';
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
  'Write tool: refused while the store is read-only. Pass dryRun: true to preview the request. When confirmation is required (the default), call once to get a preview, then again with confirm: true and the returned previewId to apply it.';

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
    .describe('previewId from the preview of this change. The call is refused if the arguments differ from the preview'),
};

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
}

export function defineTool<S extends AnyObject>(server: McpServer, runtime: Runtime, spec: ToolSpec<S>): void {
  if (!toolAllowed(runtime.tools, spec.name)) return;
  // Hide tools that no configured store allows.
  if (!runtime.stores.some((store) => toolAllowed(store.config.tools, spec.name))) return;
  const schema = spec.write
    ? spec.input.extend({ store: storeField, ...writeFields })
    : spec.input.extend({ store: storeField });
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.write ? `${spec.description} ${WRITE_NOTE}` : spec.description,
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
  const { store: storeId, dryRun, confirm, previewId: suppliedPreviewId, ...rest } = input;
  const args = rest as z.infer<S>;
  return withSpan(
    `tool ${spec.name}`,
    { 'mcp.tool.name': spec.name, 'woocommerce.store': storeId ?? runtime.defaultStore, 'mcp.tool.write': spec.write },
    async (span) => {
      let storeLabel = storeId ?? runtime.defaultStore;
      // Set once the store is known: links this call to its preview in the audit log.
      let link: Pick<AuditEntry, 'previewId' | 'previewMatch'> = {};
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
        const previewId = previewIdFor(spec.name, handle.config.id, args as Record<string, unknown>);
        const preview = dryRun === true || (runtime.requireConfirmation && confirm !== true);
        link =
          !preview && suppliedPreviewId !== undefined
            ? { previewId: suppliedPreviewId, previewMatch: suppliedPreviewId === previewId }
            : { previewId };
        if (handle.config.readOnly) throw new ReadOnlyModeError(spec.name, handle.config.id);

        if (!preview) {
          if (link.previewMatch === false) {
            throw new PreviewMismatchError(spec.name, handle.config.id, suppliedPreviewId ?? '');
          }
          const result = await spec.run(ctx, args);
          await audit('applied');
          return jsonResult(result);
        }

        try {
          const result = await spec.run({ ...ctx, client: handle.client.planning() }, args);
          // The tool finished without needing a write, for example an empty change set.
          await audit(dryRun === true ? 'dry_run' : 'confirmation_required');
          return jsonResult({ status: 'no_change', store: handle.config.id, previewId, result });
        } catch (error) {
          if (!(error instanceof PlannedWrite)) throw error;
          // Previews echo the caller's own arguments, so they are not masked.
          const request = { method: error.request.method, path: error.request.path };
          const planned = { ...error.request, body: hideSecrets(error.request.body) };
          if (dryRun === true) {
            await audit('dry_run', { request });
            return plainJsonResult({
              status: 'dry_run',
              store: handle.config.id,
              previewId,
              message: 'Nothing was sent to the store. This is the request the tool would make.',
              request: planned,
            });
          }
          await audit('confirmation_required', { request });
          return plainJsonResult({
            status: 'confirmation_required',
            store: handle.config.id,
            previewId,
            message:
              'The change was NOT applied. Review the request below with the user, then call this tool again with the same arguments, confirm: true, and this previewId.',
            request: planned,
          });
        }
      } catch (error) {
        const payload = serializeError(error);
        const refused =
          error instanceof ReadOnlyModeError ||
          error instanceof ForbiddenError ||
          error instanceof ToolDisabledError ||
          error instanceof PreviewMismatchError;
        await audit(refused ? 'refused' : 'failed', {
          error: { code: payload.error.code, message: payload.error.message },
        });
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
    },
  );
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
