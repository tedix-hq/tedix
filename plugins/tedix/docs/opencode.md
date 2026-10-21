# OpenCode

OpenCode has no plugin marketplace. It loads JavaScript plugin modules named in
its configuration. Install Tedix from a checkout of this repository by adding
the module to `~/.config/opencode/opencode.json` (or `opencode.jsonc`):

```jsonc
{
	"plugin": ["/absolute/path/to/tedix/plugins/tedix/.opencode-plugin/tedix.js"],
}
```

Restart OpenCode, then connect and check:

```sh
opencode mcp auth tedix
opencode mcp list
opencode debug skill
```

`opencode mcp auth tedix` opens the shared Tedix consent page. Complete it
yourself; installing the plugin grants no access.

## What the plugin adds

| Capability             | Claude Code and Codex                           | OpenCode plugin                                                                         |
| ---------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| MCP connection         | `.mcp.json`, host OAuth                         | `mcp.tedix`, OAuth with a public CIMD client ID                                         |
| Skills                 | `skills/`                                       | The same `skills/` directory, through `skills.paths`                                    |
| Agent-Session identity | Native session ID in the shell                  | `TEDIX_AGENT_SESSION=opencode:<ses_…>` and the version and model in each shell          |
| `SessionStart`         | `tedix hooks session-start`                     | First prompt of a session, as a synthetic `<tedix-context>` part                        |
| `UserPromptSubmit`     | `tedix hooks prompt-context`                    | Every user prompt, in the same part                                                     |
| `PreToolUse` recall    | `tedix hooks situational-recall`                | Bash, edit, write and patch tools; lessons are appended to the tool result              |
| Decision capture       | `capture-reply`, `capture-stop`                 | User prompts and `session.idle`, using the same opt-in and redaction                    |
| Request ledger         | Prompt and turn capture                         | The same ledger, scoped to the OpenCode session                                         |
| Await-reply wake       | Claude background wake; Codex Stop continuation | Idle listener runs `await-reply`; a framed answer resumes through `session.promptAsync` |
| Turn-status reporter   | `tedix hooks status`                            | Prompt, idle, permission, tool, error and deletion events; same opt-in                  |
| Repository rules       | `AGENTS.md`                                     | `AGENTS.md`, read natively by OpenCode                                                  |

The plugin adds the MCP entry only when your configuration has no `mcp.tedix`
of its own. Subagent sessions use their parent's Agent-Session and receive no
prompt context, as in Claude Code. `tedix agent start` reads the harness,
version and model from the shell, so coding Work needs no extra flags.

The hooks run `tedix hooks <name> --host opencode` in the installed Tedix CLI,
which needs a release that supports `--host opencode` (after 0.15.1). Without
the CLI, or with an older one, they add nothing and never block a turn. The
`SessionStart` preflight keeps its opt-in: a repository binding or
`TEDIX_PLUGIN_PREFLIGHT=1`.

Decision capture and the request ledger keep their existing local decision-capture
opt-in (`tedix setup agents context enable-decision-capture`). Status reporting
requires `~/.tedix/agent-status.json` or `TEDIX_AGENT_STATUS=1`. These hooks require
the CLI release containing the lifecycle hooks and a server release accepting the
`opencode` reporting harness; installing the plugin alone does not update either.

The idle listener records assistant text since the latest user message in the
ledger (up to 100 messages); decision capture and status use the final message.
It waits in the background for an answer to that
exact turn. A new prompt or session deletion cancels the wait, duplicate idle
events do not recapture a turn, and synthetic wake messages are never captured as
user replies. Permission events only report that approval is needed; OpenCode
still owns the permission decision. Subagent events do not capture or report
independent turns.

Options use OpenCode's tuple form:

```jsonc
{
	"plugin": [
		[
			"/absolute/path/to/tedix/plugins/tedix/.opencode-plugin/tedix.js",
			{ "hooks": false },
		],
	],
}
```

`"hooks": false` keeps the MCP connection, skills and identity without any
CLI hook. `"mcp": false` leaves the MCP entry to your own configuration.

## OAuth

Tedix Connect does not offer dynamic client registration, which OpenCode would
otherwise try. The plugin names the public client
`https://os.tedix.dev/.well-known/oauth-client/opencode.json`, whose only
redirect is OpenCode's default callback,
`http://127.0.0.1:19876/mcp/oauth/callback`. Keep OpenCode's default
`callbackPort`. The client must appear as a verified client of the selected
MCP resource before Tedix can save consent.
