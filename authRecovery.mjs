export class SessionRefreshedElsewhereError extends Error {
  constructor() {
    super('Another Yomio MCP process already renewed this session.');
  }
}

export function tokensForEndpoint(session, endpoint) {
  if (!session || typeof session.endpoint !== 'string' || !session.tokens) return undefined;

  try {
    return new URL(session.endpoint).toString() === endpoint.toString() ? session.tokens : undefined;
  } catch {
    return undefined;
  }
}

export function createSerialExecutor() {
  let pending = Promise.resolve();
  return (operation) => {
    const result = pending.then(operation, operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
}

export async function recoverRemoteAuthorization(error, connection, authProvider, reconnect) {
  // Rotating refresh tokens: a second process won the refresh, so use its saved session.
  if (error instanceof SessionRefreshedElsewhereError) {
    await Promise.allSettled([connection.client.close()]);
    return reconnect();
  }

  const authorizationCode = authProvider.takeAuthorizationCode();
  if (!authorizationCode) throw error;

  await connection.transport.finishAuth(authorizationCode);
  await Promise.allSettled([connection.client.close()]);
  return reconnect();
}

export async function executeWithAuthorizationRecovery(operation, connection, authProvider, reconnect) {
  try {
    return { connection, result: await operation(connection.client) };
  } catch (error) {
    const recovered = await recoverRemoteAuthorization(error, connection, authProvider, reconnect);
    return { connection: recovered, result: await operation(recovered.client) };
  }
}

/**
 * Every `ms`, ask `onTick()` for an error. A returned error rejects the result
 * while the work keeps running; `undefined` keeps waiting. The caller's serial
 * queue still waits for the work, so a retry runs after sign-in ends.
 */
export function withSoftTimeout(work, ms, onTick) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    const arm = () => {
      timer = setTimeout(() => {
        const error = onTick();
        if (error) reject(error);
        else arm();
      }, ms);
      timer.unref?.();
    };
    arm();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
