import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import {
  type AuthInfo,
  bearerAuthChallengeResponse,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  type McpServer,
  type OAuthTokenVerifier,
  verifyBearerToken,
} from '@modelcontextprotocol/server';

import { createTokenVerifier, type VerifierOptions } from './auth.js';
import { type AppConfig, SCOPES } from './config.js';
import { installShutdown } from './shutdown.js';
import { receiveWebhook, webhookStoreFromPath, type WebhookReceiverOptions } from './webhook-receiver.js';
import { VERSION } from './version.js';

export interface HttpServerOptions {
  signals?: boolean;
  quiet?: boolean;
  /** Overrides how bearer tokens are checked. Mainly for tests. */
  verifier?: OAuthTokenVerifier;
  verifierOptions?: VerifierOptions;
  /** Enables the WooCommerce webhook receiver. */
  webhooks?: WebhookReceiverOptions;
}

export interface HttpServerHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const WELL_KNOWN = '/.well-known/oauth-protected-resource';

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
  const validateHost =
    config.httpAllowedHosts.length > 0
      ? hostHeaderValidation(config.httpAllowedHosts)
      : LOOPBACK.has(config.httpHost)
        ? localhostHostValidation()
        : null;
  const validateOrigin =
    config.httpAllowedOrigins.length > 0 ? originValidation(config.httpAllowedOrigins) : localhostOriginValidation();

  const auth = config.httpAuth;
  const verifier = auth ? (options.verifier ?? createTokenVerifier(auth, options.verifierOptions)) : null;
  const scopesSupported = [SCOPES.read, SCOPES.write, ...(auth?.requiredScopes ?? [])].filter(
    (scope, index, all) => all.indexOf(scope) === index,
  );

  const resourceUrl = (request: IncomingMessage): URL => {
    if (auth?.resource) return new URL(auth.resource);
    const host = request.headers.host ?? `${config.httpHost}:${config.httpPort}`;
    return new URL(`http://${host}${config.httpPath}`);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (validateHost && !validateHost(request, response)) return;
    if (!validateOrigin(request, response)) return;
    const pathname = requestPathname(request.url);
    if (pathname === null) {
      writeJson(response, 400, { error: 'Bad request' });
      return;
    }
    if (pathname === '/healthz') {
      writeJson(response, 200, { status: 'ok', version: VERSION });
      return;
    }
    const webhookStore = options.webhooks ? webhookStoreFromPath(pathname, options.webhooks.path) : null;
    if (options.webhooks && webhookStore !== null) {
      const result = await receiveWebhook(request, webhookStore, options.webhooks);
      writeJson(response, result.status, result.body);
      return;
    }
    if (auth && isMetadataPath(pathname, config.httpPath)) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD' });
        response.end();
        return;
      }
      writeJson(response, 200, {
        resource: resourceUrl(request).href,
        ...(auth.issuer ? { authorization_servers: [auth.issuer] } : {}),
        scopes_supported: scopesSupported,
        bearer_methods_supported: ['header'],
        resource_name: 'WooCommerce MCP server',
      });
      return;
    }
    if (!isMcpPath(pathname, config.httpPath)) {
      writeJson(response, 404, { error: 'Not found' });
      return;
    }
    if (auth && verifier) {
      const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl(request));
      try {
        const info = await verifyBearerToken(request.headers.authorization, {
          verifier,
          requiredScopes: auth.requiredScopes,
          resourceMetadataUrl,
          ...(auth.resource ? { expectedResource: new URL(auth.resource) } : {}),
        });
        (request as IncomingMessage & { auth?: AuthInfo }).auth = info;
      } catch (error) {
        await sendWebResponse(
          response,
          bearerAuthChallengeResponse(error, { requiredScopes: auth.requiredScopes, resourceMetadataUrl }),
        );
        return;
      }
    }
    await nodeHandler(request, response);
  };

  const server = createHttpServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) writeJson(response, 500, { error: 'Internal server error' });
      else response.end();
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

  const displayHost = config.httpHost.includes(':') ? `[${config.httpHost}]` : config.httpHost;
  const url = `http://${displayHost}:${address.port}${config.httpPath}`;
  if (!options.quiet) {
    const writable = config.stores.filter((store) => !store.readOnly).length;
    const authMode = auth ? 'bearer auth' : 'no auth, loopback only';
    console.error(
      `woocommerce-mcp ${VERSION} listening on ${url} (${authMode}; ${config.stores.length} store(s), ${writable} writable)`,
    );
  }
  const close = async (): Promise<void> => {
    await handler.close();
    await closeServer(server);
  };
  if (options.signals !== false) installShutdown(close);

  return { url, port: address.port, close };
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

export function isMetadataPath(pathname: string, configuredPath: string): boolean {
  return pathname === WELL_KNOWN || pathname === `${WELL_KNOWN}${configuredPath === '/' ? '' : configuredPath}`;
}

async function sendWebResponse(response: ServerResponse, web: Response): Promise<void> {
  const headers: Record<string, string> = {};
  web.headers.forEach((value, key) => {
    headers[key] = value;
  });
  response.writeHead(web.status, headers);
  response.end(Buffer.from(await web.arrayBuffer()));
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
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
