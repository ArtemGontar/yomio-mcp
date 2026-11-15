import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export const CALLBACK_HOST = '127.0.0.1';
export const CALLBACK_PATH = '/oauth/callback';
export const LEGACY_CALLBACK_PORT = 43821;
export const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

const PAGE_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  'Content-Type': 'text/html; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function equalSecrets(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function callbackPage(message) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Yomio connection</title><body><p>${message}</p><p>You can close this tab and return to your AI client.</p></body></html>`;
}

export function launchBrowser(url) {
  /** @type {[string, string[]]} */
  const command = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(undefined);
    });
  });
}

/** Ask the OS for a free loopback port. Returns the port number. */
export function findFreePort(host = CALLBACK_HOST) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Port for this run: YOMIO_MCP_CALLBACK_PORT if set, else a free port, else the legacy fixed port. */
export async function chooseCallbackPort(env = process.env) {
  const pinned = Number.parseInt(env['YOMIO_MCP_CALLBACK_PORT'] ?? '', 10);
  if (Number.isInteger(pinned) && pinned > 0 && pinned < 65536) return pinned;
  try {
    return await findFreePort();
  } catch {
    return LEGACY_CALLBACK_PORT;
  }
}

/**
 * Validate an OAuth redirect query. Returns `{ kind: 'code', code }`, `{ kind: 'denied' }`,
 * or `{ kind: 'invalid' }` when the state or issuer do not match this sign-in.
 */
export function checkAuthorizationResponse(params, expectedState, expectedIssuer) {
  const states = params.getAll('state');
  const issuers = params.getAll('iss');
  if (states.length !== 1 || issuers.length !== 1
    || !equalSecrets(states[0], expectedState) || issuers[0] !== expectedIssuer) {
    return { kind: 'invalid' };
  }
  const errors = params.getAll('error');
  if (errors.length === 1 && errors[0]) return { kind: 'denied' };
  const codes = params.getAll('code');
  if (codes.length !== 1 || !codes[0]) return { kind: 'invalid' };
  return { kind: 'code', code: codes[0] };
}

/**
 * Listen for the OAuth redirect on loopback, open the sign-in page, and resolve
 * with the authorization code. `cancel()` ends the wait with an error.
 */
export function waitForAuthorizationCode({
  authorizationUrl,
  expectedState,
  expectedIssuer,
  port,
  host = CALLBACK_HOST,
  timeoutMs = CALLBACK_TIMEOUT_MS,
  openBrowser = launchBrowser,
  log = (message) => { process.stderr.write(`${message}\n`); },
}) {
  let cancel = () => {};
  let submit = (_pasted) => ({ ok: false, message: 'No sign-in is waiting.' });
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const callbackUrl = `http://${host}:${port}${CALLBACK_PATH}`;
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url || '/', callbackUrl);
      const remote = request.socket.remoteAddress;
      const isLoopback = remote === '127.0.0.1' || remote === '::ffff:127.0.0.1';
      if (request.method !== 'GET' || requestUrl.pathname !== CALLBACK_PATH
        || request.headers.host !== `${host}:${port}` || !isLoopback) {
        response.writeHead(404).end();
        return;
      }

      const result = checkAuthorizationResponse(requestUrl.searchParams, expectedState, expectedIssuer);
      if (result.kind === 'invalid') {
        response.writeHead(400, { 'Cache-Control': 'no-store' }).end('Invalid authorization response.');
      } else if (result.kind === 'denied') {
        response.writeHead(200, PAGE_HEADERS).end(callbackPage('Yomio access was not granted.'));
        finish(new Error('Yomio access was not granted.'));
      } else {
        response.writeHead(200, PAGE_HEADERS).end(callbackPage('Yomio access was granted.'));
        finish(undefined, result.code);
      }
    });

    const timeout = setTimeout(() => finish(new Error('Yomio sign-in timed out.')), timeoutMs);
    cancel = () => finish(new Error('Yomio sign-in was cancelled.'));
    submit = (pasted) => {
      let params;
      try {
        params = new URL(String(pasted).trim()).searchParams;
      } catch {
        return { ok: false, message: 'That is not a full web address. Copy the whole address from the browser address bar.' };
      }
      const result = checkAuthorizationResponse(params, expectedState, expectedIssuer);
      if (result.kind === 'invalid') {
        return { ok: false, message: 'That address does not belong to the sign-in that is waiting. Start the request again and use the new link.' };
      }
      if (result.kind === 'denied') {
        finish(new Error('Yomio access was not granted.'));
        return { ok: false, message: 'Yomio access was not granted.' };
      }
      finish(undefined, result.code);
      return { ok: true, message: 'Sign-in accepted. Repeat the earlier request.' };
    };

    function finish(error, code) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close(() => {});
      if (error) reject(error);
      else resolve(code);
    }

    server.once('error', () => finish(new Error(`Could not open the local OAuth callback on port ${port}.`)));
    server.listen(port, host, () => {
      // The URL is always printed so a user without a local browser can open it elsewhere.
      log(`Sign in to Yomio: open this URL in a browser on this computer:\n${authorizationUrl}`);
      if (process.env['YOMIO_MCP_NO_BROWSER']) return;
      openBrowser(authorizationUrl.toString()).catch(() => {
        log('Could not open a browser automatically. Open the URL above to continue.');
      });
    });
  });
  return { promise, cancel: () => cancel(), submit: (pasted) => submit(pasted) };
}
