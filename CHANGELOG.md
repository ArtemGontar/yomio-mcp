# Changelog

## 1.1.0

- Several AI clients can share one saved session. A client that loses a token-refresh race uses the renewed session and does not open a browser.
- The sign-in callback uses a free local port. Set `YOMIO_MCP_CALLBACK_PORT` to pin it.
- The sign-in URL is always printed. The `complete_sign_in` tool finishes sign-in when the browser is on another computer.
- Sign-in no longer blocks a tool call until the client times out. The call returns a message that sign-in is waiting.
- Prompts and resources from the hosted server are forwarded.
- Opt-in credential file for hosts without an OS keychain: `YOMIO_MCP_CREDENTIAL_STORE=file`.
- New options: `--help`, `--version`, `--status`, `--logout`, `--logout-local-only`, `--debug`.
- The connector exits when the AI client closes its input.
- Update @modelcontextprotocol/sdk to 1.32.2 and @napi-rs/keyring to 2.1.2.

## 1.0.1

- First public release.