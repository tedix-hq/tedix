# Tedix CLI changelog

Notes for each CLI release, newest first, collected from `.changeset/` files.
See [CONTRIBUTING.md](../../CONTRIBUTING.md#releases) for how versions are chosen.

## 0.17.8 — 2026-10-26

### Patch Changes

- Once you approve a new agent's first sign-in, `tedix agent start` now uses that approval instead of asking for a new one every time. This lets the local Claude Code, Devin and OpenCode dispatchers start work again.

## 0.17.7 — 2026-10-26

### Patch Changes

- Local dispatchers for Claude Code, Devin and OpenCode take work again. A new agent's first sign-in waits for the owner's approval and continues once it is given, instead of asking for a new approval on every try.
- `tedix agent start` says when it is waiting for your approval and names the request.
- `tedix work start` explains which part of the agent's identity is missing and prints the one command that fixes it.
- `tedix work complete` explains when an agent may complete its own Work (its own successful attempt with a commit; not credentials, payments or messaging).
- `tedix work heartbeat --watch` recovers when a credential is withdrawn early instead of stopping.
- Lane folders start from the latest main, and clean source checkouts fast-forward without touching local work.
- The session-start hook tells the agent its session id, so audit records name the agent.
- `tedix decide` works without extra setup; `tedix factory --max-proposals` rejects a blank value; `tedix learn import-sessions --limit` stops reading once it has enough.

## 0.17.6 — 2026-10-25

### Patch Changes

- Each coding agent (Claude Code, Codex, Devin, OpenCode, Cursor) now gets its own agent identity on your machine, so its work is credited to the right agent. Sessions already started keep their identity. First-time setup finds your organizations again.
- A local dispatcher no longer gives up on a lane when Tedix is slow to confirm the start; the lane launches and reports on its next check-in.
- `tedix work create` and `tedix work accept` now honour `--executor`, so delegated Work reaches the right dispatcher. Unknown executor names are rejected up front.
- Lanes keep their Work's name in status reports, and expired lanes stop cleanly.
- `tedix flow run --param` keeps values like `Infinity` or `1e999` as text instead of turning them into empty values.
- A broken skill no longer hides your other OpenCode skills.
- `neighbours` rejects a missing `--hours`, `--paths` or `--session` value, and `work list` rejects an unsafe offset.

## 0.17.5 — 2026-10-25

### Patch Changes

- When Tedix is busy and asks your sign-in to slow down, a local dispatcher now waits and carries on instead of failing every check. A local cache that kept growing now cleans itself up.
- Work handed to a local coding agent now tells it exactly how to sign its commits, so its finished fixes are no longer refused when it pushes them.

## 0.17.4 — 2026-10-25

### Patch Changes

- A local dispatcher no longer gets stuck on Work whose earlier start failed: it tries again in a fresh folder and keeps the old one for you to inspect.
- A local dispatcher can now run Work that only mentions sign-ins or credentials once its owner posts the delegation comment for that version. Consent, MFA and password steps still stay with a person.

## 0.17.3 — 2026-10-24

### Patch Changes

- The CLI keeps your saved access permissions when it renews a sign-in, including when a request is retried.

## 0.17.2 — 2026-10-24

### Patch Changes

- `tedix lane serve --accept-proposed` lets a local dispatcher accept proposed Work in its pinned project when the Work is assigned to its executor and says what done looks like, so a scheduled shift can file fix and scout Work without a person accepting each item.
- The session-start hook tells a session with no selected Work to claim one before editing, with the exact commands, and reminds it that every commit needs a `Work-Item:` line.
- Lane names show in hook reports, which link to the launcher's session and Work item; a lane without a name uses its Work title.
- Flow plans and generated skill manifests keep titles, descriptions and parameters exactly as written, including YAML punctuation, line breaks, a parameter named `__proto__` and very large integers.
- `skill run` rejects a file and points you to `flow run --file`; invalid watch durations, Home event cursors, `learn import-sessions --limit` values, oversized neighbour windows and out-of-range Work expiry are rejected with a clear error instead of being silently changed.
- Browser login stops waiting when its local callback is gone and tells you how to restart from the terminal, and rejects a callback that selects the same organization twice.
- Dispatcher cooldowns stay valid when an executor reports an oversized retry delay.

## 0.17.1 — 2026-10-23

### Patch Changes

- The installer no longer adds a folder you chose with `TEDIX_INSTALL_DIR` to your shell profile. It prints the line for you to add instead, so temporary installs stop leaving broken entries behind.
- `tedix agent start` now says why a sign-in was rejected: a key already used with other settings, a rate limit, or a missing account, each with what to do next.
- Cloud agent sessions can start from environment credentials without an owner login, and stay signed in during long commands.
- An organization you name explicitly is used even when your sign-in doesn't select one, and the CLI explains how to supply a missing one.
- Number options that are too large to handle safely are rejected instead of silently rounded.
- Unknown options in `learn context`, `review` and `onboard` show that command's help and the closest supported flags.
- Agent activity stays fresh while a tool runs, permission summaries are written in plain words, and unattended lanes no longer send you desktop notifications.
- Devin's sandboxed pushes can record their queue receipts, and machine-readable output stays valid across lane briefs and `learn` help.

## 0.17.0 — 2026-10-22

### Minor Changes

- Record an agent's decisions with `tedix decide`, track how they turned out with `tedix decide outcome`, and review recent decisions and results by decision class with `tedix decide list`. Recording grants no authority; decisions that need a person still go through approvals.
- Route `any-local` Work across Codex, Claude Code, OpenCode and Devin using configured capabilities and model preferences. Track native usage, preserve executor cooldowns across restarts, and recover interrupted sessions before assigning fresh work.

### Patch Changes

- Reject OAuth tokens when either supported scope claim exceeds the granted permissions.
- Read large gateway results in full for `tedix code`, `tedix status`, `tedix tail` and transcript commands by retrieving stored result pages. Results that could not be stored still report truncation.
- Hold repeated lane admission failures after three attempts despite changing diagnostic details. Retry commit verification when origin is unavailable and retain the live Attempt for later verification.
- Show command-specific typo suggestions and help pointers for unknown options in `learn` subcommands and `neighbours`.
- Support OpenCode decision capture, request recording, reply wakes and turn-status reporting through the existing hooks and opt-ins. Prevent an old reply listener from waking a newer turn.
- Align JSON support with machine-readable help, including streaming channel and Work heartbeat output. Reject JSON for human-only commands before side effects and accept the global JSON flag in hook and lane commands.
- Remove the singular `tedix workspace` alias; use `tedix workspaces`.
- Retry temporary gateway access-check failures at most twice, respecting the advertised wait and command deadline. Retry a busy agent-session backend up to three times.
- Retry temporary Attempt-authorization failures at most twice within the command deadline, only when the gateway confirms nothing executed.
- Retry temporary autonomous-action-policy read failures at most twice, respecting the advertised wait and command deadline, only when the gateway confirms nothing executed.
- Expand the bundled session guide with Code Mode evidence, multi-step work, visual answers and payments.
- Preserve successful lane results when a delayed lease timer fires, while still expiring interrupted child processes.

## 0.16.0 — 2026-10-21

### Minor Changes

- Support OpenCode's native `ses_` session IDs in the session-start, prompt-context and situational-recall hooks with `--host opencode`. Recognize `TEDIX_AGENT_SESSION=opencode:<id>` as an OpenCode agent session.

### Patch Changes

- Ignore non-object JWT payloads when decoding CLI status and workspace metadata.
- Keep Home submission recovery reads within the caller's timeout and preserve reconnect guidance without resending an uncertain submission.
- List available organizations with exact `--organization` flags when a Connect command needs a selection. Use the workspace's saved default organization while it remains selected.
- Accept current Work disposition values in interaction-list responses so inbox and checkpoint reads can decode them.
- Keep stored logins renewable after refresh failures that reach no server, such as offline, DNS or refused-connection errors. Require a lane's cited commit to be newer than its starting point before counting it as that lane's landed result.

## 0.15.1 — 2026-10-21

### Patch Changes

- Prevent shared logins from being invalidated when a login refresh is interrupted or its result cannot be saved. Record refresh attempts before sending them, refuse to replay a token after an uncertain result, and reject stale credential saves. An uncertain refresh requires signing in again; successful refreshes continue normally.

## 0.15.0 — 2026-10-21

### Minor Changes

- Create expiring cloud-agent bootstrap keys with `tedix agent mint`, with platform setup instructions.

### Patch Changes

- Resolve the correct session for Codex lanes launched from Claude Code and Claude Code lanes launched from Codex. Register harnesses without a dated model snapshot using an explicit unpinned version, and read Codex's harness version from `CODEX_VERSION`.
- Read Needs-you cards at session startup, link to the active organization's OS host and the card's source, and support `TEDIX_OS_URL` for self-hosted installations.
- Allow sandboxed Devin checks to read environment examples while keeping real environment files and all environment-file writes denied. Keep temporary files and package caches inside the lane worktree.
- Allow sandboxed Devin lanes to stage, commit and use the guarded push queue in their own worktree while keeping peer worktrees, credential paths and raw pushes denied.
- Retry gateway HTTP 429 refusals up to twice after the advertised wait, within the command's deadline, including writes refused before execution.
- Reduce gateway traffic with a five-minute Work descriptor cache, less frequent lane telemetry and a shared rate-limit cooldown. Keep authorization and current-state checks on the server.
- Refuse to attribute Work writes to an inherited peer harness session when the session is ambiguous; use `TEDIX_AGENT_SESSION` to select one explicitly.
- Recover stale dispatcher worktree destinations without losing files, hold unchanged Work revisions after three identical admission failures, and filter local executors before pagination. Attach verified commits from `origin/main` to lane settlement; coding Work without a landed commit settles as failed.
- Name the command and nearest flag in unknown-option errors. Accept `--body`, `--message` and `--text` for Work comments, and document create descriptions and comment aliases.
- Forward `tedix work list` filters to the board, reject unknown filter values with the valid list, and show the next-page offset when rows remain.

## 0.14.0 — 2026-10-20

### Minor Changes

- Read and decide attention cards with `tedix deck list|show|decide`, and read the activity feed with `tedix feed`. Reads report whether results are complete; decisions check the card version and your permissions.
- Run Devin CLI as a local Tedix harness, with session identity, sandboxed lane execution, executor selection, and hooks and MCP setup.

### Patch Changes

- Retry rejected dispatcher admissions with bounded backoff after checking canonical Attempts. Keep failure details in receipts, logs and a Work comment, and explain when delegation needs an accountable user owner.
- Fix Deck decisions and Deck and Feed routing on Connect. Headless decisions save feedback and interaction responses; actions requiring approval point you to OS or Home.
- Apply the shared critical-action checks to autonomous coding lanes, including payment and publishing aliases.
- Use Tedix's shared OAuth consent flow for Devin without a client secret.
- Protect credential paths and private transcripts in Devin lanes, reject unsupported Git filter drivers, and restore clean project hooks on retries.
- Save Devin sessions before their first turn resumes, record the executable version, and pass the session identity to child CLI calls.
- Avoid duplicate turn capture when Devin plugin hooks and Tedix-managed hooks are both installed.
- Use the runner's CLI in Devin hooks, allow scoped inspection commands, and report permission rejections as failed lanes even when Devin exits successfully.
- Use Devin's native Smart mode to assess routine shell probes within scoped lanes.
- Keep FYI agent updates in chat instead of opening decision cards.
- Show up to three fresh Needs-you decisions in session hooks, scoped to the active organization with delivery receipts. Set `TEDIX_NEEDS_YOU=0` for quiet operation.
- Keep Claude Code and Codex hook configuration separate from Devin plugin discovery.

## 0.13.3 — 2026-10-19

### Patch Changes

- Other sessions can recall new lessons without waiting for shared documents or delivery tracking. Explicit per-turn instructions are excluded from preference capture.
- Strip credentials and URL queries from feedback repository metadata, and redact credentials in quoted URLs before extraction or upload.

## 0.13.2 — 2026-10-18

### Patch Changes

- Allow six seconds for live lesson validation on busy gateways. Lessons still require successful validation; hook tracing now includes this read's timing.

## 0.13.1 — 2026-10-18

### Patch Changes

- Feedback capture uses the local Codex model when an installed Claude CLI is unavailable or has reached its usage limit. Unsent candidates remain local for retry.

## 0.13.0 — 2026-10-18

### Minor Changes

- Opt-in hooks capture reusable corrections and preferences as private lessons with supporting quotes. Other coding sessions check for new lessons on their next turn.
- Preview Claude memory notes with `tedix learn import-memory`, then import a selected set of feedback or project notes.

## 0.12.1 — 2026-10-18

### Patch Changes

- Hooks read local authentication status directly, so a busy host can check board priorities without waiting for another CLI process to start.

## 0.12.0 — 2026-10-18

### Minor Changes

- Send cloud commits to a local agent through Work, preserving authorship and checking admission before import and push. Configured supervisors can pick up these handoffs.
- Run Codex and Claude assignments from one shared local dispatcher with `tedix lane serve --executor any-local`.

### Patch Changes

- Keep the organization selected through `TEDIX_ORGANIZATION` when external agents record Work activity, so later hooks resolve the same context.
- Each prompt can show up to three accepted Work priorities for this coding harness and project. Cached priorities expire after 30 seconds.
- Delegation instructions name the assigned Codex or Claude executor when an owner's note is required.

## 0.11.2 — 2026-10-18

### Patch Changes

- Lessons distinguish numbered project names and short alphanumeric terms, so prompts receive the matching lesson.

## 0.11.1 — 2026-10-18

### Patch Changes

- Plugin context follows the active organization and project and shows only this chat's unfinished requests. Unavailable and unchanged shared content stays quiet.
- Lessons match the current task and are verified live before they reach the assistant. Prompt text stays on this computer.
- Work context stays current during heartbeats and clears after settlement, including direct Code Mode calls.

## 0.11.0 — 2026-10-18

### Minor Changes

- Run accepted Codex and Claude Code Work from your Mac with `tedix lane serve`. Install it as a background service with `--install`, or use `--coordinated` to follow selected Work across projects.
- Launch agents through `tedix lane run` to see their progress, tool use, usage and estimated cost on the Agents board. Failed result uploads remain available to retry.

### Patch Changes

- Resumed Codex lanes stay in their isolated checkout, including when the dispatcher starts from your home directory.
- Work updates include stale lanes and expired Attempts for lanes registered with your normal CLI connection.
- Session context points to automatic request filing and the correction review queue.
- Relevant lessons appear before edits and commands and in lane briefs. Lane failure reports retain where delivery failed so repeated problems can inform fixes.

## 0.10.2 — 2026-10-17

### Minor Changes

- 4e86b48: `tedix lane done --needs-user "<next click>"` puts a result that needs your action in your private Needs you inbox. Use `--request-id` to update the original request.
- d477914: Register local Codex and Claude sessions with `tedix lane start`, keep their Work Attempt alive, and finish with `tedix lane done` or `tedix lane fail`.

### Patch Changes

- b46453d: Work Attempt worktrees default to the repository's `.worktrees/` directory. Finishing Work removes only this session's clean worktrees whose commits are on remote `main`; worktrees with uncommitted or unpublished work are kept.
- c52cf22: With decision capture enabled, local session activity appears in your selected organization unless you disable status reporting. Unclassified chat text stays in the originating chat and private request ledger.
- a9f0703: Skip scheduled job and system notification prompts when capturing session requests.
- 1e3db70: Concurrent CLI processes share a lock when renewing your connection and reuse the renewed access token. Invalidated refresh tokens produce one error without repeated retries.
- fdbd39a: Tedix detects stopped coding sessions and delivers requests through their registered host channel. A detached heartbeat no longer makes a stopped session look active.
- b0e1069: Private lesson proposals retain Codex tool names, denied actions and command recovery evidence. Starting, clearing or compacting a chat restores the compact Open requests list.

## 0.10.1 — 2026-10-17

### Patch Changes

- 3d06f60: Useful profile suggestions keep the same inbox identity across updates. Tedix keeps at most three open and avoids adding duplicates when it cannot read the inbox.
- 58d6498: Claude and Codex can receive an update when Home or delegated work finishes, fails or needs your input. The update names the conversation and tells you how to open its result.
- 01fbcba: Your personal profile is saved in your private workspace, visible only to you and your own tedis and agents.
- bb11acc: Accepting a profile suggestion starts its first step: handing a task to a tedi, preparing a factory for you to switch on, or drafting a document. Accepting twice does not start it twice. Re-running your profile keeps existing workstream sections and names only facts found in your sessions.
- 7fad22b: Your profile opens with “Your week in Tedix,” groups related work into up to 12 workstreams, and offers three next steps based on your goals and what matters now. Work links need evidence, and suggestions that no longer fit are withdrawn.
- c15827b: When Tedix suggests work from your sessions, it checks older completed work first and verifies which existing task a suggestion belongs under. It tells you to open Work > Needs you to accept or decline suggestions.
- 42794dc: An agent can no longer run login and replace your shared connection. Login requires a human terminal. When a sleeping Mac briefly wakes, Tedix waits to renew the connection without asking you to sign in again.
- 729aceb: Your Needs you list stays quieter: uncertain agent summaries stay out, questions keep the identity of the chat that asked, and unanswered onboarding suggestions expire.
- 2624634: Starting, clearing or shortening a chat brings back unfinished requests and questions waiting for your answer.
- 5b6d824: New Work can use its project's purpose automatically. Tedix explains when that purpose takes precedence over the usual short-lived task defaults.
- 4b1785c: When a captured turn cites a commit, Tedix reads its local details so request status checks can use the original completion evidence.
- f4bcfd7: With decision capture enabled, Tedix keeps a private list of your requests and the agent's promises across Claude Code and Codex chats. If sending fails, it keeps the message for another try. Before each prompt, the agent sees recent open requests from this chat and earlier chats in the same repository. Request completion needs supporting evidence. You can see the list in Work > Needs you > Your requests.
- f011e96: Request status checks receive the full redacted agent turn, including reports from supporting agents.

## 0.10.0 — 2026-10-16

### Minor Changes

- 331ee60: You can use `tedix channel claude` to receive Tedix comments, questions, task updates, approval requests and failed-run notices in Claude Code. Start Claude Code with `--dangerously-load-development-channels server:<name>` to enable delivery.
- 80b9029: You can use `tedix channel codex <thread-id>` to receive Tedix updates in a Codex conversation. If the conversation is not open in a window, Codex continues it in the background. Notices include the command to read the relevant task.
- c3a731f: You can use `tedix learn onboard`, `tedix learn context` and `tedix learn review` to compare work from your local Claude Code and Codex conversations with your organization's board. New tasks are added only after you accept them. Analyzing your conversations no longer overwrites other members' shared notes, and importing conversations also includes preferences saved in your local agent memories.
- 1821ba5: You can use `tedix learn profile`, also included in onboarding, to create a private “What Tedix knows about you” document from your local Claude Code and Codex conversations. It covers your projects, unfinished work, collaborators and working preferences, and proposes three ways Tedix can help in your inbox. It includes conversations with supporting agents and background runs, reuses saved summaries on later runs, and keeps the original conversations on your machine.
- be22aa6: `tedix learn onboard` now runs in the background, so you can keep using your terminal. Use `--wait` to wait for it, or run it again to continue an interrupted run. Proposals show their source conversations in your Tedix inbox; accept or decline them in Tedix OS, chat or `tedix learn review`. Accepting creates the proposed tasks, and declined proposals stay dismissed across machines. Three or more related tasks without a matching project or larger task are proposed together under one larger task.

### Patch Changes

- c6dacfe: `tedix agent --help` now tells you to include `--idempotency-key` when finishing with `--no-handoff-reason`.
- 69ef37c: Error messages now give you a clearer next step. `tedix code` reports failed tool calls even when your program hides them, and tells scripts the command failed. Work commands explain how to register your agent, use the owner's login when required, or select a task. Factory status includes run IDs, errors and the command to investigate. Workflow lists no longer fail because the response is too large. Unsupported connection options on local commands show you the command to use instead.
- 139fdfb: You can select a workspace on local commands. Repeated activity warnings now appear once with the run ID, and conversation lists and deletion confirmations are shorter and easier to read. Use `--json` for the full result.
- 14c63bc: `tedix channel` notices now tell you when someone answers a question and include the `tedix work interaction-get` command to read the answer.
- 842a7b0: `tedix chat` now shows one clear approval prompt when a change needs permission. Replying `approve` or `reject` in the same conversation resolves it.
- 94ef77a: When you start Codex from a Claude Code terminal, `tedix agent status`, `tedix agent finish` and `tedix work` now find the correct Codex session.
- fbbedf5: Work commands can still check their results when tool descriptions leave out result details. When looking up a tool in Code Mode, you now get its required inputs by default and can request result details separately.
- b3da605: You can schedule a factory to run hourly or every few hours. Use `tedix factory create --output` to append each run's summary to a Tedix document or sheet.
- ebfe230: You can pause, resume or archive a factory from the command line. Creating a factory, including a preview, now shows who will own it and the limits of the report it can produce.
- be95a25: Factory errors now show what went wrong in plain text. Factory status clearly marks paused schedules and tells you how to read a run with `tedix skill status <runId>`. A creation preview explains that the next run time is set when you create the factory, and factory help points to the pause and archive guide.
- 64da56d: `tedix factory status` now lists factories needing attention first and ends with a count for each status.
- 6bfc447: Weekly factories no longer appear to have missed a run between scheduled runs. Turned-off schedules show as `paused`, and factories with failed or missing runs appear in red.
- efbbc94: `tedix learn onboard --dry-run` now quickly previews local conversation counts and topics without using a model. Add `--with-model` for a full preview, which takes a few minutes.
- 0b6f5e8: `tedix skill status` and `tedix flow status` now correctly report a failed run instead of saying the status check failed. They show the failing tool and its error on one line.
- 8af3f94: `tedix learn` can now use your local Codex installation when Claude is unavailable. `tedix learn context` considers all your organization's projects, adds specific tasks under broader open work, and keeps related tasks in the same project. People's names are removed from conversation titles before those titles leave your machine.
- b731225: `tedix work interaction-cancel` now confirms that your requested cancellation succeeded instead of reporting an error while reading the result.
- 3d1f821: Commands that delete or cancel something can now finish after you confirm them on both newer and older Tedix connections. Your confirmation applies only to the action you approved.
- c2bbe95: `tedix rename "<conversation id>" <title>` now correctly handles quoted conversation IDs containing spaces, so those spaces no longer change the title.

## 0.9.2

### Patch Changes

- a494e82: `tedix factory create` no longer requires `--owner`; without it the organization's default tedi owns the factory.
- c4aeafb: Inject preferences and lessons once per session, refresh on content changes, and retry a failed lessons read once within the hook budget. Updated plugin hooks allow full initial context while retaining the smaller budget for older installed hooks.
- 7564507: Skip draft waiting for unattended Codex exec runs and cap the default attended Stop wait at 90 seconds.

## 0.9.1

### Patch Changes

- 4bdf527: `tedix factory status` without a slug no longer fails with "result truncated by gateway" when an organization has many factories; the overview now fetches only the fields it prints.

## 0.9.0

### Minor Changes

- a25aba1: Add `tedix factory create --goal "..." --owner <tedi>` to build a factory in one call: a Work project and objective, a daily scheduled lane skill from the `report` template, and a standing health Work Item. Re-running it with the same slug changes nothing. Add `tedix factory status [<slug>]`, which gives each factory one verdict (healthy, idle, failing, not_firing or pending) with its recent runs and what each delivered.
- 9602683: Add `tedix mcp call <method> [--params <json>] [--header <name=value>]` to send one raw MCP JSON-RPC request, such as `events/list` or `events/poll`, to the selected workspace's gateway with the stored login. The token stays inside the CLI and is never printed.

### Patch Changes

- f54abec: Start the detached login renewer without a shell, and keep `tedix learn` from stalling on commands made of repeated `0=` assignments.

## 0.8.19

### Patch Changes

- c6d9d40: Decision capture records turns and replies in Claude Code background sessions (`claude agents`). They report themselves unattended, so since 12 October no question or reply from them reached Tedix.

## 0.8.18

### Patch Changes

- aeae574: Keep the shared login alive when a host kills a timed-out hook or the Mac drops back to sleep. Login renewal now runs outside the hook's process tree and does not start while a sleeping Mac is briefly awake in the background. Each renewal is recorded in `~/.tedix/renewals.log` without secrets, so a future logout names the process that caused it.

## 0.8.17

### Patch Changes

- 4301f2c: External-agent sessions accept the organization slug (for example `TEDIX_ORGANIZATION=tedix`) as well as its UUID, so launched workers no longer need `--organization <uuid>`.
- 9c7139d: `tedix work heartbeat --watch` now keeps renewing through a timeout, dropped connection or 5xx error while the confirmed lease lasts, and prints why it stopped, including when it reaches its horizon (the number is the total run time, not the interval).

## 0.8.16

### Patch Changes

- a2633c6: Use the requested agent harness's native session ID during agent bootstrap, preserving explicit session overrides and refusing mismatched or missing identities before credential exchange. A Codex worker launched from Claude no longer registers under the launcher's Claude session.
- 7f1a27e: Renew a stored login in a detached process, so a command killed during renewal (for example by a hook deadline) no longer loses the rotated refresh token and logs out every session on the machine. The renewal deadline now also covers the response body.
- bced0f9: `tedix learn analyze-sessions` no longer reports polling loops (`until … sleep`, `gh run watch`, `--watch`) as long stalls, and names a command that starts with a variable assignment by the command it runs instead of "shell". `tedix -w <workspace> learn …` now says to put options after `learn` instead of failing with "Unknown option".
- c30b700: `tedix update` and `install.sh` now retry release metadata reads and binary downloads up to 3 times on connection, DNS, timeout and 5xx failures, and on final failure name the failing URL, the error class and a next step instead of "Unable to connect".
- 17bb9db: `tedix work context --json` now includes the Work Item's project name and brief.

## 0.8.15

### Patch Changes

- c258df1: Agent hooks now read, acknowledge and record Tedix OS answers and drafts through Code Mode, which takes about 2 s instead of 5 to 14 s. Acknowledgements fit their 3-second hook budget, so a delivered answer no longer stays listed as undelivered.
- 4b43ffe: Native `tedix work` verbs reuse the gateway's catalog bootstrap for up to 6 hours instead of fetching it on every command, and read verbs (`get_*`/`list_*`) send their call alongside the catalog checks, using the answer only when the checks resolve the same tool. A warm read now takes one round trip instead of three.

## 0.8.14

### Patch Changes

- 108570a: A failed tool call no longer clears the saved gateway discovery answer unless the failure shows the gateway's protocol changed. Commands such as `tedix ask` stop paying an extra 1-2 s discovery round trip after an unrelated error in another `tedix` process on the same machine.
- 201062b: Reading your undelivered Tedix OS answers now uses Code Mode, which takes about 2 s instead of 5 to 14 s. The background supervisor no longer misses its 15-second deadline and skips delivery when the gateway is busy.

## 0.8.13

### Patch Changes

- 11b05d0: On macOS, `tedix update` re-signs the installed binary with a self-signed code-signing identity named "Tedix CLI (local)" when you have created one, so a Full Disk Access grant for the background supervisor survives updates. Tedix never creates the identity. `tedix supervise install` points at the new guide until the binary is signed.
- 4b41d14: The background supervisor no longer attempts a headless Codex or Claude Code resume in a macOS privacy-protected folder such as Documents, where it always failed with "Interrupted system call". It logs the Full Disk Access grant, or the checkout move, that makes the resume possible.

## 0.8.12

### Patch Changes

- 9b0ffdb: The background supervisor no longer runs its delivery reads inside folders that macOS privacy protection guards, such as Documents, Desktop, Downloads and iCloud Drive. Those reads always timed out there, so answers and drafts were not delivered to sessions in a checkout under `~/Documents`. They now resolve at once from the session's default binding.

## 0.8.11

### Patch Changes

- b3e1c99: `tedix work` commands look up a Work tool's catalog entry and schema in parallel, saving one round trip per command.
- fcb9512: The status hook now recognizes Codex side threads that carry their parent chat's transcript, such as prompt suggestions, and keeps them off the Agents board. A Codex session's end is now filed under Codex rather than Claude Code, so its board row closes instead of leaving a stray Claude Code entry.

## 0.8.10

### Patch Changes

- c720870: The status and decision-capture hooks now ignore Codex side threads that Codex never saves, such as prompt suggestions and memory consolidation. These threads no longer appear on the Agents board as separate sessions or post raw JSON summaries.

## 0.8.9

### Patch Changes

- dce7e02: Commands reuse the gateway's protocol discovery for six hours, so `tedix ask` and other commands skip one round trip before their real call.

## 0.8.8

### Patch Changes

- 464bef8: Agent status reports now carry the session name and its bound project and Work item.

## 0.8.7 — 2026-10-11

### Fixed

- Register accepted Work for pickup by its named existing Codex chat with
  `work handoff --host codex --to codex:<chat-id> --launch`. The supervisor
  checks the chat's organization, project, idle status and Work readiness
  before delivery, and preserves receipts across retries and restarts.
- Delivery is confirmed only by the complete message in a received user
  message. Diagnostic commands or assistant text quoting it cannot count
  as delivery. An uncertain queued message prevents a duplicate turn.

## 0.8.6 — 2026-10-11

### Fixed

- A turn that asks you for nothing is closed by the server as acknowledged
  instead of waiting for a tedi "carry on" reply, so sessions stop
  ping-ponging over status lines. The `await-reply` hook stops waiting on
  such a question without waking the session, and a closure recorded with no
  delivery is never read back as your answer.
- The supervisor resolves a session's local context in-process, keeping the
  originating chat and organization selection.
- Automatic Codex continuation requests open only for stored chats that can
  receive an answer; unavailable or archived chats keep their message in the
  chat without a question or draft.

## 0.8.5 — 2026-10-11

### Fixed

- Answers stay with the chat that asked. The supervisor no longer creates
  another Work Item or chooses another chat after two hours of waiting.
- Codex answers use the transcript identified by the host, rather than a
  guessed filename. Missing or unavailable chats wait without a false
  delivery acknowledgment.
- Uncertain Codex queue deliveries survive retries and restarts without
  starting a duplicate turn when withdrawing the queued message fails.
- `work interaction-respond --no-deliver` closes a status update without
  waking the asking chat. The Office labels it "Closed (no delivery)".

## 0.8.4 — 2026-10-11

### Fixed

- The prompt-context hook is fast again: a cold turn takes about 3 s and a
  warm turn under a second (it took 16 s and Claude Code discarded its output
  after 15 s). Slow-changing context (preferences, lessons, organization) is
  cached under `~/.tedix/hook-cache` for 10 minutes; per-turn reads run in
  parallel with short timeouts and fail on their own. `TEDIX_HOOK_TRACE=1`
  prints step timings. The bundled plugin raises the hook timeout to 30 s.

## 0.8.3 — 2026-10-11

### Fixed

- `tedix supervise` no longer changes its own working directory to read a
  session's context; under launchd that failed every check with a `getcwd`
  error, so no answers were delivered overnight. Reads now run in the
  session's checkout directly.
- A failed CLI read names the exit code or signal and the end of the child's
  error output, and the supervisor log says why undelivered answers could not
  be read.

## 0.8.2 — 2026-10-10

### Fixed

- A tedi's automatic reply now answers its question on the server in the
  tedi's name, so the question leaves your "For you" inbox instead of lingering
  as an open ask. Your own later reply, typed in the chat or in Tedix OS, is
  still recorded and delivered to the session as a correction. The hooks and
  `tedix supervise` record each delivery once with the new
  `tedix work interaction-draft-delivered` verb.

## 0.8.1 — 2026-10-09

### Fixed

- Answers you give in Tedix OS now reach the session that asked. The hooks hand
  a session every pending answer to its questions, not only the newest, and
  record the delivery. `tedix supervise` resumes a closed Claude Code session in
  the background with the answer, delivers to Codex by queue or resume, and
  after two hours hands an undelivered answer to your lead session as a
  delegated Work Item. New verbs: `tedix work interaction-undelivered` and
  `tedix work interaction-ack`.
- `tedix work` errors say why a Work tool cannot be called: an alias names its
  canonical tool, a missing scope lists what is required and missing, and a
  gateway problem says whether the catalog is unavailable or the organization
  does not match.
- The Work interaction guidance names the response kind each request kind
  takes, instead of telling agents to acknowledge every request with
  `coordination_update`.
- `tedix supervise install` reinstalls over a loaded LaunchAgent: it waits for
  the old job to unload, retries, and confirms the job before reporting success.
- A session with no status update for 12 hours counts as ended; `tedix hooks
  status` and `tedix supervise` remove status files untouched for 7 days.

### Added

- `tedix work delegate "<title>" --done-when "…" --via subagent|session`
  registers a lead session's hand-off as an accepted Work Item and comments the
  brief; `--done <id> --note "…"` records the outcome and completes it. The
  prompt-context hook lists that session's open delegations (at most eight).

## 0.8.0 — 2026-10-09

### Added

- `tedix supervise` delivers a tedi auto-reply that arrives after a Codex
  session stopped waiting for it: to an open Codex window, or by resuming the
  session in the background. `tedix supervise install` starts it at login on
  macOS and `tedix supervise uninstall` removes it. `tedix supervise --once`
  reports how many waiting questions it checked and how many checks failed.
- `tedix agent rename` names a profile's agent after this machine and user (or
  `--display-name`), so later Claude Code or Codex sessions no longer show up
  as whichever agent first set the profile up. Commit provenance is unchanged.
  `tedix agent start` prints the exact rename command once when it applies.

