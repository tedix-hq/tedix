# Devin

Install in your personal Devin scope from the source repository:

```sh
devin plugins install tedix-hq/tedix#plugins/tedix -y
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

TODO(devin-mcp): add the verified CIMD `oauthClientId` from the devin-mcp lane.
The current manifest deliberately omits it; OAuth readiness is unverified.
Do not substitute the Tedix CLI's client ID or invent a Devin client ID.

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
