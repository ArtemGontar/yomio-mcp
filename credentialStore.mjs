import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Entry } from '@napi-rs/keyring';

const MISSING = /no entry|not found|ENOENT/i;

export class CredentialStoreError extends Error {}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Session store in the OS credential store (Keychain, Credential Manager, Secret Service). */
export function createKeychainStore(entry = new Entry('app.yomio.mcp', 'default')) {
  return {
    name: 'OS keychain',
    read() {
      try {
        const saved = entry.getPassword();
        return saved ? JSON.parse(saved) : undefined;
      } catch (error) {
        if (MISSING.test(describe(error))) return undefined;
        throw new CredentialStoreError('Could not read Yomio credentials from the OS keychain.');
      }
    },
    write(session) {
      try {
        entry.setPassword(JSON.stringify(session));
      } catch {
        throw new CredentialStoreError('Could not save Yomio credentials to the OS keychain.');
      }
    },
    delete() {
      try {
        entry.deletePassword();
      } catch (error) {
        if (!MISSING.test(describe(error))) {
          throw new CredentialStoreError('Could not remove Yomio credentials from the OS keychain.');
        }
      }
    },
  };
}

export function defaultCredentialFile() {
  return process.env['YOMIO_MCP_CREDENTIAL_FILE'] || join(homedir(), '.config', 'yomio-mcp', 'session.json');
}

/**
 * Opt-in store for systems without a working credential service (for example a
 * headless Linux host). The file is readable by the current user only.
 */
export function createFileStore(path = defaultCredentialFile()) {
  return {
    name: `credential file ${path}`,
    read() {
      try {
        const saved = readFileSync(path, 'utf8');
        return saved ? JSON.parse(saved) : undefined;
      } catch (error) {
        if (MISSING.test(describe(error)) || /** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return undefined;
        throw new CredentialStoreError('Could not read Yomio credentials from the credential file.');
      }
    },
    write(session) {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, JSON.stringify(session), { mode: 0o600 });
        chmodSync(path, 0o600);
      } catch {
        throw new CredentialStoreError('Could not save Yomio credentials to the credential file.');
      }
    },
    delete() {
      try {
        rmSync(path, { force: true });
      } catch {
        throw new CredentialStoreError('Could not remove Yomio credentials from the credential file.');
      }
    },
  };
}

export function createMemoryStore(initial) {
  let session = initial;
  return {
    name: 'memory',
    read: () => session,
    write: (next) => { session = next; },
    delete: () => { session = undefined; },
  };
}

export function createCredentialStore(env = process.env) {
  return env['YOMIO_MCP_CREDENTIAL_STORE'] === 'file' ? createFileStore() : createKeychainStore();
}
