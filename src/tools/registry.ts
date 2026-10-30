import type { AuthInfo, McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { AuditEntry, AuditOutcome } from '../audit.js';
import { SCOPES } from '../config.js';
import { withSpan } from '../telemetry.js';
import { ForbiddenError, PlannedWrite, ReadOnlyModeError } from '../woocommerce/errors.js';
import { resolveStore, type Runtime, type ToolContext } from './context.js';
import { jsonResult, serializeError, type ToolResult } from './result.js';

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
  'Write tool: refused while the store is read-only. Pass dryRun: true to preview the request. When confirmation is required (the default), call once to get a preview, then again with confirm: true to apply it.';

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
}

export function defineTool<S extends AnyObject>(server: McpServer, runtime: Runtime, spec: ToolSpec<S>): void {
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
  const { store: storeId, dryRun, confirm, ...rest } = input;
  const args = rest as z.infer<S>;
  return withSpan(
    `tool ${spec.name}`,
    { 'mcp.tool.name': spec.name, 'woocommerce.store': storeId ?? runtime.defaultStore, 'mcp.tool.write': spec.write },
    async (span) => {
      let storeLabel = storeId ?? runtime.defaultStore;
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
          ...extra,
        });
      };

      try {
        const handle = resolveStore(runtime, storeId);
        storeLabel = handle.config.id;
        const ctx: ToolContext = {
          client: handle.client,
          readOnly: handle.config.readOnly,
          defaultPerPage: runtime.defaultPerPage,
        };
        if (!spec.write) return jsonResult(await spec.run(ctx, args));

        if (runtime.scopesEnforced && authInfo && !authInfo.scopes.includes(SCOPES.write)) {
          throw new ForbiddenError(`Refused to run ${spec.name}: the access token lacks the ${SCOPES.write} scope.`);
        }
        if (handle.config.readOnly) throw new ReadOnlyModeError(spec.name, handle.config.id);

        const preview = dryRun === true || (runtime.requireConfirmation && confirm !== true);
        if (!preview) {
          const result = await spec.run(ctx, args);
          await audit('applied');
          return jsonResult(result);
        }

        try {
          const result = await spec.run({ ...ctx, client: handle.client.planning() }, args);
          // The tool finished without needing a write, for example an empty change set.
          await audit(dryRun === true ? 'dry_run' : 'confirmation_required');
          return jsonResult({ status: 'no_change', store: handle.config.id, result });
        } catch (error) {
          if (!(error instanceof PlannedWrite)) throw error;
          const request = { method: error.request.method, path: error.request.path };
          if (dryRun === true) {
            await audit('dry_run', { request });
            return jsonResult({
              status: 'dry_run',
              store: handle.config.id,
              message: 'Nothing was sent to the store. This is the request the tool would make.',
              request: error.request,
            });
          }
          await audit('confirmation_required', { request });
          return jsonResult({
            status: 'confirmation_required',
            store: handle.config.id,
            message:
              'The change was NOT applied. Review the request below with the user, then call this tool again with the same arguments and confirm: true.',
            request: error.request,
          });
        }
      } catch (error) {
        const payload = serializeError(error);
        const refused = error instanceof ReadOnlyModeError || error instanceof ForbiddenError;
        await audit(refused ? 'refused' : 'failed', {
          error: { code: payload.error.code, message: payload.error.message },
        });
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
    },
  );
}
