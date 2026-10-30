import { context, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

import { VERSION } from './version.js';

const TRACER_NAME = 'woocommerce-mcp';

/**
 * Runs `fn` inside an active span. Without a registered tracer provider the
 * OpenTelemetry API is a no-op, so this costs almost nothing when tracing is off.
 */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME, VERSION);
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : undefined });
      throw error;
    } finally {
      span.end();
    }
  });
}

export interface TelemetryHandle {
  shutdown: () => Promise<void>;
}

interface SdkTraceBase {
  BasicTracerProvider: new (options: { resource?: unknown; spanProcessors?: unknown[] }) => {
    shutdown: () => Promise<void>;
  };
  BatchSpanProcessor: new (exporter: unknown) => unknown;
}

interface OtlpExporterModule {
  OTLPTraceExporter: new (options?: Record<string, unknown>) => unknown;
}

interface ContextModule {
  AsyncLocalStorageContextManager: new () => { enable: () => unknown };
}

interface ResourcesModule {
  resourceFromAttributes: (attributes: Record<string, string>) => unknown;
}

/**
 * Registers an OTLP/HTTP trace exporter. The SDK packages are optional and
 * loaded on demand, so the default install stays small. The exporter reads the
 * standard OTEL_EXPORTER_OTLP_* environment variables.
 */
export async function startTelemetry(
  load: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<TelemetryHandle> {
  let sdk: SdkTraceBase;
  let exporterModule: OtlpExporterModule;
  let resources: ResourcesModule | undefined;
  try {
    sdk = (await load('@opentelemetry/sdk-trace-base')) as SdkTraceBase;
    exporterModule = (await load('@opentelemetry/exporter-trace-otlp-http')) as OtlpExporterModule;
  } catch {
    throw new Error(
      'Tracing is enabled but the OpenTelemetry SDK is not installed. Run: npm install @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources',
    );
  }
  try {
    resources = (await load('@opentelemetry/resources')) as ResourcesModule;
  } catch {
    resources = undefined;
  }
  try {
    const contextModule = (await load('@opentelemetry/context-async-hooks')) as ContextModule;
    const manager = new contextModule.AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(manager as Parameters<typeof context.setGlobalContextManager>[0]);
  } catch {
    // Without a context manager spans are still exported, only without parent links.
  }
  const exporter = new exporterModule.OTLPTraceExporter();
  const provider = new sdk.BasicTracerProvider({
    ...(resources
      ? {
          resource: resources.resourceFromAttributes({
            'service.name': process.env.OTEL_SERVICE_NAME ?? 'woocommerce-mcp',
            'service.version': VERSION,
          }),
        }
      : {}),
    spanProcessors: [new sdk.BatchSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider as unknown as Parameters<typeof trace.setGlobalTracerProvider>[0]);
  return {
    shutdown: async () => {
      await provider.shutdown();
    },
  };
}
