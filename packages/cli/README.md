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
  `prompt-context` runs its gateway, organization and answer reads together
  and checks preferences and lessons each turn, injecting their text once per
  session and again only on change. Unchanged sources stay silent.
  Each turn also shows up to three accepted Work items without a live Attempt,
  assigned to this harness
  or without an executor in the bound project, with `tedix work start` commands.
  These suggestions use a 30-second cache; unavailable or expired reads are
  omitted. A suggestion still needs fresh admission before execution. Local
  session receipts contain only hashes; clear/compact resets delivery. Updated
  plugin hooks opt into a 10 KB allowance for initial context; older hook
  definitions retain 6.4 KB. A source trimmed to fit is retried on the next turn.
  Lessons retry once after 150 ms, with a 3-second retry deadline. Unavailable
  sources are omitted; the organization id is cached for ten minutes
  (`src/hooks/context-cache.ts`); `TEDIX_HOOK_TRACE=1` prints step timings.
  Scope follows the nearest `.tedix/context.json` directory binding, then this
  chat's selected or admitted Work, then successful recent CLI calls. Other
  active organizations get one line. Hook reads never reinforce the selection.
  A directory binding contains `{"version":1,"workspace":"acme","projectId":"11111111-1111-4111-8111-111111111111"}`;
  Connect profiles also specify `"organization"` with the selected ID or slug.
  Keep installation-specific bindings local. Bindings and recent calls grant no
  execution authority. Private scope metadata expires after two hours.
  Requests are read for this session and project in one snapshot. Completed
  Work explicitly linked in saved request evidence is checked before injection;
  turn reflection settles it. Human approval asks remain open for the user.
  With decision capture enabled, `capture-reply` extracts short corrections and
  standing preferences from the user's own text, then classifies the extracted
  clauses through the local Claude or Codex CLI with no tools or project context. Only
  a candidate (at most 300 characters), quote and source metadata go to
  `record_session_feedback`. The private outbox retries classification and
  upload failures at the next capture boundary. Owner feedback auto-confirms;
  project notes await review. Each prompt refreshes the approved lesson catalog
  so feedback can reach another harness on its next turn. Host hook dispatch
  must be enabled; installation alone is not delivery proof.
  `tedix learn import-memory --directory <path>` previews feedback/project notes;
  `--date YYYY-MM-DD --type feedback --apply` imports only that selection,
  extracting from the full note locally and retaining the file path and hash.
  Reference and stale notes are excluded. Full import is always explicit.
  With decision capture enabled, `capture-stop` triages the redacted turn
  into `metadata.triage`. Unavailable triage keeps the capture on bound Work
  or in the originating chat and creates no human request. The hook
  owns that chat's Stop status (`applyTriagedStop`); `status` skips Stop for
  it, decided by the same local opt-in check (`captureOwnsStop`), so each Stop
  notifies at most once. `capture-reply` adds `metadata.replyClassClef` from
  `tedix work agent-reply-label` (3 s). Quiet draft requests use
  `tedix work agent-reply-draft-request` (6 s). These calls use Code Mode
  within the hook's timeout budget.
  Codex capture checks the host's exact stored thread before opening a question.
  An unavailable, ephemeral or archived target creates no automatic request;
  the original message remains in its chat.
  SessionStart (`startup`, `clear`, `compact`) also reads the compact Open
  requests list when decision capture is enabled. The reflector can turn an
  evidenced tool failure and later fix into a private lesson proposal. It checks
  approved lessons and memory for semantic duplicates; each candidate stays
  proposed until reviewed through the existing learning pipeline.

- **Session supervisor** (`supervise.ts`) — `tedix supervise` delivers a tedi
  auto reply that arrives after a Codex session's `await-draft` stopped waiting:
  `codex queue` for an open window (confirmed in the session transcript), else a
  headless `codex exec resume` whose thread ID must match. Same delivery rules
  and cap as the hooks; `install`/`uninstall` manage a user LaunchAgent. It
  also drains the user's own OS answers no hook delivered
  (`work interaction-undelivered`, recorded with `work interaction-ack`): a
  closed Claude Code session is resumed with `claude -p --resume`, never one
  open in a terminal; Codex reuses queue/resume. An unavailable originating
  chat leaves its answer undelivered; no other chat or new Work Item is chosen.
  Delegation remains an explicit `tedix work delegate` action.
  If Codex queue withdrawal fails, the supervisor keeps a private receipt
  across retries and restarts and starts no headless turn. Delivery remains
  unconfirmed until the transcript shows the reply or withdrawal succeeds.

  Register accepted Work for an existing Codex chat with
  `tedix work handoff <id> --host codex --to codex:<chat-id> --launch`.
  The target must be bound to the same profile, organization and Work project.
  This opts that item into supervisor pickup once the chat is idle and Work is
  ready. Repeating registration preserves its delivery receipt. The recipient
  obtains its own admission; registration and delivery do not complete Work.

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
  Interactive authorization requires a human terminal outside an agent harness.
  During macOS dark wake, renewal is deferred; wake the Mac fully and retry.
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