### Changed

- An automatic tedi reply now reaches Claude Code and Codex as your delegated
  answer: the agent acts on it, including routine bookkeeping such as closing
  verified Work Items, and holds back only for credentials, payments, consent,
  messaging people as you, publishing to a public repository, or irreversible
  actions affecting others.
- `tedix hooks status` reports session status with your stored login, so it
  reaches the agent-session board as you.

### Fixed

- `tedix status` shows in-flight runs and recent delegations again instead of
  `active=0 delegations=0` while a delegated run is in progress, and reports an
  error rather than "(none)" when a result cannot be returned.
- `tedix ask --thread <name>` and `tedix threads` work again; they always
  failed with "Could not verify the organization for saved conversation names."

## 0.7.3 — 2026-10-08

### Fixed

- A tedi auto-reply now says plainly which steps the agent may take on it
  (reversible routine work within the current task) and which still need you
  (pushing to a public repository, deploying, messaging people, credentials,
  money). When the agent declines an auto-reply, the draft is recorded as
  rejected, and a question you ask about a tedi reply no longer counts as
  overriding it.
- Session analysis no longer counts a pipeline that ends in a search finding
  nothing (for example `ls | grep x`) as a failing tool call.

## 0.7.2 — 2026-10-08

### Fixed

- `setup agents context disable-decision-capture` no longer silently turns
  decision capture off for an organization's other bound repositories. While
  others are bound it refuses and says so; add `--organization-wide` to stop it
  everywhere, or run `unbind` to drop only this repository. `unbind` keeps the
  organization's opt-in.
