export const DEFAULT_ENDPOINT = 'https://mcp.yomio.app/mcp';
export const CLIENT_METADATA_URL = 'https://yomio.app/.well-known/yomio-mcp-client.json';

const ALLOWED_HOSTS = ['mcp.yomio.app', 'mcp-dev.yomio.app'];

export function validateEndpoint(endpoint) {
  if (endpoint.protocol !== 'https:'
    || !ALLOWED_HOSTS.includes(endpoint.hostname)
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

export function getEndpoint(env = process.env) {
  return validateEndpoint(new URL(env['YOMIO_MCP_URL'] || DEFAULT_ENDPOINT));
}
