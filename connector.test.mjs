import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SessionRefreshedElsewhereError, withSoftTimeout } from './authRecovery.mjs';
import { createBridge, publicMessage } from './bridge.mjs';
import { CALLBACK_PATH, chooseCallbackPort, findFreePort, waitForAuthorizationCode } from './callbackServer.mjs';
import {
  CredentialStoreError,
  createCredentialStore,
  createFileStore,
  createMemoryStore,
} from './credentialStore.mjs';
import { getEndpoint, validateEndpoint } from './endpoint.mjs';
import { YomioOAuthProvider } from './oauthProvider.mjs';

const ENDPOINT = new URL('https://mcp.yomio.app/mcp');

// ---- endpoint -------------------------------------------------------------

test('endpoint allows only the Yomio production and development MCP URLs', () => {
  assert.equal(getEndpoint({}).toString(), ENDPOINT.toString());
  assert.equal(getEndpoint({ YOMIO_MCP_URL: 'https://mcp-dev.yomio.app/mcp' }).hostname, 'mcp-dev.yomio.app');
  for (const bad of [
    'http://mcp.yomio.app/mcp', 'https://evil.example/mcp', 'https://mcp.yomio.app:8443/mcp',
    'https://mcp.yomio.app/other', 'https://mcp.yomio.app/mcp?x=1', 'https://user@mcp.yomio.app/mcp',
    'https://mcp.yomio.app/mcp#frag',
  ]) {
    assert.throws(() => validateEndpoint(new URL(bad)), /Yomio HTTPS MCP endpoint/, bad);
  }
});

// ---- credential stores ----------------------------------------------------

test('file store round-trips a session, restricts permissions, and deletes it', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'yomio-mcp-')), 'nested', 'session.json');
  const store = createFileStore(path);
  assert.equal(store.read(), undefined);
  store.write({ endpoint: ENDPOINT.toString(), tokens: { access_token: 'a' } });
  assert.deepEqual(store.read().tokens, { access_token: 'a' });
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  store.delete();
  assert.equal(store.read(), undefined);
  store.delete();
});

test('file store reports a corrupt file without leaking its content', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'yomio-mcp-')), 'session.json');
  const store = createFileStore(path);
  store.write({ endpoint: 'x', tokens: {} });
  writeFileSync(path, '{broken secret');
  assert.throws(() => store.read(), (error) => error instanceof CredentialStoreError && !/secret/.test(error.message));
});

test('credential store selection follows YOMIO_MCP_CREDENTIAL_STORE', () => {
  assert.match(createCredentialStore({ YOMIO_MCP_CREDENTIAL_STORE: 'file' }).name, /credential file/);
});

// ---- callback server ------------------------------------------------------

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

async function startFlow(overrides = {}) {
  const port = await findFreePort();
  const logs = [];
  const opened = [];
  const flow = waitForAuthorizationCode({
    authorizationUrl: new URL('https://mcp.yomio.app/oauth/authorize?x=1'),
    expectedState: 'state-1',
    expectedIssuer: 'https://mcp.yomio.app',
    port,
    log: (message) => logs.push(message),
    openBrowser: async (url) => { opened.push(url); },
    ...overrides,
  });
  flow.promise.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { port, flow, logs, opened };
}

const callback = (query) => `${CALLBACK_PATH}?${query}`;

test('a pasted address from another computer completes sign-in', async () => {
  const { flow } = await startFlow();
  const base = 'http://127.0.0.1:50000/oauth/callback?iss=https%3A%2F%2Fmcp.yomio.app';
  assert.equal(flow.submit('not an address').ok, false);
  assert.equal(flow.submit(`${base}&state=wrong&code=c`).ok, false);
  assert.equal(flow.submit(`${base}&state=state-1`).ok, false);
  assert.equal(flow.submit(`  ${base}&state=state-1&code=abc  `).ok, true);
  assert.equal(await flow.promise, 'abc');
});

test('a pasted address with an error ends sign-in as denied', async () => {
  const { flow } = await startFlow();
  const result = flow.submit('http://127.0.0.1:1/oauth/callback?iss=https%3A%2F%2Fmcp.yomio.app&state=state-1&error=access_denied');
  assert.equal(result.ok, false);
  await assert.rejects(flow.promise, /not granted/);
});