- `setup agents context show` and the session-start brief now say plainly
  whether decision capture is on or off.

## 0.7.1 — 2026-10-08

### Fixed

- `tedix learn analyze-sessions` finds the Work Items it created on an earlier
  run and updates them; 0.7.0 searched by a title too long for the server and
  could not. A failed search now stops the run instead of creating.

## 0.7.0 — 2026-10-08

### Added

- `tedix learn analyze-sessions` reads your local Claude Code and Codex
  sessions whole and keeps three ranked lists per organization, each in one
  Work Item that later runs update in place: requests you repeat (candidates
  for a skill or command), recurring friction such as failing commands, retry
  loops, permission denials and long stalls (candidates for automation or a
  hook), and a decision log your local `claude` CLI extracts, citing the
  session and time. Only counts and short redacted paraphrases are sent;
  `--dry-run` shows them first.

## 0.6.8 — 2026-10-08

### Added

- The prompt hook sends the chat's id with its team-lessons read, so Tedix can
  record which lessons reached each chat and measure whether they reduce
  repeated corrections. A stable 10% of chats receive no learned lessons
  (written and reviewed lessons still arrive) as the comparison group.

## 0.6.7 — 2026-10-08

### Fixed

- The prompt hook keeps its context under 6,400 bytes in Claude Code as well as
  Codex; both plugin hooks declare a 6,500-character limit, and 0.6.6 could
  exceed it in Claude Code. Over budget it drops lower-ranked lessons first,
  always keeping the top six, then shortens document text.

