#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Entry } from '@napi-rs/keyring';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createSerialExecutor,
  executeWithAuthorizationRecovery,
  tokensForEndpoint,
} from './authRecovery.mjs';

const VERSION = '1.0.1';
const DEFAULT_ENDPOINT = 'https://mcp.yomio.app/mcp';
const CLIENT_METADATA_URL = 'https://yomio.app/.well-known/yomio-mcp-client.json';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 43821;
const CALLBACK_PATH = '/oauth/callback';
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const KEYRING_ENTRY = new Entry('app.yomio.mcp', 'default');
let cancelAuthorizationFlow;

function validateEndpoint(endpoint) {
  if (endpoint.protocol !== 'https:'
    || !['mcp.yomio.app', 'mcp-dev.yomio.app'].includes(endpoint.hostname)
    || endpoint.port
    || endpoint.pathname !== '/mcp'
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash) {
    throw new Error('YOMIO_MCP_URL must be a Yomio HTTPS MCP endpoint.');
  }
  return endpoint;
}

function getEndpoint() {
  return validateEndpoint(new URL(process.env['YOMIO_MCP_URL'] || DEFAULT_ENDPOINT));
}

function equalSecrets(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function readSavedSession() {
  try {
    const saved = KEYRING_ENTRY.getPassword();
    return saved ? JSON.parse(saved) : undefined;
  } catch (error) {
    if (/no entry|not found/i.test(error instanceof Error ? error.message : String(error))) {
      return undefined;
    }
    throw new Error('Could not read Yomio credentials from the OS keychain.');
  }
}

function readSavedTokens(endpoint) {
  return tokensForEndpoint(readSavedSession(), endpoint);
}

function writeSavedTokens(tokens, endpoint) {
  try {
    KEYRING_ENTRY.setPassword(JSON.stringify({ endpoint: endpoint.toString(), tokens }));
  } catch {
    throw new Error('Could not save Yomio credentials to the OS keychain.');
  }
}

function deleteSavedTokens() {
  try {
    KEYRING_ENTRY.deletePassword();
  } catch (error) {
    if (!/no entry|not found/i.test(error instanceof Error ? error.message : String(error))) {
      throw new Error('Could not remove Yomio credentials from the OS keychain.');
    }
  }
}

function launchBrowser(url) {
  const commands = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(commands[0], commands[1], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function callbackPage(message) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Yomio connection</title><body><p>${message}</p><p>You can close this tab and return to your AI client.</p></body></html>`;
}

function waitForAuthorizationCode(authorizationUrl, expectedState, expectedIssuer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const callbackUrl = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url || '/', callbackUrl);
      const isLoopback = request.socket.remoteAddress === '127.0.0.1'
        || request.socket.remoteAddress === '::ffff:127.0.0.1';
      if (request.method !== 'GET' || requestUrl.pathname !== CALLBACK_PATH
        || request.headers.host !== `${CALLBACK_HOST}:${CALLBACK_PORT}` || !isLoopback) {
        response.writeHead(404).end();
        return;
      }

      const states = requestUrl.searchParams.getAll('state');
      const issuers = requestUrl.searchParams.getAll('iss');
      if (states.length !== 1 || issuers.length !== 1
        || !equalSecrets(states[0], expectedState) || issuers[0] !== expectedIssuer) {
        response.writeHead(400, { 'Cache-Control': 'no-store' }).end('Invalid authorization response.');
        return;
      }

      const errors = requestUrl.searchParams.getAll('error');
      const codes = requestUrl.searchParams.getAll('code');
      if (errors.length === 1 && errors[0]) {
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
          'Content-Type': 'text/html; charset=utf-8',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
        }).end(callbackPage('Yomio access was not granted.'));
        finish(new Error('Yomio access was not granted.'));
        return;
      }
      if (codes.length !== 1 || !codes[0]) {
        response.writeHead(400, { 'Cache-Control': 'no-store' }).end('Invalid authorization response.');
        return;
      }

      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        'Content-Type': 'text/html; charset=utf-8',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      }).end(callbackPage('Yomio access was granted.'));
      finish(undefined, codes[0]);
    });

    const timeout = setTimeout(() => finish(new Error('Yomio sign-in timed out.')), CALLBACK_TIMEOUT_MS);
    cancelAuthorizationFlow = () => finish(new Error('Yomio sign-in was cancelled.'));

    function finish(error, code) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cancelAuthorizationFlow = undefined;
      server.close(() => {});
      if (error) reject(error);
      else resolve(code);
    }

    server.once('error', () => finish(new Error(`Could not open the local OAuth callback on port ${CALLBACK_PORT}.`)));
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      launchBrowser(authorizationUrl.toString()).then(() => {
        process.stderr.write('Opening Yomio sign-in in your browser.\n');
      }).catch(() => finish(new Error('Could not open your browser for Yomio sign-in.')));
    });
  });
}

class YomioOAuthProvider {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.callbackState = undefined;
    this.codeVerifierValue = undefined;
    this.authorizationCode = undefined;
  }

  get redirectUrl() {
    return `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;
  }

  get clientMetadataUrl() {
    return CLIENT_METADATA_URL;
  }

  get clientMetadata() {
    return {
      client_name: 'Yomio MCP',
      redirect_uris: [this.redirectUrl],
      response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp:read',
    };
  }

  state() {
    this.callbackState = randomBytes(32).toString('base64url');
    return this.callbackState;
  }

  clientInformation() {
    return { client_id: CLIENT_METADATA_URL };
  }

  tokens() {
    return readSavedTokens(this.endpoint);
  }

  saveTokens(tokens) {
    writeSavedTokens(tokens, this.endpoint);
    this.codeVerifierValue = undefined;
    this.callbackState = undefined;
    this.authorizationCode = undefined;
  }

  saveCodeVerifier(codeVerifier) {
    this.codeVerifierValue = codeVerifier;
  }

  codeVerifier() {
    if (!this.codeVerifierValue) throw new Error('OAuth PKCE verifier is missing.');
    return this.codeVerifierValue;
  }

  async redirectToAuthorization(authorizationUrl) {
    const url = new URL(authorizationUrl);
    if (url.protocol !== 'https:' || url.origin !== this.endpoint.origin || url.pathname !== '/oauth/authorize') {
      throw new Error('Yomio returned an unexpected authorization URL.');
    }
    if (!this.callbackState) throw new Error('OAuth state is missing.');
    this.authorizationCode = await waitForAuthorizationCode(url, this.callbackState, this.endpoint.origin);
  }

  takeAuthorizationCode() {
    const code = this.authorizationCode;
    this.authorizationCode = undefined;
    return code;
  }

  invalidateCredentials(scope) {
    if (scope === 'all' || scope === 'tokens') deleteSavedTokens();
    if (scope === 'all' || scope === 'verifier') this.codeVerifierValue = undefined;
    if (scope === 'all' || scope === 'client') this.authorizationCode = undefined;
  }
}

function createRemoteClient(endpoint, authProvider) {
  const client = new Client(
    { name: 'yomio-mcp-stdio', version: VERSION },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(endpoint, { authProvider });
  client.onerror = () => process.stderr.write('Yomio MCP connection error.\n');
  return { client, transport };
}

async function connectRemote(endpoint, authProvider) {
  let remote = createRemoteClient(endpoint, authProvider);
  try {
    await remote.client.connect(remote.transport);
    return remote;
  } catch (error) {
    const authorizationCode = authProvider.takeAuthorizationCode();
    if (!authorizationCode) {
      await Promise.allSettled([remote.client.close()]);
      throw error;
    }

    await remote.transport.finishAuth(authorizationCode);
    await Promise.allSettled([remote.client.close()]);
    remote = createRemoteClient(endpoint, authProvider);
    await remote.client.connect(remote.transport);
    return remote;
  }
}

async function main() {
  if (process.argv.includes('--logout-local-only')) {
    deleteSavedTokens();
    process.stderr.write('Yomio credentials removed from the OS keychain. The remote refresh token was not revoked.\n');
    return;
  }
  if (process.argv.includes('--logout')) {
    const session = readSavedSession();
    const refreshToken = session?.tokens?.refresh_token;
    if (refreshToken) {
      const endpoint = validateEndpoint(new URL(session.endpoint));
      const response = await fetch(new URL('/oauth/revoke', endpoint.origin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken, client_id: CLIENT_METADATA_URL }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Could not revoke the Yomio session. Retry when the server is available.');
    }
    deleteSavedTokens();
    process.stderr.write('Yomio session revoked and removed from the OS keychain.\n');
    return;
  }

  const endpoint = getEndpoint();
  const authProvider = new YomioOAuthProvider(endpoint);
  let remote;
  let connecting;
  const executeRemote = createSerialExecutor();
  const connectOnce = () => {
    if (!connecting) {
      connecting = connectRemote(endpoint, authProvider)
        .then((connected) => {
          remote = connected;
          return connected;
        })
        .catch((error) => {
          connecting = undefined;
          const message = error instanceof Error ? error.message : '';
          const safeMessages = new Set([
            'Could not open your browser for Yomio sign-in.',
            `Could not open the local OAuth callback on port ${CALLBACK_PORT}.`,
            'Yomio access was not granted.',
            'Yomio sign-in timed out.',
            'Yomio sign-in was cancelled.',
            'Could not read Yomio credentials from the OS keychain.',
            'Could not save Yomio credentials to the OS keychain.',
          ]);
          if (safeMessages.has(message)) throw new Error(message);
          throw new Error('Could not connect to Yomio MCP. Check your network and sign-in status.');
        });
    }
    return connecting;
  };

  const withRemoteOperation = (operation) => executeRemote(async () => {
    const connected = await connectOnce();
    const output = await executeWithAuthorizationRecovery(operation, connected, authProvider, async () => {
      const replacement = createRemoteClient(endpoint, authProvider);
      try {
        await replacement.client.connect(replacement.transport);
        return replacement;
      } catch (reconnectError) {
        await Promise.allSettled([replacement.client.close()]);
        throw reconnectError;
      }
    });
    remote = output.connection;
    connecting = Promise.resolve(output.connection);
    return output.result;
  });

  const localServer = new Server(
    { name: 'yomio-mcp-stdio', version: VERSION },
    { capabilities: { tools: {} } },
  );
  const localTransport = new StdioServerTransport();
  localServer.setRequestHandler(ListToolsRequestSchema, async (request) => {
    return withRemoteOperation((client) => client.listTools(request.params));
  });
  localServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    return withRemoteOperation((client) => client.callTool(request.params));
  });
  await localServer.connect(localTransport);

  const close = async () => {
    cancelAuthorizationFlow?.();
    await Promise.allSettled([remote?.client.close(), localServer.close()]);
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Yomio MCP could not start.'}\n`);
  process.exitCode = 1;
});
