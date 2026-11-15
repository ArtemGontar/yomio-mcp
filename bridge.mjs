import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CredentialStoreError } from './credentialStore.mjs';
import {
  SessionRefreshedElsewhereError,
  createSerialExecutor,
  executeWithAuthorizationRecovery,
  withSoftTimeout,
} from './authRecovery.mjs';

export const SIGN_IN_PENDING_MS = 45_000;
export const SIGN_IN_PENDING_MESSAGE = 'Yomio sign-in is waiting in your browser. Finish signing in, then repeat the request. If the browser is on another computer, copy the full address it ends on and pass it to complete_sign_in.';

const SAFE_MESSAGES = new Set([
  'Yomio access was not granted.',
  'Yomio sign-in timed out.',
  'Yomio sign-in was cancelled.',
  SIGN_IN_PENDING_MESSAGE,
]);

/** Error text that is safe to show in the AI client. */
export function publicMessage(error) {
  const message = error instanceof Error ? error.message : '';
  if (error instanceof CredentialStoreError || SAFE_MESSAGES.has(message)
    || /^Could not open the local OAuth callback on port \d+\.$/.test(message)) {
    return message;
  }
  return 'Could not connect to Yomio MCP. Check your network and sign-in status.';
}

/**
 * Forwards MCP requests to the hosted server. Signs in on the first call that
 * needs it, and runs calls one at a time so a sign-in is never started twice.
 */
export function createBridge({
  endpoint,
  authProvider,
  version,
  log = (message) => { process.stderr.write(`${message}\n`); },
  debug = false,
  signInPendingMs = SIGN_IN_PENDING_MS,
}) {
  let remote;
  let connecting;
  const executeRemote = createSerialExecutor();

  const createRemote = () => {
    const client = new Client({ name: 'yomio-mcp-stdio', version }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(endpoint, { authProvider });
    client.onerror = (error) => log(debug && error instanceof Error
      ? `Yomio MCP connection error: ${error.message}`
      : 'Yomio MCP connection error.');
    return { client, transport };
  };

  const connectFresh = async () => {
    const replacement = createRemote();
    try {
      await replacement.client.connect(replacement.transport);
      return replacement;
    } catch (error) {
      await Promise.allSettled([replacement.client.close()]);
      throw error;
    }
  };

  async function connectRemote() {
    let candidate = createRemote();
    try {
      await candidate.client.connect(candidate.transport);
      return candidate;
    } catch (error) {
      const authorizationCode = authProvider.takeAuthorizationCode();
      if (error instanceof SessionRefreshedElsewhereError) {
        await Promise.allSettled([candidate.client.close()]);
        return connectFresh();
      }
      if (!authorizationCode) {
        await Promise.allSettled([candidate.client.close()]);
        throw error;
      }

      await candidate.transport.finishAuth(authorizationCode);
      await Promise.allSettled([candidate.client.close()]);
      candidate = createRemote();
      await candidate.client.connect(candidate.transport);
      return candidate;
    }
  }

  const connectOnce = () => {
    if (!connecting) {
      connecting = connectRemote()
        .then((connected) => {
          remote = connected;
          return connected;
        })
        .catch((error) => {
          connecting = undefined;
          if (debug) log(`Yomio MCP connect failed: ${error instanceof Error ? error.message : String(error)}`);
          throw new Error(publicMessage(error));
        });
    }
    return connecting;
  };

  const run = (operation) => {
    const work = executeRemote(async () => {
      const connected = await connectOnce();
      const output = await executeWithAuthorizationRecovery(operation, connected, authProvider, connectFresh);
      remote = output.connection;
      connecting = Promise.resolve(output.connection);
      return output.result;
    });
    // A sign-in can outlast the AI client's request timeout; answer early and let it finish.
    return withSoftTimeout(
      work,
      signInPendingMs,
      () => (authProvider.signingIn ? new Error(SIGN_IN_PENDING_MESSAGE) : undefined),
    ).catch((error) => {
      if (error instanceof Error && SAFE_MESSAGES.has(error.message)) throw error;
      if (debug) log(`Yomio MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    });
  };

  return {
    listTools: (params) => run((client) => client.listTools(params)),
    callTool: (params) => run((client) => client.callTool(params)),
    listPrompts: (params) => run((client) => client.listPrompts(params)),
    getPrompt: (params) => run((client) => client.getPrompt(params)),
    listResources: (params) => run((client) => client.listResources(params)),
    readResource: (params) => run((client) => client.readResource(params)),
    async close() {
      await Promise.allSettled([remote?.client.close()]);
    },
  };
}
