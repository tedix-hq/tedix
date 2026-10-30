# Devin

Install in your personal Devin scope from the official plugin repository:

```sh
devin plugins install tedix-hq/tedix-plugins -y
devin plugins info tedix
devin mcp login tedix
```

Complete OAuth yourself. Plugin installation is separate from MCP authorization.
Personal installs follow your account to CLI, Desktop and cloud sessions.
For cloud MCP access, connect Tedix from **Customize → MCPs** in the web app.

The native manifest is `.devin-plugin/plugin.json`. It reuses `skills/` and
declares the remote MCP server inline; no skills are copied. Devin also accepts
Claude manifests, but the Devin manifest takes precedence and keeps its OAuth
settings separate from other hosts. Root `hooks.json` declares the six Devin
hooks: session-start, prompt-context, capture-reply, capture-stop, status and
devin-permission. No additional rules are bundled.

Claude Code and Codex explicitly load `config/host-hooks.json`. Keep their
wrapped event map and host-specific fields out of `hooks/hooks.json`: Devin's
web indexer also discovers that conventional path. The root Devin file is a
bare event map using only the events and fields in the
[hooks reference](https://docs.devin.ai/cli/extensibility/hooks/overview#hook-format).
The CLI plugin tests enforce that schema; Cognition's template validators
check hook JSON syntax only.

The plugin and `tedix setup agents --devin` use the public CIMD client ID
`https://os.tedix.dev/.well-known/oauth-client/devin.json`. Use the same ID
for a custom web MCP and leave the client secret blank. The client declares the
member permissions (read and write, no administration), and Tedix asks every
host to start there; admin access needs a separate step-up sign-in. Devin uses
the shared Tedix consent flow;
installation does not grant access. The registration must appear as a verified
client of the selected MCP resource before Tedix can save consent.

Plugin hooks load in CLI and Desktop, not cloud sessions. Every command exits
silently when `tedix` is absent and tolerates CLI errors. Context, recording and
status retain their existing opt-ins. The permission hook applies only within
a governed lane; plugin hooks are best effort, never an enforcement boundary.

`tedix setup agents --devin --yes` remains the CLI fallback: it writes local
hooks and MCP settings without installing skills or changing personal cloud
plugins. With a CLI containing Devin plugin support, plugin hooks defer to
matching fallback hooks marked `tedix-managed-devin-hook`; governed lanes use
their own hooks. This avoids duplicate capture without deleting custom hooks.
Older Tedix CLIs do not understand `--plugin` and their plugin hook calls fail
open; update the CLI before relying on those hooks. Do not infer hook execution
from `plugins info` alone.

For a local development install:

```sh
devin plugins install ./plugins/tedix --local -y
devin plugins info tedix
devin -p "List the Tedix plugin skills available to this session. Only list names; do not call MCP tools or change files."
devin plugins remove tedix --local
```

For an organization install, an admin opens **Customize → Plugins**, selects
**Organization**, chooses **Add plugin → From repository**, enters
`tedix-hq/tedix` and subdirectory `plugins/tedix`, reviews the source and security
notice, then installs. Connect the Tedix MCP from **Customize → MCPs** and
complete consent. Check the plugin's indexed skills and MCP configuration,
then start a new session. If the index is stale, choose **Plugin settings →
Reindex plugins**. This installs in the organization; it does not submit to a
marketplace. Organization plugins reach that organization's cloud sessions and
CLI/Desktop members whose primary organization it is.

See Devin's [plugin reference](https://docs.devin.ai/cli/extensibility/plugins/overview)
and [Customize guide](https://docs.devin.ai/product-guides/plugins).
