#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createBridge } from './bridge.mjs';
import { chooseCallbackPort, waitForAuthorizationCode } from './callbackServer.mjs';
import { createCredentialStore } from './credentialStore.mjs';
import { CLIENT_METADATA_URL, getEndpoint, validateEndpoint } from './endpoint.mjs';
import { YomioOAuthProvider } from './oauthProvider.mjs';
import { tokensForEndpoint } from './authRecovery.mjs';

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const COMPLETE_SIGN_IN_TOOL = {
  name: 'complete_sign_in',
  title: 'Complete Yomio sign-in',
  description: 'Finish Yomio sign-in when the sign-in page was opened on another computer. Pass the full address the browser ends on after approval. That page may show a connection error; the address is still correct.',
  inputSchema: {
    type: 'object',
    properties: { address: { type: 'string', description: 'Full address from the browser address bar, starting with http://127.0.0.1' } },
    required: ['address'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};
const FLAGS = new Set(['--help', '-h', '--version', '-v', '--status', '--logout', '--logout-local-only', '--debug']);

const HELP = `yomio-mcp-stdio ${VERSION}
Connect an MCP client to Yomio over stdio.

Usage: yomio-mcp-stdio [option]

  (no option)           Start the connector. Sign-in starts on the first tool call that needs it.
  --status              Show the endpoint and whether a saved session exists.
  --logout              Revoke the session at Yomio and remove it from this computer.
  --logout-local-only   Remove the saved session from this computer only.
  --debug               Print error details to stderr. Never prints tokens.
  --version, --help

Environment:
  YOMIO_MCP_URL                 Use https://mcp-dev.yomio.app/mcp for development.
  YOMIO_MCP_CREDENTIAL_STORE    Set to "file" to keep the session in ~/.config/yomio-mcp/session.json.
  YOMIO_MCP_CREDENTIAL_FILE     Path for the credential file.
  YOMIO_MCP_CALLBACK_PORT       Fixed local port for the sign-in callback.
  YOMIO_MCP_NO_BROWSER          Print the sign-in URL and do not open a browser.
`;

function log(message) {
  process.stderr.write(`${message}\n`);
}

async function logout(store, { remote }) {
  if (remote) {
    const session = store.read();
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
    store.delete();
    log(`Yomio session revoked and removed from the ${store.name}.`);
    return;
  }
  store.delete();
  log(`Yomio credentials removed from the ${store.name}. The remote refresh token was not revoked.`);
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.find((arg) => !FLAGS.has(arg));
  if (unknown) {
    log(`Unknown option: ${unknown}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (args.includes('--help') || args.includes('-h')) return void process.stdout.write(HELP);
  if (args.includes('--version') || args.includes('-v')) return void process.stdout.write(`${VERSION}\n`);

  const store = createCredentialStore();
  if (args.includes('--logout-local-only')) return logout(store, { remote: false });
  if (args.includes('--logout')) return logout(store, { remote: true });

  const endpoint = getEndpoint();
  if (args.includes('--status')) {
    const signedIn = Boolean(tokensForEndpoint(store.read(), endpoint));
    log(`Endpoint: ${endpoint}\nStore: ${store.name}\nSigned in: ${signedIn ? 'yes' : 'no'}`);
    return;
  }

  const debug = args.includes('--debug') || Boolean(process.env['YOMIO_MCP_DEBUG']);
  let cancelAuthorization;
  let submitAuthorization;
  const authProvider = new YomioOAuthProvider({
    endpoint,
    store,
    port: await chooseCallbackPort(),
    authorize: ({ url, state, issuer, port }) => {
      const flow = waitForAuthorizationCode({ authorizationUrl: url, expectedState: state, expectedIssuer: issuer, port, log });
      cancelAuthorization = flow.cancel;
      submitAuthorization = flow.submit;
      return flow.promise.finally(() => { cancelAuthorization = undefined; submitAuthorization = undefined; });
    },
  });
  const bridge = createBridge({ endpoint, authProvider, version: VERSION, log, debug });

  const localServer = new Server(
    { name: 'yomio-mcp-stdio', version: VERSION },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  );
  localServer.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const remote = await bridge.listTools(request.params);
    return { ...remote, tools: [...remote.tools, COMPLETE_SIGN_IN_TOOL] };
  });
  localServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== COMPLETE_SIGN_IN_TOOL.name) return bridge.callTool(request.params);
    const address = request.params.arguments?.['address'];
    const result = typeof address === 'string' && submitAuthorization
      ? submitAuthorization(address)
      : { ok: false, message: 'No sign-in is waiting. Repeat a Yomio request to start one.' };
    return { content: [{ type: 'text', text: result.message }], ...(result.ok ? {} : { isError: true }) };
  });
  localServer.setRequestHandler(ListPromptsRequestSchema, (request) => bridge.listPrompts(request.params));
  localServer.setRequestHandler(GetPromptRequestSchema, (request) => bridge.getPrompt(request.params));
  localServer.setRequestHandler(ListResourcesRequestSchema, (request) => bridge.listResources(request.params));
  localServer.setRequestHandler(ReadResourceRequestSchema, (request) => bridge.readResource(request.params));

  let closing;
  const shutdown = () => {
    closing ??= (async () => {
      cancelAuthorization?.();
      await Promise.allSettled([bridge.close(), localServer.close()]);
      process.exit(0);
    })();
    return closing;
  };
  localServer.onclose = () => void shutdown();
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  // The AI client closing our stdin means it exited; do not linger.
  process.stdin.once('end', () => void shutdown());
  process.stdin.once('close', () => void shutdown());

  await localServer.connect(new StdioServerTransport());
}

main().catch((error) => {
  log(error instanceof Error ? error.message : 'Yomio MCP could not start.');
  process.exitCode = 1;
});
