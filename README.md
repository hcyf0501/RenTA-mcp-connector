# RenTA MCP Connector

This private distribution connects MCP-capable AI clients, including Codex and Claude Code, to a RenTA deployment. It contains:

- an MCP server for health checks, approved-Agent discovery, task execution, and verified local artifact delivery;
- the `renta-escalation` Skill, which escalates a task only when the user asks for RenTA or local capability is materially insufficient;
- installation templates that keep each user's endpoint, user identifier, output directory, and token outside Git.

## Security model

Repository privacy protects this connector's source code. It does not authorize access to RenTA. The deployed platform must authenticate and authorize every request independently. Never commit `config/.env`, tokens, private keys, passwords, generated deliverables, or personal local paths.

The MCP server does not contain a default platform address. Each user must set `RENTA_BASE_URL` in `config/.env`. Environment variables inherited by the MCP process override values in that file.

## Codex CLI installation

Clone the private repository, then run the same Node.js installer from the repository root on either operating system:

```bash
node scripts/install-local.mjs --codex-home "$CODEX_HOME"
```

When `CODEX_HOME` is not set, omit the argument to use the platform default (`~/.codex` on Ubuntu and `%USERPROFILE%\\.codex` on Windows):

```bash
node scripts/install-local.mjs
```

Convenience wrappers call this same cross-platform implementation:

```powershell
.\scripts\install-local.ps1 -InstallerArguments @('--codex-home', $env:CODEX_HOME)
```

```bash
bash scripts/install-local.sh --codex-home "$CODEX_HOME"
```

The first run creates `config/.env` from the tracked template and stops. Fill in its placeholders, run the command again, then begin a new Codex session. The installer refuses to add a duplicate `[mcp_servers.renta-platform]` block.

For a custom setup, merge `config/config.toml.example` into the desired Codex configuration and create `config/.env` yourself.

## Claude Code session loading

Create `config/.env` from the template, fill it in, and start Claude Code with this plugin directory:

```bash
claude --plugin-dir /absolute/path/to/renta-mcp-connector
```

The `.mcp.json` uses `CLAUDE_PLUGIN_ROOT` when Claude supplies it. Start a new Claude session after changing the Skill or plugin files.

## Validate before publishing

Node.js 18 or newer is required. The test uses a local mock server and never contacts RenTA:

```bash
node --test tests/server.test.mjs
```

Before every commit, inspect staged content and confirm that no local configuration is present:

```bash
git status --short
git diff --cached --check
git diff --cached
```

See `docs/SECURITY_CN.md` for private GitHub release steps and operational safeguards.