## 0.6.6 — 2026-10-08

### Fixed

- Outside a bound repository, the prompt hook also delivers the
  working-preferences document selected with `connect-preferences` for the
  default profile and organization, not only team lessons.
- The prompt hook adds one fixed line: for a status question, check live state
  (the Work board, deploys, API health, CI) before answering, not just git.
- Decision capture files no question from unattended runs: `claude -p`, the
  Agent SDK and `codex exec`.

## 0.6.5 — 2026-10-08

### Fixed

- `tedix learn import-sessions` waits while the lesson run finishes in the
  background instead of reporting a timeout, and no longer imports test
  prompts such as "without tools, report only…".

## 0.6.4 — 2026-10-08

### Fixed

- The prompt and decision-capture hooks no longer apply the saved default
  organization inside an unbound Git repository. There they use the
  organization of your other bound repositories with the same owner, or stay
  idle; the default applies only outside Git.

## 0.6.3 — 2026-10-08

### Fixed

- `tedix learn import-sessions` waits a minute before asking again when
  turning decisions into lessons outlasts the gateway's wait, so two runs do
  not overlap.

## 0.6.2 — 2026-10-07

### Fixed

- `tedix learn import-sessions` retries a rate-limited upload instead of
  dropping it, keeps turning your decisions into lessons when a long run
  outlasts the gateway's wait, and reports the first errors. Pasted blocks
  are left out of your replies even when they are not closed.

