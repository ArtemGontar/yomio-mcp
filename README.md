# Yomio MCP

Connect an MCP-compatible AI client to Yomio with browser sign-in.

This local stdio connector forwards MCP requests to Yomio's hosted server.
It does not host the Yomio API or database.

## Requirements

- Node.js 22 or newer.
- An MCP-compatible AI client that can start a local stdio server.
- A desktop session with a browser for first-time sign-in.

## Install

Add this server to your AI client's MCP configuration:

```json
{
  "mcpServers": {
    "yomio": {
      "command": "npx",
      "args": ["-y", "yomio-mcp-stdio"]
    }
  }
}
```

Restart or reconnect the AI client.
On first use, Yomio opens its sign-in page in your browser.
Review the requested read-only access and approve it for your Yomio account.

The connector stores access and refresh tokens in the operating system credential store.
It does not ask you to find, copy, or configure an access token.
It uses saved tokens only for the exact endpoint that created the session.
It refreshes the session when the MCP client reconnects and opens sign-in again when Yomio rejects a saved session.

## Remote connection

MCP clients that support Streamable HTTP can connect without installing this package:

- URL: `https://mcp.yomio.app/mcp`
- Sign-in: OAuth authorization code with PKCE.
- Scope: `mcp:read`.

The remote server opens Yomio sign-in in the client's browser.
The user approves read-only access before the MCP server receives a scoped token.

## Sign out

Revoke the Yomio session and remove it from the operating system credential store:

```sh
npx -y yomio-mcp-stdio --logout
```

If you need to remove the local credentials while offline, run `npx -y yomio-mcp-stdio --logout-local-only`.
The remote session remains valid until it expires or you revoke it from a connected AI client.

## Linux credential storage

The package uses the native credential store on Windows and macOS.
On Linux, it uses Secret Service when available, such as GNOME Keyring or KWallet.
The native Linux fallback can keep credentials in memory and may not preserve them across a reboot.
Use a Secret Service provider when you need a persistent sign-in.

## Development endpoint

Set `YOMIO_MCP_URL` to `https://mcp-dev.yomio.app/mcp` to connect to Yomio development.
The package accepts only the production and development Yomio MCP endpoints.

## Available tools

The connector exposes hosted read tools for the signed-in account.
It excludes Family Group members' records.
It does not scan documents or write expense data.
Use the [REST API scan quickstart](https://yomio.app/en/developers/api) to scan a receipt or invoice.

See the [Yomio MCP guide](https://yomio.app/en/developers/mcp) for remote setup, security details, and the current tool list.
