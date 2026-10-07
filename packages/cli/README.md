# @tedix/cli

The `tedix` command: a small program installed on your machine for working
with Tedix from the command line. Public beta; see
[Release status](../../docs/public/release-status.md).

## Overview

`@tedix/cli` is a Bun/Node CLI, not a Worker package. It runs on your machine
and talks to your organization's MCP Gateway
(`{workspace}-unified.mcp.tedix.dev/mcp`). It exists so people and coding
harnesses can drive the same Home conversation surface that Tedix OS exposes in
the browser (`ask`, run inspection, approvals, delegation) without a browser
session.

The package ships a single `tedix` bin (`src/index.ts`) that supports both a
one-shot command mode (`tedix ask "..."`, `tedix status`, `tedix approve
<runId>`) and a full ink-based REPL (`tedix` / `tedix chat` with no args)
with slash-command completion, multiline composition, live activity panels,
and durable answer settlement.

## Features

- **Agent-host setup** (`agent-host-setup.ts`) — `tedix setup agents` installs
  the Tedix plugin through Codex and Claude Code's own CLIs after a local
  preview and confirmation. `--status` reports readiness without mistaking an
  enabled plugin for login or a successful read; `--update` previews and refreshes
  through each host manager while preserving existing local marketplace sources.
  Skills and the optional hooks come with the plugin; each host retains its own
  OAuth and hook trust steps.
- **Plugin hooks** (`src/hooks/`) — `tedix hooks <session-start|prompt-context|capture-stop|capture-reply|status>`
  runs the plugin's host lifecycle hooks from the event JSON on stdin, so the
  plugin ships no scripts. `scripts/package-plugin.ts` builds its review ZIPs.
  With decision capture enabled, `capture-stop` triages the redacted turn
  (`tedix work agent-turn-triage`, 4 s, silent fallback) into `metadata.triage` and
  owns that chat's Stop status (`applyTriagedStop`); `status` skips Stop for
  it, decided by the same local opt-in check (`captureOwnsStop`), so each Stop
  notifies at most once. `capture-reply` adds `metadata.replyClassClef` from
  `tedix work agent-reply-label` (3 s). Quiet draft requests use
  `tedix work agent-reply-draft-request` (6 s). All three resolve current
  authorized native descriptors; none executes a JavaScript wrapper.

- **MCP Home client** (`home-client.ts`) — `TedixHomeClient` wraps
  `@modelcontextprotocol/client`'s `StreamableHTTPClientTransport` and calls
  the gateway's raw `home__*` tools (`ask`, `home__read_home_run`,
  `home__respond_home_approval`, `home__cancel_home_run`,
  `home__steer_home_run`, `home__read_child_run_evidence`,
  `home__read_child_run_tree`, `home__list_kernel_trace_bundles`, etc.) —
  these mirror the same `kernelRuntime` procedures Tedix OS calls over typed oRPC;
  see the [public agent guide](../../docs/public/agent-guide.md)
  for the supported operator surface.
- **Multi-workspace auth** (`workspace-resolver.ts`, `credential-store.ts`,
  `oauth-provider.ts`, `oauth-loopback.ts`) — `tedix login` opens the
  authenticated `os.tedix.dev` organization picker, resolves the selected
  public gateway without an existing grant, then runs the MCP SDK OAuth
  provider's discovery/PKCE flow and persists the grant under a
  named workspace in `~/.tedix/credentials.json` (override with
  `TEDIX_CONFIG_DIR`). Every gateway is discovered via RFC 9728 + RFC 8414 at
  login time — including the default Tedix Unified gateway — so the requested
  scopes always match what the gateway currently advertises rather than a
  hardcoded list. Every Tedix-hosted gateway uses the verified CIMD client at
  `https://os.tedix.dev/.well-known/oauth-client/tedix-cli.json`; third-party
  gateways retain SDK-managed dynamic registration as a compatibility path.
  Before each command, a stored session that is expired or within 120 seconds
  of expiry is renewed directly from its refresh token without opening a
  browser. A call that outlives its token is retried once only when the API
  returns its exact expired-forwarded-token rejection and renewal succeeds.
  Interactive authorization remains a login operation, not refresh fallback.
  Select the active workspace via
  `-w/--workspace`, `TEDIX_WORKSPACE`, or `tedix use <name>`. An explicit
  `TEDIX_MCP_BEARER_TOKEN`/`TEDIX_MCP_API_KEY` can replace the stored login;
  raw Tedix API keys are not accepted as MCP credentials.