## 0.6.1 — 2026-10-07

### Fixed

- A headless Claude Code run (`claude -p`, the Agent SDK) with decision
  capture on now exits when it finishes instead of waiting up to four hours
  for a Tedix OS answer nobody can deliver to it.

## 0.6.0 — 2026-10-07

### Added

- `tedix setup agents context set-default-organization <ID or slug>` saves
  the organization that sessions outside a bound repository use when your
  profile has several. It is checked against your login at every use: if
  that organization is no longer selected, nothing is read or recorded.
  Repository bindings still win, and decision capture outside a repository
  follows this organization's opt-in. `--clear` removes it.

### Fixed

- The prompt hook keeps its context within each host's limit: about 6,400
  bytes for Codex and 9,600 for Claude Code. It drops lower-ranked lessons
  first, keeping at least the top three, then shortens document text, instead
  of cutting the end of the message.

## 0.5.0 — 2026-10-07

### Added

- `tedix learn import-sessions` teaches Tedix from your past Claude Code and
  Codex sessions on this machine. It sends only redacted pairs of the agent's
  last message and your reply, never a whole transcript, to the organization
  each repository is bound to, then turns them into lessons for your later
  sessions. `--dry-run` shows counts and samples and sends nothing; re-running
  is safe.

## 0.4.1 — 2026-10-07

