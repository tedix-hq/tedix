# Tedix in Claude, Cowork and Claude Code

Use the same Tedix organization context, Work Items, skills and Workspace Outputs
from each host. Start with your task. The plugin should find relevant context,
carry out authorized steps and ask a clear question only when it needs your input.

## Choose your setup

| Setup                     | Use                                             | What you get                                                                                |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Online Claude chat        | Online plugin or remote connector               | Tedix tools and shared skills without installing the CLI.                                   |
| Online Cowork             | Online plugin and remote connector              | Tedix context and durable results from your Cowork task.                                    |
| Local Tedix + Claude Code | Local package with an explicit loopback gateway | Your local Tedix data and tools; no automatic fallback to Tedix Cloud.                      |
| Hybrid Code or Cowork     | Local package with the remote connector         | Shared Tedix organization context plus optional context hooks in the execution environment. |

“Local” describes where Tedix data and tools run. Claude still requires its own
model service and account; this is not an offline Claude model.
Claude chat ignores local hooks and subprocess MCP servers. Cowork executes in
its own environment: your laptop's CLI, environment variables and `localhost`
are not automatically available there. A local Cowork server must be installed
inside that environment using supported plugin-bundled MCP configuration.
Do not expose a local gateway publicly just to make a remote connector reach it.

## Online: connect without the CLI

In Claude's connector settings, add **Tedix** with this URL:

```text
https://connect.mcp.tedix.dev/mcp
```

Complete the normal OAuth flow and select the organizations and access you want.
The owner handles sign-in and consent. Never paste a token into a chat or package.
Remote connectors connect from Anthropic's infrastructure, including when used
from the desktop app; they cannot reach your computer's loopback address.

For bundled skills, build the online plugin and upload the ZIP using the host's
plugin installation interface:

```sh
bun packages/cli/scripts/package-plugin.ts --host claude /tmp/tedix-claude-online.zip
```

This package contains the native Claude manifest, remote MCP connection and the
shared Tedix skills. It contains no executable hooks. Use the same connector URL
to reuse an existing Tedix connection. A connector alone provides tools, not
bundled skills. Installation does not grant writes or execution authority.
Custom connectors are available on Free with a one-connector limit; plugin and
Cowork availability depend on the host's current plan and organization policy.

## Local and hybrid

Build the hybrid package for Claude Code or a Cowork execution environment:

```sh
bun packages/cli/scripts/package-plugin.ts --host claude --local /tmp/tedix-claude-hybrid.zip
```

It adds the existing opt-in `SessionStart` and `UserPromptSubmit` context hooks.
They need only an installed Tedix CLI in the execution environment: each hook
runs `tedix hooks <name>`. Without the CLI each hook exits silently and the
session continues without Tedix context.
Configure the matching CLI profile and chat selection separately; changing the
MCP endpoint does not change the hooks' CLI binding. Review hooks in the host.
If the CLI or selection is unavailable, the hooks do not claim fresh context.
They never upload prompt text, record the conversation or grant authority.
The separate decision-capture hook records turn endings and replies only after
the explicit opt-in described in the [Codex guide](./chatgpt-codex.md#record-decisions-with-explicit-opt-in);
it behaves the same in Claude Code.
The [Claude Code guide](./claude-code.md) covers marketplace installation,
separate MCP and CLI authentication, and hook setup.

For a local Tedix gateway, use the URL shown in Tedix OS's **Gateways** view:

```sh
bun packages/cli/scripts/package-plugin.ts --host claude --local \
  --mcp-url http://local-tedix-unified.localhost:3000/mcp \
  --mcp-bearer-env TEDIX_MCP_BEARER_TOKEN /tmp/tedix-claude-local.zip
```

The package stores only the environment variable reference, never its value.
Supply the local credential to Claude Code's environment. Tedix's isolated
development demo uses the fictional `tedix-local-demo` token; it cannot authorize
Cloud access. See [local Tedix setup](https://docs.tedix.dev/getting-started).
Do not enable CLI context hooks for a local-only task until their selection also
points at the local gateway. Setting `TEDIX_PLUGIN_PREFLIGHT=0` disables them.
Loopback HTTP is allowed only for an explicitly local package; remote endpoints
must use HTTPS. URLs containing credentials, query strings or fragments are rejected.

## Continuation and lifecycle limits

Continue agreed executable work in the current task. Put a genuine human question
in Tedix with its recommendation and originating task, and preserve the user's
answer there. A saved reply is not proof that the host woke or resumed the chat.
Context hooks run at lifecycle boundaries; they do not wake an idle session.

Claude Code Channels can push events into an open session, but they are a
research preview requiring explicit per-session enablement and host approval.
Their stdio channel contract is different from ChatGPT's MCP Events webhook
contract. Tedix does not silently enable development flags, change an allowlist
or install a polling model coordinator. Automatic reply wake-up in ordinary
Claude chat and Cowork is not verified by this package.

## Verify before relying on it

1. Validate the extracted package with `claude plugin validate --strict <directory>`.
   This makes no model calls and proves packaging, not authentication.
2. In the intended host, read your actual identity and one exact Work Item or
   Workspace Output. Record the organization, returned ID and current revision.
3. For hooks, verify a fresh briefing after startup and a submitted prompt.
   Test a missing or conflicting selection too; old context must not become authority.
4. Test a real question and reply separately. Record receipt, originating-chat
   acknowledgment and task continuation; do not infer them from installation.

References: [platform support](https://claude.com/docs/plugins/platform-support),
[plugin format](https://code.claude.com/docs/en/plugins-reference),
[hooks](https://code.claude.com/docs/en/hooks),
[remote connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp),
and [Channels](https://code.claude.com/docs/en/channels).
