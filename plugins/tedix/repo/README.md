# Tedix plugins

The Tedix plugin for coding agents and AI assistants: skills plus a connection
to the Tedix MCP gateway, so your agent can find your organization's Work,
delegate to tedis, and save durable results.

> Generated from [`plugins/tedix`](https://github.com/tedix-hq/tedix/tree/main/plugins/tedix)
> in [tedix-hq/tedix](https://github.com/tedix-hq/tedix). Edit there; this
> repository is rebuilt on each plugin release. Issues and ideas:
> [tedix-hq/tedix](https://github.com/tedix-hq/tedix/issues).

Tedix Cloud is an invited beta; ask for access through the
[contact page](https://tedix.dev/contact/). See
[release status](https://docs.tedix.dev/release-status).

## Install

**Claude Code**

```sh
claude plugin marketplace add tedix-hq/tedix-plugins
claude plugin install tedix@tedix-plugins --scope user
```

**Codex** (needs the `mcp_2026_07_28` feature; `codex features enable mcp_2026_07_28`)

```sh
codex plugin marketplace add tedix-hq/tedix-plugins
codex plugin add tedix@tedix-plugins
codex mcp login tedix
```

Both connect to `https://connect.mcp.tedix.dev/mcp` and sign you in with OAuth
the first time a skill needs it.

## What is included

| Path               | For                                          |
| ------------------ | -------------------------------------------- |
| `skills/`          | Agent Skills shared by every host            |
| `.mcp.json`        | The remote Tedix MCP server (HTTP)           |
| `.claude-plugin/`  | Claude Code plugin and marketplace manifests |
| `.codex-plugin/`   | Codex plugin manifest                        |
| `.agents/plugins/` | Codex marketplace manifest                   |
| `assets/`          | Icons and logos                              |

This published plugin contains **no hooks**. Optional local session hooks
(session context, decision capture, turn status) ship with the
[Tedix CLI](https://docs.tedix.dev/cli): `tedix setup agents`.

## Versions

The plugin follows its own semver while below 1.0; see `version` in
`.claude-plugin/plugin.json` and the
[releasing policy](https://github.com/tedix-hq/tedix/blob/main/CONTRIBUTING.md#releases).

## License

AGPL-3.0-only, like the Tedix product. See [LICENSE](LICENSE).