test('callback accepts one valid response and resolves the code', async () => {
  const { port, flow, logs, opened } = await startFlow();
  assert.equal(await get(port, callback('state=wrong&iss=https%3A%2F%2Fmcp.yomio.app&code=c')), 400);
  assert.equal(await get(port, callback('state=state-1&iss=https%3A%2F%2Fother.example&code=c')), 400);
  assert.equal(await get(port, callback('state=state-1&state=state-1&iss=https%3A%2F%2Fmcp.yomio.app&code=c')), 400);
  assert.equal(await get(port, callback('state=state-1&iss=https%3A%2F%2Fmcp.yomio.app')), 400);
  assert.equal(await get(port, '/other'), 404);
  assert.equal(await get(port, callback('state=state-1&iss=https%3A%2F%2Fmcp.yomio.app&code=c'), { host: 'evil.example' }), 404);
  assert.equal(await get(port, callback('state=state-1&iss=https%3A%2F%2Fmcp.yomio.app&code=good')), 200);
  assert.equal(await flow.promise, 'good');
  assert.deepEqual(opened, ['https://mcp.yomio.app/oauth/authorize?x=1']);
  assert.match(logs[0], /https:\/\/mcp\.yomio\.app\/oauth\/authorize/);
});

test('callback reports a denied sign-in', async () => {
  const { port, flow } = await startFlow();
  assert.equal(await get(port, callback('state=state-1&iss=https%3A%2F%2Fmcp.yomio.app&error=access_denied')), 200);
  await assert.rejects(flow.promise, /was not granted/);
});

