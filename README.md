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

## Sign in without a local browser

The connector always prints the sign-in URL to the log of your AI client.
If it cannot open a browser, it keeps waiting, and you can open the URL yourself.
The sign-in callback returns to `127.0.0.1` on the computer that runs the connector.
For a remote shell, forward a fixed port and set `YOMIO_MCP_CALLBACK_PORT` to that port.
Set `YOMIO_MCP_NO_BROWSER=1` to print the URL and not open a browser.

If the browser is on another computer, open the printed URL there and approve access.
The last page may show a connection error. Copy the full address from the browser address bar and give it to the `complete_sign_in` tool in your AI client.
The connector checks the state and issuer, so an address from another sign-in is refused.

If sign-in takes longer than 45 seconds, the tool call returns a message that sign-in is waiting.
Finish signing in, then repeat the request.

## Options and environment

| Option or variable | Purpose |
| --- | --- |
| `--status` | Show the endpoint, the credential store, and whether a session is saved. |
| `--logout`, `--logout-local-only` | Remove the saved session, with or without revoking it at Yomio. |
| `--debug` or `YOMIO_MCP_DEBUG=1` | Print error details to stderr. Tokens are never printed. |
| `--version`, `--help` | Show the version or the usage text. |
| `YOMIO_MCP_URL` | Use `https://mcp-dev.yomio.app/mcp` for development. |
| `YOMIO_MCP_CREDENTIAL_STORE=file` | Keep the session in `~/.config/yomio-mcp/session.json` (owner access only) when no OS credential service works, such as a headless Linux host. |
| `YOMIO_MCP_CREDENTIAL_FILE` | Path for the credential file. |
| `YOMIO_MCP_CALLBACK_PORT` | Fixed local port for the sign-in callback. The default is a free port chosen at start. |

Several AI clients can use the same saved session.
If one client renews the session first, the others use the renewed session and do not ask you to sign in again.

## Tools

All tools are read-only and use the signed-in Yomio account.

| Tool | Use it to |
| --- | --- |
| `get_expenses` | List expenses with date, merchant, category, account, and text filters. Pages with `limit` and `offset`. |
| `search_expenses` | Find purchases by merchant or item name. |
| `get_expense_detail` | Read one expense with all line items. |
| `get_spending_summary` | Total spending for a date range by category or merchant. |
| `compare_periods` | Compare spending between two date ranges. |
| `get_spending_trends` | Spending by day, week, or month. |
| `get_top_merchants`, `get_top_products` | Rank merchants or products by spending. |
| `get_income_summary`, `get_income_list` | Income totals and entries. |
| `get_balance_overview` | Income against expenses. |
| `get_budget_status` | Spending against a monthly budget. |
| `get_recurring_payments`, `get_accounts`, `get_categories` | Subscriptions, accounts, and category codes. |
| `complete_sign_in` | Local tool that finishes sign-in when the browser is on another computer. |

Example requests:

- "How much did I spend on groceries last month, and how does it compare with the month before?"
- "Find every purchase that has oat milk in it."
- "Which five merchants cost me the most this year?"

## Troubleshooting

| Problem | What to do |
| --- | --- |
| A tool answers that sign-in is waiting | Finish sign-in in the browser, then repeat the request. |
| No browser opens | Open the URL printed in your AI client log. If the browser is on another computer, pass its final address to `complete_sign_in`. |
| The OS keychain is not available (headless Linux) | Set `YOMIO_MCP_CREDENTIAL_STORE=file`. |
| The callback port is busy | The connector picks a free port by itself. Set `YOMIO_MCP_CALLBACK_PORT` only if you must forward a fixed port. |
| You are asked to sign in again often | Run `npx yomio-mcp-stdio --status` to see which store is in use. A memory-only store forgets the session. |
| Anything else | Run `npx yomio-mcp-stdio --status --debug` and open an issue with the output. |
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
| `index.mjs` | Command line options and start-up |
| `bridge.mjs` | Forwards tools and prompts to the hosted server and starts sign-in when needed |
| `oauthProvider.mjs` | OAuth client state, PKCE, and saved-session handling |
| `callbackServer.mjs` | Local sign-in callback and browser launch |
| `credentialStore.mjs` | OS keychain, credential file, and in-memory session stores |
| `endpoint.mjs` | Allowed Yomio endpoints |
| `authRecovery.mjs` | Saved-session selection and recovery helpers |
| `plugins/yomio/` | Codex and Claude Code plugin manifests and listing assets |
| `server.json` | Official MCP Registry metadata for both remote and `npx` installs |
| `assets/` | Yomio icon and logo for registry and repository listings |
| `.github/workflows/` | Connector tests, security checks, and npm release |

## Where the hosted source lives

The local `npx` connector source is in the Yomio monorepo at [`src/mcp-stdio`](https://github.com/ArtemGontar/yomio/tree/main/src/mcp-stdio).
The code files in this public repository match that package source.
The [`publish-npm.yml` workflow](https://github.com/ArtemGontar/yomio-mcp/blob/main/.github/workflows/publish-npm.yml) publishes this package with npm trusted publishing.
The npm trusted publisher must use GitHub account `ArtemGontar`, repository `yomio-mcp`, workflow `publish-npm.yml`, and environment `production`.
This workflow runs here because npm checks that the package repository URL matches the repository that publishes it.

The hosted Streamable HTTP proxy is in [`src/mcp`](https://github.com/ArtemGontar/yomio/tree/main/src/mcp).
It hosts the MCP protocol endpoint and forwards OAuth and tool requests to the backend API.

OAuth grants and public tool execution live in [`src/backend/src/services/mcp`](https://github.com/ArtemGontar/yomio/tree/main/src/backend/src/services/mcp).
The backend validates account identity and reads data through its existing service and repository layers.

Shared tool names and schemas live in [`lib/shared/src/copilotToolDefinitions.ts`](https://github.com/ArtemGontar/yomio/blob/main/lib/shared/src/copilotToolDefinitions.ts).
The hosted MCP proxy has no database connection, Prisma client, or account data store.

## Registry and plugin directories

`server.json` follows the official MCP Registry format and describes the hosted endpoint and the `npx` package.
The Yomio monorepo publishes registry updates after it verifies production OAuth and MCP endpoints.
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