- **Ink REPL** (`ink-repl.tsx`, `ink-bridge.ts`, `composer.ts`,
  `composer-input.tsx`) — the default interactive mode: readline-history
  navigation with `Ctrl-R` reverse search, `/slash` command menu with Tab
  completion, `@path` Tab-complete file attachment, multiline input via
  trailing `\`, and `[a]lways`-approve prompts for `requires_approval` cards.
- **Run lifecycle commands** (`commands.ts`) — `run`, `inspect`, `tail`,
  `approve`, `reject`, `cancel`, `steer`, `runs`, `messages`, `conversations`,
  `traces`, `child-evidence`, `child-tree`.
- **Live activity rendering** (`live-panel.ts`, `activity.ts`) — polls
  `home__read_home_run` for authoritative settlement while tailing the MCP run
  event stream for decorative activity rows.

## Protocol Certification

`bun run test:protocol` certifies the CLI host's discover-first `2026-07-28`
wire contract, resource reads, synchronous input-required retry, native Tasks,
and request-binding headers. Run the deployed smoke with explicit, short-lived
credentials:

```bash
TEDIX_PROTOCOL_CERT_URL=https://tenant-unified.mcp.tedix.dev/mcp \
TEDIX_PROTOCOL_CERT_BEARER_TOKEN=... \
TEDIX_PROTOCOL_CERT_RESOURCE_URI=skill://known-skill \
bun run certify:protocol:live
```

## Usage

Install the versioned standalone binary (no checkout or Bun runtime required):

```bash
curl -fsSL https://downloads.tedix.dev/install.sh | sh
tedix --version
```

Set `TEDIX_CLI_VERSION` for an exact initial install. Installed standalone
binaries update only through `tedix update`, check without mutation through
`tedix update --check [version]`, and restore the retained previous binary
through `tedix rollback`. Public R2 releases include the exact source SHA,
artifact inventory, and SHA-256 checksums; no private GitHub access is required.

```sh
bun run tedix -- login acme
bun run tedix -- ask "Summarize the active Home run set" --workspace acme
bun run tedix -- status
bun run tedix -- approve <homeRunId> "looks good"
bun run tedix                    # launches the interactive ink REPL
```

Run `tedix --help` for the full command/flag reference, including
`--delegate-to-tedi`, `--thread`, and `--json`/ndjson
output for scripting. Global options may appear before or after the command;
run `tedix code --help` for the direct gateway execution contract and
gateway-native discovery examples.

## Related

- `@tedix/api-contract` — schemas for `kernel-runtime` and
  `cognitive-runtime` payloads returned by the MCP tools.
- [Workers and governance](../../docs/public/workers-and-governance.md) and the
  [MCP app platform](../../docs/public/mcp-app-platform.md) — public context
  for the kernel/Home and MCP surfaces this CLI drives.

## Native Work commands

`tedix work` resolves typed operations through the authenticated gateway's native
bootstrap and configured catalog. Missing, denied, stale, ambiguous, or
non-native catalog entries refuse the command; Work commands do not fall back to
Code Mode. Configure the required native tools before activating this CLI.

`--as` selects a read-only namespace and does not grant another actor's identity.
The configured input schema must support every supplied filter, including
`--mine`; unsupported filters fail rather than being dropped. Board, checkpoint,
inbox, attempts, evidence, and events use the bounded CLI projections while
explicit detail commands retain their full responses.

Native requests share a 4 MiB response limit and the original deadline across
input and task continuations. Cancellation stops local reads and refuses late
results; it does not prove that a remote write stopped. Ambiguous writes are not
replayed. Explicit user-authored `tedix code` and the decision-capture hook retain
their separate transport purposes. Publishing source alone does not install or
activate a CLI release, configure native tools, or prove live adoption or savings.