### Fixed

- The prompt hook's gateway read uses the rest of the hook's time budget
  instead of a fixed 8 seconds, so a slow first call no longer drops
  preferences and team lessons from the turn.
- When other context is shown and no approved lesson applies, the hook says
  "Team lessons: none approved for this repository and host." instead of
  omitting lessons silently.
- Decision-capture questions name the repository from its Git origin, not
  the worktree or clone folder, so lessons learned in a worktree reach the
  repository's sessions.

## 0.4.0 — 2026-10-07

### Added

- Sessions outside a bound repository, in any folder and for non-coding work,
  now receive your lessons and can use decision capture. The organization is
  `TEDIX_ORGANIZATION` or your profile's only organization. If several are
  possible and none is chosen, nothing is read or recorded.
  `setup agents context show --allow-default` shows what a folder resolves to.
- `setup agents context enable-decision-capture --project <UUID>`, run
  outside a repository, chooses the inbox for those sessions.

### Changed

- Lessons are now yours plus your organization's: one learned from your
  decisions reaches only your sessions unless a reviewer shares it.

### Fixed

- Each local harness session on a shared profile gets its own Agent-Session.

## 0.3.0 — 2026-10-07

### Changed

- Team lessons now come from your organization's memory instead of a
  document. Each agent session receives only the lessons a person approved
  that fit its repository and host, plus general ones, each with a short id.
  Nothing needs to be connected; the organization is the one the session is
  bound to.
