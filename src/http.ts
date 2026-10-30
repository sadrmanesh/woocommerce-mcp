import { createServer as createHttpServer, type Server } from 'node:http';

import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';

import { publicStoreLabel, type AppConfig } from './config.js';
import { installShutdown } from './shutdown.js';
import { VERSION } from './version.js';

export interface HttpServerOptions {
  signals?: boolean;
  quiet?: boolean;
}

export interface HttpServerHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startHttpServer(
  factory: () => McpServer,
  config: AppConfig,
  options: HttpServerOptions = {},
): Promise<HttpServerHandle> {
  const handler = createMcpHandler(factory);
  const nodeHandler = toNodeHandler(handler, {
    onerror: () => {
      console.error('woocommerce-mcp failed to handle an HTTP request');
    },
  });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = createHttpServer((request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    const pathname = requestPathname(request.url);
    if (pathname === null) {
      writeJson(response, 400, { error: 'Bad request' });
      return;
    }
    if (!isMcpPath(pathname, config.httpPath)) {
      writeJson(response, 404, { error: 'Not found' });
      return;
    }
    void nodeHandler(request, response).catch(() => {
      if (!response.headersSent) writeJson(response, 500, { error: 'Internal server error' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once('error', onError);
    server.listen(config.httpPort, config.httpHost, () => {
      server.off('error', onError);
      resolve();
    });
  });
  server.on('error', (error) => {
    console.error(`woocommerce-mcp HTTP server error: ${error.message}`);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('HTTP server did not bind a TCP port');
  }

  const url = `http://${config.httpHost}:${address.port}${config.httpPath}`;
  if (!options.quiet) {
    const mode = config.readOnly ? 'read-only' : 'writes enabled';
    console.error(
      `woocommerce-mcp ${VERSION} listening on ${url} (${mode}) for ${publicStoreLabel(config.url)}`,
    );
  }
  if (options.signals !== false) {
    installShutdown(async () => {
      await handler.close();
      await closeServer(server);
    });
  }

  return {
    url,
    port: address.port,
    close: async () => {
      await handler.close();
      await closeServer(server);
    },
  };
}

export function requestPathname(rawUrl: string | undefined): string | null {
  try {
    return new URL(rawUrl ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return null;
  }
}

export function isMcpPath(pathname: string, configuredPath: string): boolean {
  if (pathname === configuredPath) return true;
  return configuredPath !== '/' && pathname === `${configuredPath}/`;
}

function writeJson(response: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
