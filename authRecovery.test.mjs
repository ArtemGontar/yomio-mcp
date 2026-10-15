import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSerialExecutor,
  executeWithAuthorizationRecovery,
  tokensForEndpoint,
} from './authRecovery.mjs';

test('saved tokens are only returned for the endpoint that stored them', () => {
  const session = {
    endpoint: 'https://mcp.yomio.app/mcp',
    tokens: { access_token: 'fixture-production-token' },
  };

  assert.equal(tokensForEndpoint(session, new URL('https://mcp.yomio.app/mcp')), session.tokens);
  assert.equal(tokensForEndpoint(session, new URL('https://mcp-dev.yomio.app/mcp')), undefined);
  assert.equal(tokensForEndpoint({ ...session, endpoint: 'not a URL' }, new URL('https://mcp.yomio.app/mcp')), undefined);
});

test('remote requests run in order, including after a failed request', async () => {
  const execute = createSerialExecutor();
  const events = [];

  const first = execute(async () => {
    events.push('first-start');
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.push('first-end');
    throw new Error('fixture failure');
  });
  const second = execute(async () => {
    events.push('second');
    return 'done';
  });

  await assert.rejects(first, /fixture failure/);
  await assert.doesNotReject(second);
  assert.deepEqual(events, ['first-start', 'first-end', 'second']);
});

test('authorization recovery finishes the new code and retries on a fresh connection', async () => {
  const calls = [];
  const connection = {
    client: { close: async () => calls.push('close') },
    transport: { finishAuth: async (code) => calls.push(`finish:${code}`) },
  };
  const authProvider = { takeAuthorizationCode: () => 'fixture-code' };
  const replacement = { client: {}, transport: {} };
  let attempt = 0;

  const output = await executeWithAuthorizationRecovery(
    async (client) => {
      calls.push(client === replacement.client ? 'retry' : 'initial');
      attempt += 1;
      if (attempt === 1) throw new Error('expired grant');
      return 'tool result';
    },
    connection,
    authProvider,
    async () => {
      calls.push('reconnect');
      return replacement;
    },
  );

  assert.equal(output.connection, replacement);
  assert.equal(output.result, 'tool result');
  assert.deepEqual(calls, ['initial', 'finish:fixture-code', 'close', 'reconnect', 'retry']);
});
