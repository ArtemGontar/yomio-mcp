import { randomBytes } from 'node:crypto';
import { CALLBACK_HOST, CALLBACK_PATH } from './callbackServer.mjs';
import { CLIENT_METADATA_URL } from './endpoint.mjs';
import { SessionRefreshedElsewhereError, tokensForEndpoint } from './authRecovery.mjs';

/**
 * OAuth provider for the MCP SDK client.
 * `authorize({ url, state, issuer, port })` returns a promise for the authorization code.
 */
export class YomioOAuthProvider {
  constructor({ endpoint, store, port, authorize }) {
    this.endpoint = endpoint;
    this.store = store;
    this.port = port;
    this.authorize = authorize;
    this.callbackState = undefined;
    this.codeVerifierValue = undefined;
    this.authorizationCode = undefined;
    this.lastTokens = undefined;
    this.signingIn = false;
  }

  get redirectUrl() {
    return `http://${CALLBACK_HOST}:${this.port}${CALLBACK_PATH}`;
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
    const tokens = tokensForEndpoint(this.store.read(), this.endpoint);
    this.lastTokens = tokens;
    return tokens;
  }

  saveTokens(tokens) {
    this.store.write({ endpoint: this.endpoint.toString(), tokens });
    this.lastTokens = tokens;
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

  /** True when another process saved a newer refresh token than the one this process used. */
  sessionRenewedElsewhere() {
    const used = this.lastTokens?.refresh_token;
    if (!used) return false;
    const saved = tokensForEndpoint(this.store.read(), this.endpoint)?.refresh_token;
    return Boolean(saved) && saved !== used;
  }

  async redirectToAuthorization(authorizationUrl) {
    const url = new URL(authorizationUrl);
    if (url.protocol !== 'https:' || url.origin !== this.endpoint.origin || url.pathname !== '/oauth/authorize') {
      throw new Error('Yomio returned an unexpected authorization URL.');
    }
    if (!this.callbackState) throw new Error('OAuth state is missing.');
    if (this.sessionRenewedElsewhere()) throw new SessionRefreshedElsewhereError();

    this.signingIn = true;
    try {
      this.authorizationCode = await this.authorize({
        url,
        state: this.callbackState,
        issuer: this.endpoint.origin,
        port: this.port,
      });
    } finally {
      this.signingIn = false;
    }
  }

  takeAuthorizationCode() {
    const code = this.authorizationCode;
    this.authorizationCode = undefined;
    return code;
  }

  invalidateCredentials(scope) {
    if ((scope === 'all' || scope === 'tokens') && !this.sessionRenewedElsewhere()) this.store.delete();
    if (scope === 'all' || scope === 'verifier') this.codeVerifierValue = undefined;
    if (scope === 'all' || scope === 'client') this.authorizationCode = undefined;
  }
}