To call an MCP protocol method that has no dedicated command, such as
`events/list` or `events/poll`, send one raw JSON-RPC request with the stored
login:

```sh
tedix -w acme mcp call events/poll --params '{"cursor":"abc"}'
tedix mcp call events/list --organization acme --header X-Probe=1
```

It respects `-w`, `--organization` and `TEDIX_ORGANIZATION`, prints the JSON
result, and never prints the token. Authorization, Cookie and organization
headers are refused.

### Factories

`tedix factory create` builds a factory from a goal in one call through the
gateway's `create_factory` tool. It creates the Work project, objective, a
scheduled lane skill (daily, twice daily, hourly or every N hours) and a
standing health Work Item. With `--output`, each run also appends its summary
to a Tedix document or sheet. `tedix factory
status` gives each factory one verdict through `inspect_factory_health`:
healthy, idle, failing, not_firing, paused or pending.

```sh
tedix factory create --goal "Keep the public docs accurate" --owner Nova --dry-run
tedix factory create --goal "Keep the public docs accurate" [--owner Nova] \
  [--cadence daily|twice_daily|hourly] [--every-hours <n>] [--template report] \
  [--slug docs-accuracy] [--max-proposals 3] [--workspace-id <uuid>] \
  [--output <id or title>] [--output-kind document|sheet] [--project <KEY>]
tedix factory status                       # every factory and its verdict
tedix factory status docs-accuracy --limit 7   # recent runs and what each delivered
```