test('callback keeps waiting when the browser cannot be opened, and prints the URL', async () => {
  const { port, flow, logs } = await startFlow({ openBrowser: async () => { throw new Error('no browser'); } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(logs.some((line) => /Open the URL above/.test(line)));
  assert.equal(await get(port, callback('state=state-1&iss=https%3A%2F%2Fmcp.yomio.app&code=late')), 200);
  assert.equal(await flow.promise, 'late');
});

test('callback can be cancelled and times out', async () => {
  const cancelled = await startFlow();
  cancelled.flow.cancel();
  await assert.rejects(cancelled.flow.promise, /cancelled/);
  const slow = await startFlow({ timeoutMs: 30 });
  await assert.rejects(slow.flow.promise, /timed out/);
});

test('callback reports a busy port', async () => {
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const { port } = blocker.address();
  const flow = waitForAuthorizationCode({
    authorizationUrl: new URL('https://mcp.yomio.app/oauth/authorize'),
    expectedState: 's', expectedIssuer: 'i', port, log: () => {}, openBrowser: async () => {},
  });
  await assert.rejects(flow.promise, new RegExp(`port ${port}`));
  blocker.close();
});

test('callback port is pinned by environment or chosen from free ports', async () => {
  assert.equal(await chooseCallbackPort({ YOMIO_MCP_CALLBACK_PORT: '45000' }), 45000);
  assert.ok((await chooseCallbackPort({ YOMIO_MCP_CALLBACK_PORT: 'abc' })) > 0);
});

// ---- OAuth provider with two processes ------------------------------------

function provider(store) {
  return new YomioOAuthProvider({ endpoint: ENDPOINT, store, port: 45678, authorize: async () => 'code' });
}

const session = (refresh) => ({ endpoint: ENDPOINT.toString(), tokens: { access_token: 'a', refresh_token: refresh } });

test('provider uses the dynamic redirect port', () => {
  assert.equal(provider(createMemoryStore()).redirectUrl, `http://127.0.0.1:45678${CALLBACK_PATH}`);
});

test('provider keeps tokens that another process just saved', () => {
  const store = createMemoryStore(session('old'));
  const ours = provider(store);
  assert.equal(ours.tokens().refresh_token, 'old');
  store.write(session('new'));
  ours.invalidateCredentials('tokens');
  assert.equal(store.read().tokens.refresh_token, 'new');
});

test('provider removes tokens that were rejected', () => {
  const store = createMemoryStore(session('old'));
  const ours = provider(store);
  ours.tokens();
  ours.invalidateCredentials('tokens');
  assert.equal(store.read(), undefined);
});

test('provider skips the browser when another process renewed the session', async () => {
  const store = createMemoryStore(session('old'));
  const ours = provider(store);
  ours.tokens();
  ours.state();
  store.write(session('new'));
  await assert.rejects(
    ours.redirectToAuthorization('https://mcp.yomio.app/oauth/authorize?x=1'),
    SessionRefreshedElsewhereError,
  );
});

test('provider rejects an authorization URL from another origin', async () => {
  const ours = provider(createMemoryStore());
  ours.state();
  await assert.rejects(ours.redirectToAuthorization('https://evil.example/oauth/authorize'), /unexpected authorization URL/);
  await assert.rejects(ours.redirectToAuthorization('https://mcp.yomio.app/other'), /unexpected authorization URL/);
});

// ---- bridge against a local MCP server ------------------------------------

async function startRemote({ delayMs = 0 } = {}) {
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const server = new McpServer({ name: 'fake-yomio', version: '1.0.0' });
    server.registerTool('echo', { description: 'echo' }, async () => {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    server.registerResource('guide', 'yomio://guide', { mimeType: 'text/markdown' }, (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: 'guide text' }],
    }));
    server.registerPrompt('hello', { description: 'hi' }, () => ({
      messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  return { http, url: new URL(`http://127.0.0.1:${http.address().port}/mcp`) };
}

const stubProvider = (overrides = {}) => ({
  tokens: () => ({ access_token: 't', token_type: 'Bearer' }),
  takeAuthorizationCode: () => undefined,
  signingIn: false,
  ...overrides,
});

test('bridge forwards tools and prompts to the remote server', async () => {
  const remote = await startRemote();
  const bridge = createBridge({ endpoint: remote.url, authProvider: stubProvider(), version: '0.0.0', log: () => {} });
  try {
    assert.deepEqual((await bridge.listTools()).tools.map((tool) => tool.name), ['echo']);
    assert.equal((await bridge.callTool({ name: 'echo', arguments: {} })).content[0].text, 'ok');
    assert.deepEqual((await bridge.listPrompts()).prompts.map((prompt) => prompt.name), ['hello']);
    assert.equal((await bridge.getPrompt({ name: 'hello' })).messages[0].content.text, 'hello');
    assert.deepEqual((await bridge.listResources()).resources.map((resource) => resource.uri), ['yomio://guide']);
    assert.equal((await bridge.readResource({ uri: 'yomio://guide' })).contents[0].text, 'guide text');
  } finally {
    await bridge.close();
    remote.http.close();
  }
});

test('bridge answers early while sign-in is pending, then serves the retry', async () => {
  const remote = await startRemote({ delayMs: 250 });
  const auth = stubProvider({ signingIn: true });
  const bridge = createBridge({
    endpoint: remote.url, authProvider: auth, version: '0.0.0', log: () => {}, signInPendingMs: 40,
  });
  try {
    await assert.rejects(bridge.callTool({ name: 'echo', arguments: {} }), /waiting in your browser/);
    auth.signingIn = false;
    assert.equal((await bridge.callTool({ name: 'echo', arguments: {} })).content[0].text, 'ok');
  } finally {
    await bridge.close();
    remote.http.close();
  }
});

test('soft timeout keeps waiting when no sign-in is running', async () => {
  const result = await withSoftTimeout(new Promise((resolve) => setTimeout(() => resolve('done'), 80)), 20, () => undefined);
  assert.equal(result, 'done');
});

test('public messages hide internal errors but keep sign-in and keychain messages', () => {
  assert.equal(publicMessage(new Error('ECONNRESET to 10.0.0.1')), 'Could not connect to Yomio MCP. Check your network and sign-in status.');
  assert.equal(publicMessage(new Error('Yomio sign-in timed out.')), 'Yomio sign-in timed out.');
  assert.equal(publicMessage(new CredentialStoreError('Could not read Yomio credentials from the OS keychain.')), 'Could not read Yomio credentials from the OS keychain.');
});
