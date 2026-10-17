# Yomio MCP

Connect an MCP-compatible AI client to your own Yomio account.
This repository provides a local `npx` connector and plugin packages for Codex and Claude Code.

The hosted MCP endpoint is `https://mcp.yomio.app/mcp`.
The hosted service proxies requests to the Yomio API and does not connect to the database directly.

## Choose a connection

Use the hosted endpoint when your client supports remote Streamable HTTP and OAuth.
This needs no local package.

Use the `npx` connector when your client starts MCP servers over local stdio.
The connector forwards requests to the hosted service.

Both methods use OAuth for your Yomio account.
The server asks you to sign in only when a protected tool call needs access.
Connecting, initialization, and tool discovery do not open a browser.

## Install with `npx`

Use Node.js 22 or newer.
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

Restart or reconnect the client.
When you first call a protected Yomio tool, sign in and approve read-only access in the browser.

The connector stores OAuth tokens in the operating system credential store.
It refreshes access tokens silently while the refresh grant remains valid.
It starts browser sign-in again only when a protected tool call needs authorization and the saved grant cannot be renewed or accepted.

To sign out and revoke the saved session, run:

```sh
npx -y yomio-mcp-stdio --logout
```

The `--logout-local-only` option removes the local credential without revoking the remote session.

## Install in Claude Code

Add the Yomio marketplace and install its plugin:

```sh
claude plugin marketplace add ArtemGontar/yomio-mcp
claude plugin install yomio@yomio-mcp
```

You can also connect directly to the hosted server:

```sh
claude mcp add --transport http yomio https://mcp.yomio.app/mcp
```

Claude Code starts OAuth when a protected tool call needs access.

## Install in Codex

Add the repository marketplace:

```sh
codex plugin marketplace add ArtemGontar/yomio-mcp
codex plugin add yomio@yomio-mcp
```

The plugin uses the hosted MCP endpoint and requests OAuth only when a protected tool call needs access.
In ChatGPT desktop, you can also open the Plugins Directory, select the Yomio marketplace, and install Yomio there.

The repository also includes a portable Agent Plugins manifest for other clients that support this format.

## Connect another MCP client

For a client that supports remote Streamable HTTP and OAuth, connect to:

```text
https://mcp.yomio.app/mcp
```

For a client that supports only local stdio, use the `npx` configuration above.
For example, Claude Code can use the package directly:

```sh
claude mcp add --transport stdio yomio -- npx -y yomio-mcp-stdio
```

## Data access

The public MCP grant has the `mcp:read` scope.
The public server exposes read-only tools for expenses, income, accounts, budgets, categories, recurring payments, and spending summaries.
It does not expose expense creation, edits, or notes.
It reads only the account that signed in and does not include Family Group members' records.

Each person signs in to their own Yomio account.
The package contains no database credentials or shared user token.

## Repository contents

| Path | Purpose |
| --- | --- |
| `index.mjs` | Local stdio bridge, OAuth callback, keychain storage, and hosted MCP client |
| `authRecovery.mjs` | Saved-session selection and recovery helpers |
| `plugins/yomio/` | Codex and Claude Code plugin manifests and listing assets |
| `server.json` | Official MCP Registry metadata for both remote and `npx` installs |
| `assets/` | Yomio icon and logo for registry and repository listings |
| `.github/workflows/` | Connector tests and security checks |

## Where the hosted source lives

The local `npx` connector source is in the Yomio monorepo at [`src/mcp-stdio`](https://github.com/ArtemGontar/yomio/tree/main/src/mcp-stdio).
The code files in this public repository match that package source.
The [monorepo release workflow](https://github.com/ArtemGontar/yomio/blob/main/.github/workflows/publish-mcp-package.yml) publishes the npm package with npm trusted publishing.

The hosted Streamable HTTP proxy is in [`src/mcp`](https://github.com/ArtemGontar/yomio/tree/main/src/mcp).
It hosts the MCP protocol endpoint and forwards OAuth and tool requests to the backend API.

OAuth grants and public tool execution live in [`src/backend/src/services/mcp`](https://github.com/ArtemGontar/yomio/tree/main/src/backend/src/services/mcp).
The backend validates account identity and reads data through its existing service and repository layers.

Shared tool names and schemas live in [`lib/shared/src/copilotToolDefinitions.ts`](https://github.com/ArtemGontar/yomio/blob/main/lib/shared/src/copilotToolDefinitions.ts).
The hosted MCP proxy has no database connection, Prisma client, or account data store.

## Registry and plugin directories

`server.json` follows the official MCP Registry format and describes the hosted endpoint and the `npx` package.
The Yomio monorepo publishes the listing after it verifies production OAuth and MCP endpoints.
See the [Registry publishing workflow](https://github.com/ArtemGontar/yomio/blob/main/.github/workflows/publish-mcp.yml).

Codex and Claude Code can install the repository marketplaces directly.
The public ChatGPT and Codex Plugins Directory and Anthropic's public directory have separate submission and review steps.
The manifests and icons here prepare the package for those submissions.

## Security

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability.
Do not include Yomio account data, OAuth codes, or tokens in public issues.

## Links

- [Yomio MCP guide](https://yomio.app/en/developers/mcp)
- [Yomio privacy policy](https://yomio.app/en/privacy)
- [Yomio terms of service](https://yomio.app/en/terms)
- [Yomio support](https://yomio.app/en/user-guide)