Re-running `create` with the same slug changes nothing. When you are signed in
as a human, the lane is activated; when an agent credential runs it, the lane
stays a draft, and the printed next steps give the proof run and activation.
See [Build a factory](../../docs/public/factory-agent-guide.md#build-a-factory).

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
their separate transport purposes.

`work start <id> --worktree` creates an isolated checkout under the primary
repository's ignored `.worktrees/<work-prefix>-<attempt-prefix>` directory.
`--worktree-root <path>` overrides its parent directory. A successful
`work settle`, `work complete`, or `work cancel` removes matching worktrees
owned by the current Agent-Session, together with their `.tedix.json` files,
only when clean, unlocked, and confirmed in freshly fetched `origin/main`.
Settlement targets its exact Attempt; complete and cancel can retry cleanup
for the current session's earlier Attempts on that Work Item. Custom roots
and older external worktrees are found through Git's worktree registry.
Cleanup failures leave the checkout available and are reported separately
from the successful Work operation. When invoked inside a removed worktree,
return your shell to the primary repository afterwards.

### Local lanes

Inside each independent Codex or Claude session, bootstrap its own identity
with `tedix agent start`, then register its work before starting the brief:

```sh
tedix lane start "Improve search results" --project <project-id>
# Use --work-item <id> when the brief already names accepted Work.
tedix lane done "Validated and shipped" --commit <sha>
# Or: tedix lane fail "The provider refused the request"
```

The helper uses ordinary Work admission and records the session identity.
Report liveness with `tedix lane heartbeat` while working; `capture-stop` also
reports it. Tedix records stale lanes halfway through the server-issued lease
and expires them at the lease boundary on its two-minute tick. Registration
starts no detached heartbeat process. An expired lease requires fresh admission.
`lane done` reports success; the owning tedi verifies the result before completing
the Work. Give the Work a tedi owner or steward, or set the project's lead tedi.

Launchers must run registration **inside the child session**, preserve its
own native session id, and pass the same workspace and organization selectors
on settlement. Do not export the launcher's `TEDIX_AGENT_SESSION` into a child.
For a Claude subagent, pass its actual immutable child session id through
`TEDIX_AGENT_SESSION=claude-code:<child-session-id>` and bootstrap that identity
before registration. Independently executing lanes get their own Attempt and
worktree. If the host exposes only the parent's identity, the ledger report
links to its host Attempt and remains visibly unconfirmed until the child
registers; a transcript report cannot grant child execution authority.

## Delegated lane observations

`lane run` registers a process on Board → Agents, sends a heartbeat while it
runs, then reports its observed result. The child obtains its own Work Attempt;
the wrapper grants no execution authority. Codex JSON thread receipts select
that child's exact transcript even when several lanes run concurrently.

```sh
tedix -w acme lane run --executor codex --project <project-id> \
  --brief brief.txt --rate-scope '<published estimate scope>' -- codex exec -C . -
tedix -w acme lane import --executor codex --project <project-id> \
  --transcript rollout.jsonl                   # preview; --apply uploads
tedix -w acme lane report --input-file <saved-receipt>
```

Claude Code hooks report into the same lane when launched by the wrapper.
Other executors can write the common observation JSON to
`TEDIX_LANE_TELEMETRY_PATH`. Missing facts stay unknown. Costs require complete
request usage and matching published model/scope rows; cached and reasoning
counts are subsets, and context tiers apply per request. Estimates use rates
at report time and never rewrite historical billing. Failed final uploads keep
a private receipt for idempotent replay under the same lane identity.

### Local Work dispatcher

`tedix lane serve --executor codex --max 5 --rules <skill-uuid> --project <project-uuid> --repo <checkout>`
finds accepted Work with `metadata.executor: "codex"`. Use `--executor claude-code`
for Work assigned to `claude-code`, or `--executor any-local` to serve both
executors with one shared slot limit. Stop the individual services before switching;
the combined service preserves their retained receipts and running process slots. `--project` is optional;
workspace and organization are pinned explicitly. Rules default to the organization's
`lane-rules` skill; `--rules` selects another skill by UUID or slug. Set the executor on a Work
item or post it through the Work workspace app (`tedix:app/work`, config
`{"version":1,"projectId":"<project-uuid>"}`). Posting and acceptance remain
separate actions.

Use `--coordinated` without `--project` to execute ready coordinator selections
across projects. This mode requires an explicit `metadata.laneDispatch.state`
of `ready`. Assigning an executor readies accepted Work automatically and records
a dispatch receipt. A coordinator can explicitly hold an item to keep it queued. Existing service modes
retain their behavior when `--coordinated` is absent.

The dispatcher creates an isolated worktree and native executor session,
obtains its verified identity and Work Attempt, fetches the current
revision of the selected OS rules skill, then runs the admitted session. Codex
uses `codex exec resume`; Claude Code uses `claude -p --session-id`. Claude must
expose its PID/session record, version and model through metadata-only control
requests before admission. Unsupported CLI versions fail before a model turn.
Both preserve the configured model and permissions. The existing lane wrapper
reports telemetry; the dispatcher heartbeats and settles the exact Attempt with
its result and parsed usage. The server watcher detects stale lanes; the native
coordinator reviews results and decides Work completion or retry.

`--max` defaults to 5. One dispatcher per organization and executor runs on a
machine; retained live process groups consume slots after restart. Each Work
revision runs once. Ambiguous admission is retained for inspection. Pre-admission
read failures and failed settlements retain bounded retries, a minute apart;
settlement recovery checks the exact server Attempt before writing again.

Possible money or personal messaging requests are skipped and logged unless an
actual owner comment says `Delegation: codex work-version=<version> <bounded note>`.
Use the assigned executor name in that comment for Claude Code.
Consent, MFA and authentication remain human-only. The lexical screen is
conservative; provider permissions and atomic Work admission still apply.

On macOS, add `--install` to write and load a user LaunchAgent. It starts now
and at login, survives the launching session, and defers during dark wake.
Use a repository accessible to background processes, outside macOS protected
folders unless the executable already has Full Disk Access. The command prints
the plist and service name; stop it with `launchctl bootout <service>` before
reinstalling. No credentials or launcher identity are written into the plist.

`work dispatch-list`, `dispatch-get`, and `dispatch-attempts --input <json>`
provide full native records for this dispatcher. `work start` and `work settle`
accept `--input '{"metadata":{...}}'` for bounded execution receipts, while their
normal identity and Attempt fences remain mandatory.

### Commit handoff (experimental)

A cloud session transfers one validated commit with one CLI invocation:

```sh
tedix commit-handoff submit <work-id> --to <receiver-principal-uuid> \
  --checks "validation commands and results" --commit HEAD \
  --workspace <profile> --organization <org>
```

The command exports a binary Git mail patch, records bounded base64 parts as
machine coordination interactions on Work, and publishes its SHA-256 manifest
as a handoff interaction last. Payloads target an external agent, never a user.
The maximum patch size is 3 MB. Reported validation remains a source claim;
the receiver runs the repository gates. No tedi run or public share link is
needed. Private temporary input files are removed after each native CLI call.

The Mac operator configures `~/.tedix/commit-handoffs.json` as an array of routes.
Each requires `workspace`, `organization`, `receiverId` (the external agent
principal UUID), `projectId`, `repository` (the exact origin URL), `session`
(an existing Codex chat UUID), and `cwd` (that chat's directory). The chat must
already have decision capture enabled and be bound to the same workspace,
organization and project. The supervisor reads the explicitly configured
project's handoff audit and delivers only interactions addressed to that receiver,
once the Work is accepted and ready. Its owner login needs audit access.
Delivery receipts prove the chat received the request, not that Git pushed it.

The receiver obtains its own Work admission and isolated worktree, keeps its
Attempt alive, then runs `tedix commit-handoff apply <work-id> --to
<receiver-principal-uuid> --request <handoff-interaction-uuid> --repo <worktree>
--workspace <profile> --organization <org>`. It checks every byte and its
credential's exact Attempt before `git am -3`, preserves the author, adds a
digest trailer for retry detection, runs `bun run push`, and verifies the SHA
is on remote main. Gate failures and success receipts are Work comments.
The commands never start or settle an Attempt. Source Work stays accepted
until the receiver lands the commit; uploading alone does not satisfy its outcome.

Cloud startup hooks recognize `CLAUDE_CODE_REMOTE=true` or the explicit
`TEDIX_CLOUD_SESSION=1` marker and explain this boundary once at startup.
