# Contributing

Thank you for helping with the Yomio MCP connector.

## Report a problem

- Open an issue and choose a template.
- Run `npx yomio-mcp-stdio --status --debug` and add the output.
  The output never has tokens.
- For a security problem, follow `SECURITY.md`. Do not open a public issue.

## Change the code

1. Use Node.js 22 or later.
2. Run `npm ci`.
3. Make the change and add a test in `connector.test.mjs`.
4. Run `npm test` and `npm run check`.
5. Open a pull request that says what changed and why.

Rules:

- Tests use the in-memory credential store and a local MCP server. Do not mock the filesystem or `fetch`.
- Never print tokens or the authorization code.
- A new module goes in the `files` list and the `check` script in `package.json`.
- Change the version only in a release pull request.
  The version in `package.json`, `package-lock.json`, `server.json`, and both `plugin.json` files must match.