- `setup agents context connect-lessons` and `disconnect-lessons` are removed.
  An old lessons selection is ignored.

### Fixed

- A chat bound to a different profile of the same organization received
  working preferences but silently no team lessons.
- An answer you gave in Tedix OS still reaches the session when shared
  context cannot be read.

## 0.2.0 — 2026-10-07

First release on plain semver. Changes since 0.1.0-beta.117:

### Added

- The installer takes a channel: `curl -fsSL https://downloads.tedix.dev/install.sh | sh -s -- --channel beta`
  installs the newest prerelease; the default stays on stable releases.
- Agent sessions can receive your organization's team lessons as context.
- Decision capture can triage agent turns by urgency, and a tedi can draft a
  reply to a non-urgent turn for you to review in Tedix OS.
- A tedi can send its reply on its own for routine turns that are easy to
  undo.

### Changed

- Every Tedix plugin hook now runs as `tedix hooks <name>` in this CLI, so the
  hooks need no other runtime.
- `tedix work` commands talk to Tedix directly instead of going through Code
  Mode, and check protocol support once per command.
- Decision-capture questions read as plain requests in Tedix OS.

- Plugin hooks exit silently when the `tedix` command is not installed.

### Fixed

- Codex now waits long enough for a tedi's automatic reply, labels its
  decisions correctly, and skips heartbeat turns.
- A scope request that nobody can approve fails at once instead of waiting.
- Renewing a session applies the same grant rules as a fresh login.
- Shared context is still added when one connected document is not readable.
- Model-backed agent tools work again.
