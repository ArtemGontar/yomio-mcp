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
