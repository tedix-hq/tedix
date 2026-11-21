# Tedix CLI changelog

Notes for each CLI release, newest first, collected from `.changeset/` files.
See [CONTRIBUTING.md](../../CONTRIBUTING.md#releases) for how versions are chosen.

## 0.29.9 — 2026-11-21

### Patch Changes

- c107488: `tedix update` no longer signs the command-line tool with a local certificate, and `tedix supervise install` no longer points to Full Disk Access. macOS keeps background programs out of Documents, Desktop and Downloads; keep checkouts somewhere else, for example `~/Developer`. When the supervisor cannot read a session's folder it says so and names that rule.

## 0.29.8 — 2026-11-21

### Patch Changes

- 2793066: Prepare fresh starts before retrying Work that previously failed readiness, including after a runner restart. Approval, purpose and dependency blocks no longer take preparation places ahead of fresh starts later in the list.
- ec6ec32: `tedix supervise` ends at once when it is asked to stop. A stop that arrived during its check of waiting questions was only obeyed after that check, which can take minutes, so the Tedix app had to stop it by force after 30 seconds on quit and on updates.

## 0.29.7 — 2026-11-21

### Patch Changes

- 32cbc1d: `tedix supervise` stops its runners as soon as it is asked to stop, instead of after the question check in progress. Started by the Tedix app, it also stops when the app is gone. On a Mac with the Tedix app, the app runs `tedix supervise` itself and removes the `tedix supervise install` login service.

## 0.29.6 — 2026-11-21

### Patch Changes

- bc4fbce: Report the machine, harness version and model when a local Work run starts, and include the runner's launch context in the agent brief.
- 2800016: A tedi may read your runner's log files under ~/.tedix/ and list its folders on your Mac; its sign-ins, sessions and settings stay refused. A web address such as api.tedix.dev is no longer mistaken for that folder.
- 87d7b69: Read process identities asynchronously while the runner drains for an update, keeping lease heartbeats responsive.

## 0.29.5 — 2026-11-21

### Patch Changes

- 9c866bf: Stop re-running agent verification of a landed change when the verifier cannot reach what proves it, such as a browser, computer use or a missing scope. The runner records the run as cancelled instead of failed, holds the task, and asks its owner once what someone with access must check.
- 2a86391: A restarted runner no longer marks a finished run as failed. Since the change that releases runs whose process died, a run that had already ended and was waiting for its commit proof, its completion or a retried settlement was settled as "Recorded agent process is dead" and lost the commit it had landed. Those runs are left to their own settlement again.
- 4666858: Release dispatcher runs when their recorded process dies or their server Attempt ends or expires. Preserve unfinished work in the retained checkout and allow newer Work revisions to run.
- c2a50d4: Allow up to three queued runner calls at once so a slow preparation does not block every other call.
- 5df5761: A runner's waiting starts keep their order. A start a person asked for takes a fourth preparation place; the next preparation to end then woke the oldest waiting start although no place was free, and that start went to the back of the order. A freed place now goes straight to the oldest waiting start, however the preparation ended. A start request for an item that is waiting starts it at once instead of being skipped as "Already running here", and a waiting start whose Work changed or left the runner's list is dropped and no longer counts as running.
- d4af264: Fix `tedix work wait` to resolve the gateway's canonical Work wait tool.
- e59af11: Let coding runs requested by their owner in workspace chat start without a wording check on the brief. Tool permissions and approvals still apply when the agent acts.

## 0.29.4 — 2026-11-21

### Patch Changes

- f92f6e2: A runner on macOS no longer freezes after a start that was not admitted. Checking whether a run's folder was still in use opened the working folder of every process on the Mac, and macOS can hold such an open forever (an app's private folder, Documents); the runner then went silent until the supervisor killed it, and its replacement froze the same way. The check now uses the path macOS reports without opening it. The supervisor also tells a runner that waits for an earlier runner apart from a hung one: it no longer restarts the waiting runner, and it stops the earlier runner once that has outlived its two-minute drain time. A Codex start-up that times out now has its process killed if it ignores the request to stop.
- 9aaca82: A runner now prepares at most three Work Items for admission at once and starts the next as each is admitted or fails, instead of starting every ready item in one go; on a slow gateway that left dozens of start-ups timing out with nothing admitted. The number of runs that may be running is not limited. The rules are read once per pass instead of once per start.

## 0.29.3 — 2026-11-20

### Patch Changes

- d8d8563: The runner state a tedi reads from a Mac no longer counts runs that are not there. A task that a runner was starting was listed as a live run for as long as its record stayed on disk, even after the runner was stopped or the start had failed. It now counts only while the runner is running and the start is less than 15 minutes old. Each live run also shows who runs it, the model, the step it is in and the minutes so far.
- Runners on 0.29.2 started no tasks: they read the shared runner rules with a command that was missing its input argument, so the read failed and no work was admitted. The read now passes it.
- d906bca: `tedix update` and `tedix rollback` now reload the background service on macOS when it runs the file they replaced, and say whether it came back. Before, macOS refused to start the service again after an update until it was unloaded and loaded by hand. Runs in progress stop when the service reloads. The copy that comes with the Tedix app can now be updated and rolled back with these commands too.

## 0.29.2 — 2026-11-20

### Patch Changes

- f16534d: A runner now tells Tedix which rules skill it uses in its first pass and once a day after, so a runner with no tasks yet still appears under the skill's "Used by". It also reports a rules problem then, without waiting for a task.
- d03b1de: Runners now take their basic rules from the Tedix installation, so a new organization's runners work without creating a rules skill first. `tedix lane serve --rules <skill>` is optional: when the skill is active its text is added to the shared rules, and when it is missing or archived the runner says so in its log and health report and keeps working with the shared rules. If the shared rules cannot be read, the runner admits nothing and reports why. `tedix work runner-rules` prints the shared rules.
- 6e1dc47: A runner now starts waiting tasks sooner on a slow or rate-limited connection. A start request for a task whose earlier start failed before Tedix was asked for an Attempt (for example on a read timeout) starts it again at once instead of leaving it to the next pass. A pass first starts every task it may start and only then reads the tasks that wait for an owner's comment, so those reads no longer hold back tasks further down the list. Reads of the runner rules and the rules skill are tried again like other reads instead of failing the start on one slow answer.

## 0.29.1 — 2026-11-20

### Patch Changes

- A runner now tells Tedix which rules skill it reads when it first starts a task, not in a separate call at start. The call at start made a real request before every pass and delayed the first pass.

## 0.29.0 — 2026-11-20

### Minor Changes

- 9712646: The Tedix desktop app can now set up a Mac without a terminal, and `tedix setup agents` installs the published plugin.

  - `tedix setup agents` adds the plugin from `tedix-hq/tedix-plugins` (`tedix@tedix-plugins`) to Claude Code and Codex. An earlier install from `tedix-hq/tedix` counts as installed and keeps updating from there; no second copy is added.
  - `tedix setup agents --status --json` prints, for Claude Code, Codex and Devin, whether the tool is found and whether Tedix is added to it.
  - `tedix login` works when the desktop app starts it: it opens the browser and waits. It is still refused in CI and inside a coding agent.
  - A `tedix` that the desktop app ships and links from `~/.local/bin` leaves updating to the app: `tedix update` and `tedix rollback` say so and change nothing. Separately installed copies update as before.
  - `tedix setup agents` gives a coding tool up to two minutes to answer and up to 14 minutes to fetch the plugin, so a slow connection no longer fails the install.

### Patch Changes

- fc41c74: A machine whose owner switched the write tools on now lets a tedi list a folder and read a text file under the owner's home folder, such as `~/Downloads`, for a signed-in person. Credential locations, hidden settings folders, app data and anything outside the home folder are refused. A command no longer needs a workspace first: without one it runs in the home folder.
- 9896502: `tedix lane serve` now tells Tedix which skill it reads as its rules, so the skill shows its runners under "Used by" and cannot be archived by mistake. When that skill is not active, the runner says so in the supervisor log and in its health report ("rules skill lane-rules is archived: no work will be admitted until it is restored") instead of failing each task quietly. `tedix skill show` lists what uses a skill.

## 0.28.5 — 2026-11-20

### Patch Changes

- A Claude Code runner now pauses when Claude Code is signed out, instead of taking tasks that each fail before starting. Sign in with `claude` and it resumes.

## 0.28.4 — 2026-11-20

### Patch Changes

- A run started from chat is no longer lost when the runner is waiting to restart onto a newer CLI. The start request stays in place for the runner that replaces it, and the runner log says what happened to every request and why.
- A follow-up the runner could not read at the end of a turn is read again before the run settles, and a follow-up delivered to a turn that is already running now leaves a line in the runner log.

## 0.28.3 — 2026-11-20

The 0.28.2 build did not publish; this release also carries its changes below.

### Patch Changes

- A runner over its checkout space limit now frees old checkouts whose only leftovers are ignored files, such as generated local config. It used to keep them forever.

## 0.28.2 — 2026-11-20

### Patch Changes

- Show how the last attempt ended and the reason it stored in `tedix work context`, so a failed run says why on the task. A coding run that ends without a commit now also says that a task asking for no code change must not be of kind coding.
- Add `tedix work wait <id>` to block until a task has a new comment, run message, answer or lifecycle event. Returns a continuation cursor and an explicit timeout reason; use `--input` to set `timeoutMs` or pass the previous `cursor`.
- A Claude Code runner takes Work again when one of your Claude plugins is offline or waits for sign-in; only a broken plugin or MCP configuration still pauses it. When a runner is over its checkout space limit, it now also frees checkouts that a held task no longer uses, and stops dev servers an ended run left running in its folder, saving any unpushed work first.
- Let the server decide whether a dispatcher run can retry. Remove local failure caps and retry windows while preserving human waits and settlement recovery.
- Preserve server refusal reasons for Work commands and print next commands, including structured reason, message and nextCommands fields in JSON errors.

## 0.28.1 — 2026-11-20

### Patch Changes

- A run that someone asked a tedi for in chat starts as soon as the machine is told. It no longer waits for the runner to finish its pass over the backlog or behind the calls of running tasks.
- Run leases are renewed and checked in a separate process, so a busy runner keeps the tasks it is working on.

## 0.28.0 — 2026-11-20

### Minor Changes

- A follow-up sent to a Codex run now reaches the turn that is already working, without stopping it. "Send now" can still interrupt and resume when live delivery is not available.

### Patch Changes

- A Codex run no longer fails when Codex has not created its sessions folder yet.
- When a tedi starts an agent run, the machine's dispatcher is woken so the runner checks the task right away.

## 0.27.0 — 2026-11-20

### Minor Changes

- A machine keeps one open connection to Tedix for machine tool calls where the server offers it, so a call arrives at once instead of at the next poll. The machine keeps polling when the server offers no connection or the connection drops.

### Patch Changes

- A run that asks a question no longer holds its place on the runner while it waits. When the answer arrives, the same agent session continues under a new attempt.
- When the runner skips the same task on several passes in a row, it reports the reason for that task, so whoever supervises it can see why it is not starting.
- The runner reports the CLI version it runs, so it shows in the machine list.

## 0.26.1 — 2026-11-19

### Patch Changes

- A tedi's machine tool calls are answered by a process of their own (`tedix lane serve --machine-tools-only`), which the supervisor starts and keeps running, one per machine. Before, the Codex runner answered them, and calls waited for minutes while it was busy with agent runs. Its log is `~/.tedix/dev.tedix.machine-tools.log`; while calls cannot be claimed it says so every minute, and once when they work again.

## 0.26.0 — 2026-11-19

### Minor Changes

- A runner can answer read-only questions about its machine for a tedi: read a file, search the code, list and read commits, read CI runs and the failure lines of a CI job, and report the state of the runners on the machine. Files and history are read from the runner's own copy of main, never from your working folders. Every answer is masked for secret shapes and cut to 20,000 characters. The runner reports a machine name (the short hostname, or `machineName` in its saved settings).
- A tedi can change files and run commands on your machine when you switch it on. It is off by default. To allow it, add `"machineWriteMode": "allow"` to the runner's entry in `~/.tedix/supervisor-runners.json` (the entry that answers machine tools: the Codex runner if you have one, otherwise the first in the list) and restart the runners. The tedi works in its own checkout of the repository under `~/.tedix/machine-workspaces/`, never in your working folders. Sign-in, consent and MFA steps, payments, deleting data, messages to outside people, force-pushes, `sudo` and credential files are refused.

## 0.25.0 — 2026-11-19

### Minor Changes

- A follow-up sent to a run with "Send now" no longer waits for the agent's current turn to end. The runner stops the turn of a Codex or Claude Code run and starts the next turn on the same session with the follow-up. Other agents, and a turn that does not stop in time, take the follow-up when the turn ends, and the run's log says so.
- An agent run can ask the person who owns its task a question, with up to five offered answers, and wait. The question shows in the run's log; the run stays alive for up to 30 minutes, and the person's answer reaches the agent as its next turn on the same session. With no answer in time the run ends as deferred, with the question recorded.

### Patch Changes

- A follow-up, a "Send now" message or an answer no longer fails the run when its turn starts. Each turn of a run writes to its own output files, also after the runner restarts. If a follow-up turn still cannot start, the run ends with the result of the turn before it and its log says the follow-up was not applied.
- Runners send run steps less often, so several runs at once stay under the server's call limit. A run with nothing new asks for messages every 15 seconds, runs share one budget, and a run that is told to slow down waits longer before it tries again.
- A runner can restart onto a new CLI when a process number it remembered now belongs to another process, or when an ended attempt has no recorded process.
- The runner's comment about unpushed commits names where they are saved after the checkout is removed and gives the command to fetch them.

## 0.24.1 — 2026-11-19

### Patch Changes

- A runner can check landed work after a deploy without any extra setting. It reads the health pages of the Tedix connection it already uses to see which version is deployed. Set `TEDIX_LANE_VERIFY_HEALTH_URLS` only to check other addresses.

## 0.24.0 — 2026-11-19

### Minor Changes

- A runner keeps a log of each Codex or Claude run and lets people steer it. While an agent works on a task, the runner sends short steps to Tedix every 5 seconds: what the agent said, which commands and tools it ran, and which files it changed. Secrets are masked, and command output and file contents are never sent.
- A follow-up sent to a run reaches the agent as a further turn in the same session once the current turn ends, up to five per run. The result of the last turn is the one recorded. A follow-up that asks for a human-reserved action is passed on only when the task's accountable owner sent it; consent, MFA and sign-in steps are never passed on.
- A stop request ends the agent and records the run as cancelled with a note naming who stopped it. The runner does not start that version of the task again.

### Patch Changes

- A Codex or Claude run that is still producing output is not stopped when the runner cannot confirm its hold on the task. It is stopped when the server says the hold is gone, or when the agent goes quiet for a minute while the hold is unconfirmed.
- After a lost hold or a dropped connection, the runner continues the same Codex, Claude Code or OpenCode session under a new attempt. After two unsuccessful resumes it holds that version of the task.
- A follow-up or a stop sent to a run is not lost when the server's answer does not arrive or the runner restarts. Each message reaches the agent once, a follow-up counts as applied only after its turn has started, a stop after the agent has ended, and a resumed run picks up follow-ups that were not yet applied.

## 0.23.1 — 2026-11-19

### Patch Changes

- A Codex run no longer fails when its result file fills a field that belongs to a different outcome. The runner drops such fields; a field no outcome defines is still refused.
- A runner renews its hold on a task over a connection it keeps open, without starting a new process each time. A shared pause after a rate limit, or a queued read, no longer delays a renewal.
- `tedix lane serve` checks that Codex can reach the network and that Claude Code starts its plugins and connections before it claims a task. An executor that fails the check takes no new tasks; the runner logs the first failure and retries with a growing wait.
- A runner can send an agent to check landed work after a deploy. Live evidence can complete the task or return it for repair, without asking the owner to check it. Set `TEDIX_LANE_VERIFY_HEALTH_URLS` on the runner to the space-separated health URLs of the deployed services it checks; each must report a full `deployedSha` that contains the landed commits.

## 0.23.0 — 2026-11-19

### Minor Changes

- `tedix lane serve` has no slot limit any more: it starts every ready Work Item it may take, and the `--max` option is removed. Saved runners and old LaunchAgents drop the value automatically. This version needs a Tedix server that no longer expects slot counts in a runner's health report.

## 0.22.2 — 2026-11-19

Not published on its own: its build failed on five out-of-date tests, so these changes first shipped in 0.23.0.

### Patch Changes

- A runner keeps renewing its hold on a task while Git prepares, cleans or inspects a checkout. Renewals no longer wait behind other reads or other runs.
- Checks of local tools and of results run in the background, so they cannot delay a renewal. Repeated checks are cached, and Devin sign-in is checked only on runners that serve Devin.
- Before stopping an agent at a deadline it remembered, the runner asks the server whether the task is still held, so one lost reply does not interrupt a live run. It stops promptly when the server refuses a stale hold.
- Codex runs that fail with a dropped stream or a broken pipe are retried, with the runner's existing backoff and its limit on identical failures.
- Codex runs must write their result to a file in a fixed format. A missing or invalid result, or one that does not match the task, fails the run with a clear reason. Other executors are unchanged.
- `tedix lane serve` no longer counts an ended run against its capacity when that run's process ID now belongs to an unrelated process. Before, such leftover runs could fill every slot and stop new Work from starting.
- Creating, accepting or reassigning Work sends the executor as a kind and an ID.
- Retired command aliases, the credential-cache fallback and response handling for older servers are removed. Obsolete work scopes are rejected. Use `tedix who` to see who is working on a file.

## 0.22.1 — 2026-11-18

### Patch Changes

- A runner no longer marks a task done when its commit never reached main: it checks each commit against `origin/main` before it settles or recovers a result.
- A task that is already satisfied on main can be closed with an existing CI run named "<workflow> @ <sha>", or a newer successful run of the same workflow that contains it. A deploy gate does not count as test proof.
- When a task that is not about CI is already done on main, the runner now says how to report it (`landed_unverified` with `existingCommits`) instead of leaving the result pending.
- Assigned Work is routed by both the kind of executor and its ID, so a person, tedi, team or organization is never mistaken for a local agent with the same ID.
- When a runner pauses new Work to restart onto an updated CLI, it says so, and names the processes and Attempts that hold the restart back. Run folders it cannot remove no longer stop it taking Work while slots and disk space are free.
- When the run-folder limit cannot be met, each retained folder is listed with its own reason.
- A runner keeps a run folder as soon as the system reports a process working in it, without waiting for a full process scan, and waits for pending process checks before it shuts down.

## 0.22.0 — 2026-11-17

### Minor Changes

- c1aac9d: Add a read-only capture check that compares recent local host chats, the retry outbox, and stored session events.
- fdc0f0e: Lane results can cite a commit and successful CI run in another repository under the dispatcher's GitHub owner. The dispatcher verifies the commit's target-main ancestry and latest successful workflow run before settling the Work.
- 617663e: A runner no longer fails and repeats a run that found its task already done. A result can name the earlier commits on main in `existingCommits`; the runner checks them and records the run as succeeded. A passing network or server fault while a Devin result is saved is retried and no longer starts the session again.
- 747f8a0: The supervisor reports its own heartbeat every 20 seconds, so Work > Map shows it as down within a minute when it stops or its sign-in fails.

### Patch Changes

- 44e9c15: `tedix code` explains a namespace that is undefined because the call ran for a different target: a call for one organization uses that organization's own names (`work.*`), a Connect call without an organization uses `<organization>_unified_<app>`. `tedix code --help` states the rule, and `tedix work --help` says who answers for Work created without `--owner`.
- ba4b53f: With decision capture enabled, a message typed wholly inside a code block or a tag pair, or a short request under a long pasted log, is no longer dropped: a shortened, redacted copy marked as filtered is uploaded so the request can still be recorded.
- 0b74881: Prune inactive runner receipts after a newer revision of the same Work item supersedes them.
- e4a2bc0: Background runners can recover a landed commit from its admitted cancelled Attempt while still rejecting a live peer's commit.
- 7677eaa: `tedix work settle` accepts `--outcome rejected` for a run that finished and declared the accepted outcome incomplete. The server never reruns a rejected Attempt on the same Work revision, while crashes (`failed`, `expired`) still retry within the lane policy's `maxAttempts`. The local dispatcher no longer holds Work on its own count of failed Attempts.
- 8f33a8c: With decision capture enabled, a typed message or agent turn is saved to the local session-events outbox before the sign-in check, so a slow or failed check no longer loses it; the next hook uploads it.
- 8696aa5: The local session-events outbox no longer stalls or loses events silently. When an upload fails, events are retried one by one; an event the server rejects three times while taking others moves to the outbox's `rejected/` folder instead of blocking newer events. Session start now uploads events an earlier chat left behind. Very long turn text is cut to 500,000 characters, keeping its start and end. `outbox.log` in the outbox folder records every event set aside or trimmed.
- b961f78: Lane dispatchers and the Lead supervisor briefly retry process identity capture after spawning, so Linux runs remain recoverable when `/proc` has not exposed the child's command line yet.
- 55189ec: Work tools gain two owner/admin undo operations: `restore_work_filing` puts a Work Item's project, objective, class and exception expiry back exactly (nulls included), and `detach_work_case_item` removes an epic attachment without touching the Work.

## 0.21.21 — 2026-11-16

### Patch Changes

- 3ed138c: Background runners (`tedix lane serve`) land finished work sooner, keep their task startable while they check a result, and no longer crash on a run that declared no result.

  - The brief now tells the agent how to land a change: run the type-check and the focused tests of what it changed, then push with the repository's own push command (`bun run push` where the repository has one). It says not to run a whole workspace's or the whole repository's test suite locally unless the task asks for it. If the push is refused, the agent copies the one-sentence reason to the task and ends the run. Before, runs waited on full local suites until their time ran out and never pushed.
  - When a run ends with commits that are not on main, the result recorded on the task starts with how many, which ones, where they are kept and the reason the run gave. Later holds on the task and the next run's brief repeat that reason.
  - The runner keeps renewing a run's lease while it checks the result. Before, the renewal stopped when the agent finished, and a slow check could pass half the lease. Tedix then recorded the run as stopped and took the task off the list runners read.
  - A run that cited an earlier commit without declaring a result ended with `TypeError: undefined is not an object (evaluating 't.workItemId')`, three times in a row, and the task was held. Such a run is now checked like any other: an earlier commit of the same task counts when its original run vouches for it, and otherwise the task says that no result was declared.
  - If the runner itself fails while checking a result, the note says so and keeps what the agent reported.

## 0.21.20 — 2026-11-16

### Patch Changes

- 4ba27ff: Epics have a new kind, `delivery`, for a feature or another result due by a date. Pass `"kind":"delivery"` to `tedix work case-create`; `tedix work --help` now lists every epic kind. Existing epics keep their kind.
- a629a18: Work commands and background runners keep working when Tedix Cloud is newer than the installed CLI. The CLI now checks each call against the schema the server publishes for the tool instead of refusing with "Native Work schema is stale" whenever that schema differs from the copy built into the CLI. If the server rejects a field the CLI sends, or requires one it does not send, the error names the field and suggests running `tedix update`.
- 76e5603: Background runners (`tedix lane serve`) free disk they could not free before, and keep track of finished commits that did not reach main.

  - A run folder whose checkout was already removed is archived. Before, the runner asked Git to read the missing checkout on every pass and logged `git cannot read the checkout` for it forever. The registration a removed checkout left behind is released, so the next run gets the same path instead of a `repo-2` copy.
  - When the runner is over its disk cap, it now also removes checkouts that an earlier try of the same task left behind, and checkouts the ordinary cleanup had refused. Their commits and uncommitted files are saved first under `refs/lane-evicted/<run>/<checkout>`. A leftover folder that Git no longer knows is saved the same way before it is deleted.
  - The reason `git cannot read the checkout` now includes what Git reported.
  - When a run commits a change but cannot push it, the runner keeps the checkout and its commit list on record through later holds and failed starts. The hold on the task names those commits and where they are. The next run of the task is handed that checkout, or the Git ref that saved it. Before, a held task forgot the checkout, and the next run started from a clean copy of main.

- 38ce78f: Background runners (`tedix lane serve`) no longer park a task silently. When a runner stops starting a task until someone changes it (three failed runs, a result already recorded for that version, or a finished run that Tedix refused to complete), it now records the hold on the task with a one-line reason and sends one request to the task's accountable owner. Tedix shows the task under Stuck on the Work page and stops offering it to runners; editing the task makes it ready again. Tasks that were already parked before this release are recorded the same way, a few per pass.
- f93d938: Background runners (`tedix lane serve`) accept a new result, `landed_unverified`, for a change that is on main but whose result the agent could not confirm (a failed check, or a deploy or production it cannot read). The run counts as succeeded with its commits and the task is not started again. The runner records a hold on the task and sends its owner one request to check the result; the owner completes the task, or edits it to have an agent work on it again. Before, agents reported such a run as a wait and the runner ran the task again every six hours.
- 802cbd8: Work, Deck and Feed reads no longer fail when Tedix Cloud returns a field this CLI version does not know yet. The CLI ignores the new field and still checks every field it reads, so `tedix work list`, `checkpoint`, `attempts`, `evidence`, `events`, the interaction inbox, agent-turn triage and background runners (`tedix lane serve`) keep working between CLI releases. If the server stops sending a field the CLI needs, or changes its type, the error now names that field and suggests running `tedix update`.
- eba5eaf: A task can now wait for a date. `tedix work not-before <id> <time|clear>` sets or removes a task's start date (for example `2026-12-01`, UTC); Tedix does not offer the task to a runner before then and `tedix work readiness <id>` reports `not_before` with the date. An agent that finds nothing can be done before a known date ends with `outcome: "deferred"` and `notBefore`; the background runner (`tedix lane serve`) then sets that start date on the task and comments why, so no other runner starts it early. Before, such a task was started again and each run found nothing to do.

## 0.21.19 — 2026-11-15

### Patch Changes

- cff0e21: Tedix now accepts a Work Item only when it has a project, a done-when and an accountable owner, and says what is missing otherwise. `tedix lane serve --accept-proposed` leaves proposals without an accountable owner in triage instead of trying to accept them; file shift Work with `--owner`.
- e5ae619: Creating a task's checkout no longer stalls the runner or fails after 30 seconds on a large repository. The runner keeps working while Git creates the checkout and allows it up to five minutes. If it still fails, the half-made checkout is removed before the next try and the error shows Git's own message or how long it waited.
- 7dc4517: `tedix work --help` now opens with a plain description and lists every verb; the `health-list` and `health-record` verbs are removed.
- 47c9091: Devin lanes now find their own Tedix profile. When a workspace's shared agent profile belongs to another coding tool, the dispatcher stored the Devin lane's profile under a Devin-specific name, but the CLI inside the lane looked under the workspace name and reported "No external-agent profile is configured." Commands such as `tedix work context`, `tedix agent status` and Work comments now run under the lane's own short-lived credential, and the lane brief no longer suggests setting session variables by hand.
- ead0353: The runner now retries a task that waited more than once or that was cancelled because the runner was stopping. Before, a second "deferred" wait or a stop during start left the task held until someone changed it. A task that a person or the agent cancelled is still left alone.
- f90ed85: `tedix lane serve` now frees `runs/` space under cap pressure for checkouts idle for an hour (it was three days), after saving their commits and uncommitted files as a Git ref. When the cap still cannot be met, the log names each folder it kept and why (`checkout-held`).

## 0.21.18 — 2026-11-15

### Patch Changes

- 0d16662: Explain runner permission requests with the matched task sentences, agent, action and destination, what Allow records, and action-specific undo limits.
- 76b65cb: Make a Devin lane's Tedix commands use the lane's own credential. Inside the lane the CLI now selects the dispatcher-provided store instead of reporting "No Tedix MCP auth found".
- a150c36: Remove milestone commands and their native endpoint mappings from the CLI.
  Use epic controls (`case-*`) to group Work Items.
- 94be65c: A runner no longer spends up to five minutes on every sweep measuring a run
  folder that is too large to measure in time. One Work revision with 30
  checkouts hit the five-minute limit on each try. A folder whose measurement
  fails is now tried again after an hour, and its last known size is used until
  then.
- 9a94911: Avoid permission cards for quoted task history, internal policy revisions and
  measurement decreases. Retain permission request receipts across runner restarts
  so the same Work version and recipient are not asked again.

## 0.21.17 — 2026-11-15

### Patch Changes

- 31331b9: A runner with many retained runs no longer keeps a processor core busy while
  idle. Every ten minutes it measured the size of every run folder again, and it
  checked every checkout it could not remove again. Now a finished run is
  measured once and again only when it changes, the sizes survive a runner
  restart, and a checkout whose removal was refused is tried again after 10
  minutes, then 20, doubling up to 2 hours.

  The same sweep now also removes clean, landed checkouts that an earlier retry
  left beside the current one (`repo-2`, `repo-3`, …) and keeps only the newest
  100 folders in `archive/`. A checkout with uncommitted or unpushed work, or
  one a running or retained Attempt uses, still stays.

- d8d5aa7: A runner over its checkout cap now actually frees the disk. Until now it
  logged "evicting oldest first" on every sweep and removed almost nothing: a
  checkout with a leftover scratch file, or with a commit that reached main
  under another SHA after a rebase, counted as the only copy of someone's work
  and was kept forever. Two runners had grown to 200 GB and 370 GB against a
  10 GB cap.

  Under cap pressure, a finished checkout untouched for three days is now
  removed after its commits and a snapshot of its uncommitted files are saved
  in the runner's source repository under `refs/lane-evicted/<run>/<checkout>`.
  Recovery folders left by a failed checkout (`repo.orphan-*`) and folders Git
  no longer knows are deleted after three days. A run in progress, one awaiting
  proof and any checkout touched in the last three days still stay. When the
  cap still cannot be met, the log says how many folders refused removal
  instead of claiming eviction.

## 0.21.16 — 2026-11-15

### Patch Changes

- A runner on a busy machine no longer fails a task because the agent's `--version` check was slow. A check that takes longer than 5 seconds is tried once more with a 15-second limit. If that also times out, the runner waits and tries again later; the task is not counted as a failed start and is not held after three tries. The runner log records the slow check once as `executor-probe-slow`.
- The session and prompt hook no longer waits out a gateway rate limit before its organization check. While the gateway is rate-limited the hook skips the check and says "gateway is rate-limited until <time>; organization check skipped", instead of timing out with "organization could not be verified", which wrongly pointed at the login or organization.
- A coding task can finish with a local branch that is not pushed. Set `metadata.artifactKind` to `local_branch` and `metadata.artifactLocalBranch` to `{branch, baseCommit}`; the runner then checks the named commit, that it builds on the base commit, that the checkout is clean, and that the Attempt has a test report. Tasks without that setting still need landed commits.

## 0.21.15 — 2026-11-15

### Patch Changes

- Lane runners move to a newly installed CLI version by themselves. After `tedix update`, each runner takes no new task, lets its running tasks finish, then restarts, and the supervisor log says which version it now runs. A running task is never cancelled for an update.
- Runners and agents can read and answer task questions again after Tedix updates its task tools. The CLI used to refuse with "schema is stale" until it was updated; it now accepts the update when the tool definitions match exactly.
- Devin runners wait their turn before running pre-push checks, instead of running them at the same time as every other session.
- An OpenCode runner that approves its own permission ask is shown as working, not as an error.
- Pasting long text keeps the row count and cursor movement right when input arrives before the layout is measured.

## 0.21.14 — 2026-11-14

### Patch Changes

- Devin lanes get their own Tedix credential, so a Devin run can read and update its task from inside its sandbox instead of failing on the shared agents file.
- The supervisor sends runner health reports one at a time and retries a failed one, instead of sending all at once and timing out.

## 0.21.13 — 2026-11-14

### Patch Changes

- A task that was waiting on your decision or approval starts again once you answer, and the next run is told what you decided.
- A task assigned to one specific local agent now uses the model you configured for that agent, the same as tasks picked automatically.
- Work details no longer show the retired reviewer deadline. Current reviewer assignments are unchanged.

## 0.21.12 — 2026-11-13

### Patch Changes

- Lane runners stop retrying tasks that are stuck for a reason that won't change. A task whose current version already has a result waits until the task changes, and a finished run whose completion was refused stops asking to complete.
- Lane runners clear old holds instead of retrying them forever. Once every earlier run has expired or ended elsewhere, the task can start again. A run folder or agent session that no longer exists is set up fresh, with one clear log line, instead of failing on every pass.

## 0.21.11 — 2026-11-13

### Patch Changes

- Lane runners use fewer gateway requests for tasks that cannot start yet. A task its owner already allowed is no longer re-read on every pass while something else keeps it waiting. A task that keeps failing to start the same way is tried once every 30 minutes instead of three or four times.

## 0.21.10 — 2026-11-13

### Patch Changes

- Lane runners use far fewer gateway requests while tasks wait. A task waiting for its owner's go-ahead, and an earlier run that is still alive, were re-read on every pass; they are now read again after five minutes, or when the run's lease ends. This leaves more of your login's request allowance for chats, so they are paused less often. After an owner allows a task, a runner can take up to five minutes to start it.

## 0.21.9 — 2026-11-12

### Patch Changes

- A chat reply that could not be sent to Tedix is now kept until it is delivered or its question expires. Before, it was dropped after one failed retry, for example while the gateway was rate-limiting the login.

## 0.21.8 — 2026-11-12

### Patch Changes

- A question in Claude desktop's next-step box is now always captured. Before, a long closing message above the question could make the turn count as a status update, and the question and your reply were not recorded.
- Lane runners keep a finished run's working copy until its commits are on `origin/main`, even when the commits are already recorded on the Work item.

## 0.21.7 — 2026-11-12

### Patch Changes

- Decision capture now records a question that Claude desktop shows in its next-step box, together with the answer buttons. Before, such a turn was filed as a status update and your reply to it was never recorded.
- `lane serve` now says why it counts an agent program as unavailable: the check's exit status, signal or timeout, or the budget pause that stopped it. A passing check is reused for five minutes, so one slow start on a busy machine no longer drops a healthy lane.
- Lane runners free disk space once a run is finished. A run's working copy is removed when all its commits are on `origin/main` or recorded on the Work item, and kept copies stay under a cap (10 GB per runner by default; change it with `--checkout-cap-gb` or `TEDIX_LANE_CHECKOUT_CAP_GB`). A copy with a running job or unrecorded unpushed commits is never removed.
- The welcome banner now reads "platform for agents, apps, and work", and the `tedix update` success message no longer starts with an emoji.
- A project- or repo-scoped `lane serve --executor any-local` can run beside the per-agent runners without being stopped by the supervisor.

## 0.21.6 — 2026-11-10

### Patch Changes

- Devin lanes start work again. The dispatcher waits up to 30 seconds for Devin's login check, because newer Devin versions answer slowly when run in the background, and it now says when that check timed out instead of reporting Devin as logged out.
- When a lane's push waits a long time in the queue or its run is interrupted, the dispatcher records the unpushed commits and their working copy on the Work item, so nothing is lost and the work can be finished later.
- A lane whose finished commits were recovered after an interruption can now complete its Work item itself, without an owner stepping in.

## 0.21.5 — 2026-11-10

### Patch Changes

- A job waiting for a person is no longer stuck when its run timed out and the question was then cancelled or expired. The dispatcher looks at the job again and starts it, or asks a fresh question.
- A Work item is no longer held for a person after three tries that never reached the agent, for example because the dispatcher crashed or the working copy was missing. Those tries are recorded as dispatcher faults, and the item is retried.
- When the supervisor restarts the dispatchers, a dispatcher that is still preparing a job hands it back instead of starting the agent. The job keeps its try, and the new dispatcher picks it up.
- A restarted dispatcher can reliably stop an agent run left behind by the previous one. It keeps trying for a few seconds to record each new run's process identity, reads it the same way every time on Linux, and logs why when it cannot prove a stuck process is its own.
- A runner's log no longer grows without limit. Unchanged skip and wait reasons are logged once an hour, `dispatcher.log` rotates past 4 MB, and the supervisor trims each runner's log past 8 MB, marking where older lines were dropped.

## 0.21.4 — 2026-11-09

### Patch Changes

- Owners can now give a job one more try. Run `tedix work attempt-grant <id> --input '{"attemptId":"<failed try>","reason":"<why>"}'`, naming the failed or timed-out try it replaces. Tedix records who approved it and why, and each try can be replaced only once. Agents cannot grant tries. Runs that paused, because they were deferred or waiting for a person, no longer use up a job's tries.
- A job waiting for a person no longer stays stuck when that question was cancelled, expired, or belonged to an older version of the job. The dispatcher looks at the job again and asks a fresh question if it still needs someone.

## 0.21.3 — 2026-11-09

### Patch Changes

- When a review or check agent finishes and reports that the work is not done yet, the dispatcher no longer runs it again on the same unchanged work. It holds the item and leaves a comment, so the repair happens first and the remaining try is saved for the repaired version. Coding jobs still get one rerun, because they continue from the change they already made.

## 0.21.2 — 2026-11-09

### Patch Changes

- The dispatcher now locks each agent's working copy until it has collected
  proof of the result, then removes it itself. An agent that tidies up its
  own working copy can no longer make finished work fail.

## 0.21.1 — 2026-11-09 (not published)

The release build failed before anything was published; 0.21.2 ships this
change.

## 0.21.0 — 2026-11-08

### Minor Changes

- `work create` and `work delegate` accept `--parent <work-id>` to keep
  related Work together in the same project. Delegation reuse checks the
  originating session, destination, project and parent, and only the
  originating session can settle its delegation.

### Patch Changes

- Runners record progress when a pass and each gateway call start, so a slow
  first call no longer makes the supervisor stop a runner during startup.

## 0.20.0 — 2026-11-08

### Minor Changes

- A runner with nothing to do can now take work that another runner has not
  been able to start for 15 minutes, and Tedix says why on the Work. Work held
  after repeated failures, Work waiting on a person, and Work that needs a
  specific tool are never moved. Runner health reports now show what is keeping
  each runner idle, so the Activity view can display it.

### Patch Changes

- Runners retry reads that fail while Tedix is busy, with random pauses and a
  single logged time limit. Writes are not resent.
- A runner whose sign-in is rejected during a heartbeat refreshes it once and
  keeps the same run.
- A Devin run starts a fresh session when its recorded session is open in
  another process, instead of stopping that process.
- Runner health shows how many items are on hold and how many runs were
  stopped by the lease guard, and keeps the counts across restarts.
- A run whose lease ran out while its result was kept is restarted
  automatically. It counts as an interruption, not a failure, so it no longer
  moves the item toward the three-failure hold.
- A run that finished and delivered its result no longer fails because the
  agent's last message lacked the result block. The runner reads the outcome
  from a commit on main or from the result comment the run posted. A run with
  no such evidence still fails.
- `tedix lane serve` cleans up run folders nothing refers to and stops taking
  new work when free disk drops below 10 GB.
- Runs left behind by a stopped process are recovered so the Work can be
  retried.

## 0.19.12 — 2026-11-07

### Patch Changes

- `tedix lane serve` no longer settles a waiting lane as a failed Attempt.
  When an agent reports its Work is waiting on a date, an approval, a person
  or production access it can declare `outcome=deferred` with the reason and
  an optional recheck time. The Attempt settles as cancelled and the runner
  revisits the Work after the wait, so these items no longer pile up on the
  three-failure hold.

## 0.19.11 — 2026-11-07

### Patch Changes

- `tedix supervise` no longer restarts a runner whose pass is slow but still
  making progress. A long pass over many items used to be stopped partway and
  started again from the top, so items further down the list were never
  started.

## 0.19.10 — 2026-11-07

### Patch Changes

- a43ecdc: `tedix lane serve` now settles a lane succeeded when the Work's fix is already on `origin/main` and was landed by any admitted Attempt on that Work, such as an interactive session or an earlier dispatch, instead of failing with "No landed commit SHA". A refused commit is logged as `custody-rejected` with the reason.

## 0.19.9 — 2026-11-07

### Patch Changes

- Login renewal keeps a refresh token fenced after an HTTP error or malformed
  reply, because the issuer may already have rotated it. Only a proven
  pre-connect failure retries the same token. Recovering a lost successor
  without sign-in still requires issuer support.
- Parallel runners cache credentials separately for each agent session, so
  they no longer force one another to exchange credentials before every Work read.
- Permission cards name the agent and task and explain Allow, No and Later.
  Allow records permission for the current Work version with an editable scope.
- `tedix supervise` keeps a Mac awake while it runs. Closing the lid on battery
  still puts the Mac to sleep.

## 0.19.8 — 2026-11-06

### Patch Changes

- `tedix supervise` restarts a lane runner that stops working. About four
  minutes after a missed pass it stops the runner, starts a fresh one and
  writes the reason to `~/.tedix/supervisor.log`. The new runner picks up work
  the old one left running, so a stuck runner no longer holds up queued Work
  for an hour.
- A runner that is shutting down waits at most two minutes for running work,
  so its replacement no longer waits behind a whole model turn.
- Slow login renewals get up to a minute and one retry when no connection
  opened. If a shared runner's login can't renew safely, the supervisor tells
  the owner once, even when the gateway is down.
- Devin runners keep their declared result through the final check, so
  finished Devin work settles with the right commit.

## 0.19.7 — 2026-11-05

### Patch Changes

- Local runners no longer fail Work that its owner edits while the runner is
  getting it ready. The runner checks the Work again just before starting and
  waits for the next pass if it changed, so one early edit no longer leaves the
  Work failing on every later start.
- When a runner skips Work because it may need a person to authorize it,
  `tedix lane serve` asks the Work's owner in Tedix OS, with the exact
  Delegation comment to add. It asks once and never adds the delegation itself.
- OpenCode runners report provider progress separately from their heartbeat,
  and safely restart a turn that went silent before using any tool.
- Runner worktree cleanup no longer stops the dispatcher when a busy Mac makes
  its process check stall, and commit checks use fewer git calls.
- Database, credential and approval errors are shown as they are, instead of
  suggesting that a tool is missing.
- New `tedix lane remote-job send` and `receive` steps for controlled email
  jobs, and a safe way to inspect an uncertain email job without sending again.

## 0.19.6 — 2026-11-04

### Patch Changes

- `tedix lane serve` no longer skips Work forever after a brief server error
  while starting it. Once the retry time passes, it picks up the Attempt that
  already started, or starts the same Work again.
- Dispatcher settlement can accept an installed app revision as delivery proof
  when no repository commit applies, after reading back the workspace, app and
  revision.
- Devin lanes get scoped Work context and read back their result safely through
  the existing dispatcher, with host credentials kept outside the sandbox.
- Runner results can include the full commit SHA and short evidence links;
  landed commits are still verified before the Work settles.

## 0.19.5 — 2026-11-04

### Patch Changes

- `tedix lane serve` now finishes saving a run's result after a brief server
  timeout. If the save is cut off, the dispatcher retries it the next time that
  Work comes up, and once the old Attempt is confirmed expired it starts the same
  Work again without needing a new Work version. A failed read now waits and
  retries instead of stopping the whole pass.
- With status reporting turned on, local hook and supervisor activity now shows
  on the Office timeline. It stays separate from reply delivery, acknowledgement
  and Work completion.

## 0.19.4 — 2026-11-03

### Patch Changes

- Preserve Devin's full response so its accepted-outcome declaration reaches the dispatcher after the Work note is delivered.
- Require an explicit full accepted-outcome result before a dispatcher marks Work completed. Keep partial and undeclared results open even when a process exits successfully or lands a partial commit.
- Let queued dispatcher admission reads progress during sustained lease-renewal traffic, while keeping renewal priority and serialized calls.
- Prioritize final lane reports and Work settlement and completion alongside heartbeats, ahead of queued background reads. Keep existing permission and Attempt checks.
- Stop asking research sessions to emit a special result marker that rejects ordinary completed findings. Keep the existing human-wait and CI-recovery validation checks.
- Clarify that hook Work suggestions do not require the CLI: prefer authenticated MCP for remote operations, retain admission and identity checks, and use the CLI for local integration or compatible CLI-managed Attempts.
- Verify hook organization context without starting a Code Mode sandbox.
- Keep a chat's explicit Connect selection tenant-bound over ambient session scopes, and skip organization-less historical scope rows instead of letting them poison or misreport the routed organization.
- Explain that agents can complete their own successful non-coding verification Work without a code commit. Coding Work still requires a commit, and accepted credential, payment and external messaging actions remain owner-only.
- Stop automatic execution after three failed or expired Attempts on the same Work revision, even when summaries differ or runners restart. Resolve the blocker and revise the brief before retrying; other eligible Work continues.
- Keep ordinary Claude replies free of repeated Stop notices. Show Work focus as plain prompt context when the selected task or purpose changes, with daily reminders for missing objectives or overdue dates and no cut-off words.
- Retain cited same-Work landed commits during lane recovery when canonical
  Attempt receipts verify their original session and admission interval. Keep
  current Work contract and live Attempt fences, and preserve original custody
  in settlement metadata.
- Retry held admissions after their retry window expires, using current readiness and a fresh Attempt. Reconcile queued legacy successes through their original executor, keep active and unknown Attempts fenced, and recognize publish-boundary refactors as code work.

  Start workers that already hold an admitted Attempt without waiting for optional activity reporting.

- Keep runner and Lead duty status across supervisor restarts, retain restart delays, and verify retained process identity before adoption or shutdown.
- Report persisted supervisor duty status alongside existing lane observations, including Lead cadence, retry times and recorded restarts.
- Report current tasks, known check and retry times, and confirmed Work completions
  in supervisor health. Keep executor names configurable and preserve unknown
  activity for older reports.
- Isolate renewal tests from the user's credential journal and label test renewals.

## 0.19.3 — 2026-11-01

### Patch Changes

- Keep your team's automatic executor and model choices in an explicit routing file. Without that configuration, automatic assignments wait before launching an agent. Named assignments retain their native defaults; OpenCode requires a configured model.

## 0.19.2 — 2026-11-01

### Patch Changes

- Retain existing human Interaction waits across runner restarts and Work edits. Add an explicit verified preexisting CI recovery result without treating old commits as newly authored changes. Preserve normal coding proof, admission and completion fences.
- Wait for a predecessor runner to finish active Work during supervisor reinstall instead of exiting and triggering restart backoff.
- Retry transient renewal responses without fencing the login, record redacted HTTP diagnostics, and raise one machine-specific sign-in Decision while an uncertain login can still use its valid session token.

## 0.19.1 — 2026-10-31

### Patch Changes

- Keep the supervisor's runner records out of the runner's own directory. 0.19.0 wrote them there, and the runner read them as broken Work receipts and held new admissions; 0.19.1 stores them under `~/.tedix/supervisor/runners/` instead.

## 0.19.0 — 2026-10-31

### Minor Changes

- One background service per machine. `tedix supervise` now runs your runners, the processes that pick up accepted Work for one executor each (Codex, Claude Code, OpenCode or Devin). `tedix lane serve --install` records the runner in `~/.tedix/supervisor-runners.json` instead of creating a service of its own; the supervisor starts it, restarts it after an exit with a growing wait of at most 15 minutes, stops it when you remove it, and leaves one alone that is still running from before a supervisor restart. `tedix supervise install` takes over runners installed as their own services and removes those. `tedix supervise runners` lists them with state, process id and log.
- The supervisor can run a recurring Lead pass: every 20 minutes by default it continues one of the conversations named in `~/.tedix/supervisor-lead.json`, trying the next executor when one fails or cannot sign in, never overlapping passes. The executor used and any fallback appear in `supervisor.log` and in dispatcher health.

### Patch Changes

- Runners keep working through local limits: known quota pauses and backoffs retry on a bounded schedule instead of holding Work for good; native-session preparation and session-start timeouts do the same; Codex can route with low or zero reported allowance so backup credits are used.
- Runner results are safer: Devin result notes travel through the admitted dispatcher without credentials; an incomplete result or a delivery error counts as failure, not success; detached worker output lives in private temporary files so a crash cannot close it; result notes starting with a dash survive settlement; an OpenCode stats probe that ignores its timeout is terminated.
- Lost replies are recovered: a successful settlement whose reply was lost is closed after checking the Work's current revision and latest Attempt; a lost admission response is recovered from its exact session; expired results need fresh admission instead of staying stuck.
- Health and occupancy are honest: each runner's running state, last admission, occupied slots and repeated failure reason are published through `tedix supervise`; last admissions survive restarts and log rotation; preparation counts as occupancy; the dispatcher parent and settled receipts with reused process ids no longer consume slots; retained completion and telemetry failures appear in health.
- Shutdown and restarts are cleaner: the dispatcher drains workers without forwarding termination to them; expired native workers are recovered after their launcher replaced itself; an interrupted task keeps its checkout across retries; dispatcher-created Codex sessions resumed headless do not wait for an interactive reply.
- Sign-in: a saved access token is confirmed after an uncertain renewal without replaying a rotated refresh token; a newer saved login is adopted; rejected access pauses local runners with one sign-in Decision. `tedix login` passes the organization identifier unchanged.
- Smaller fixes: temporary catalog admission refusals are retried before any tool runs; Connect agent Work context stays bound to the selected organization; Work completion is requested after a successful settlement and retried when denied; older receipt filenames are validated and unreadable ownership data is reported; health reports go through the deployed dispatcher namespace.

## 0.18.5 — 2026-10-29

### Patch Changes

- Devin lanes preserve the selected organization so tasks run instead of opening onboarding. Failed and expired tasks back off, and three identical failures hold that Work revision even after a dispatcher restart.
- The supervisor skips unavailable session checkouts so a deleted directory cannot block answer delivery to other sessions.

## 0.18.4 — 2026-10-29

### Patch Changes

- Let the supervisor resume sessions in Documents and other protected macOS folders when access is granted. Check actual access with a short timeout instead of rejecting every protected path.

## 0.18.3 — 2026-10-29

### Patch Changes

- Local dispatchers can finish tasks that explicitly request a versioned organization skill result using evidence from that Attempt. Repository changes still require a landed commit.
- Let the supervisor resume Devin without an interactive workspace trust prompt. This resume bypasses the trust check and keeps existing permissions and sandbox settings.

## 0.18.2 — 2026-10-29

### Patch Changes

- Local dispatchers check for ready work before cleaning up old runs. Cleanup preserves unfinished work, settled failures can retry without a Work edit, and checkout progress no longer overflows process buffers.
- Devin lanes keep their dispatcher-provided Tedix CLI identity and leave the shared plugin sign-in unchanged when creating or resuming a session.
- The supervisor can wake bound Devin and OpenCode Lead sessions, preserving their native session IDs and delivery receipts. It leaves busy sessions to their hooks, reads context and sign-in state locally, and reports checkouts blocked by macOS privacy protection.

## 0.18.1 — 2026-10-28

### Patch Changes

- Devin tasks started by `tedix lane serve` now get the project's dependencies installed before Devin starts, so they can run checks and push their finished work. If the pre-push checks crash because a module is missing, that no longer counts against the push retry limit.

## 0.18.0 — 2026-10-28

### Minor Changes

- `tedix agent start` no longer creates an "External agent …" API key. A new agent gets its own M2M identity, limited to the MCP tools it may use, and that identity opens its sessions and runs its Work. Profiles that still carry an API key keep working in this release; the next minor release stops accepting them, so run `tedix agent start` again on each machine and revoke the old key.

### Patch Changes

- Notices from Home and delegated tedi runs reach the Claude or Codex session that started them.
- Sessions keep their established profile workstream when they are regrouped. "Your week" is built from dated session activity with exact sources, not from unverified model claims.
- Generated Code Mode arguments escape script-closing tags and Unicode line separators for Home reads, flows, skills, external-agent calls and result paging.
- Concurrent CLI processes wait less for the credential lock, so credential writes no longer stall.
- `tedix work --help` calls cases epics, matching Tedix OS. The `case-*` commands are unchanged.
- Local executor briefs include matching approved lessons before launch, without relying on host hooks.
- Owners can enable Tedix OS for an existing organization through the `complete_os_onboarding` tool in Code Mode with app-write scope; platform administration is no longer required. Active owner membership is still required.
- Local hook processes share pre-tool lesson catalog reads for 30 seconds, reducing owner gateway traffic while keeping prompt-time lessons live.

## 0.17.12 — 2026-10-27

### Patch Changes

- `tedix lane serve` no longer holds code Work just because its text mentions consent, credentials, tokens, sign-in, sending, publishing or deleting. A lane asks for the owner's Delegation comment only when the item tells the executor to do a human-reserved act itself: grant or revoke consent, issue, rotate or enter credentials, pay, send an outside message, publish, delete live data, sign an agreement or change a live customer's settings. Prohibitions such as "no consent, payment or publication" do not count as requests.
- `tedix lane serve` still holds such an act when it follows an urgency idiom ("do not wait — send it to the customer"), is written in German, uses a synonym ("wire money", "post on LinkedIn", "push the secret", "drop the table"), is stated as an outcome ("done when the invoice is paid"), or hides the verb behind look-alike or invisible characters.
- `tedix logout` revokes the stored sign-in at the authorization server before removing the local login, and warns when it cannot. The Descope AIH drift audit reports each resource's token lifetimes and flags wildcard client-metadata domain policies.
- Task boundaries show the selected Work, its active objective, success signal and days left, with a dated parking prompt when no active objective applies.
- Help text calls the Feed "Activity" and the Deck "Decisions"; `tedix flow` says "automation" instead of "workflow". The `tedix feed`, `tedix deck`, `tedix flow` and `tedix workflow` commands keep their names.
- CLI help describes Tedix as a platform for agents, apps, and work, and tedis as agents.

## 0.17.11 — 2026-10-26

### Patch Changes

- Local agent dispatchers take Work again. Since 0.17.10 they skipped every Work Item because they read the short `tedix skill show` preview of their standing rules; they now read the rules in full.

## 0.17.10 — 2026-10-26

### Patch Changes

- A Claude Code session that an older CLI saved under a Codex-named identity now uses its own Claude identity, so `tedix agent start` and `tedix work start` work without borrowing another agent's name.
- Cloud agent setup for Claude, Codex and Devin uses one shared bootstrap command.
- `tedix skill find`, `tedix skill schedule` and `tedix skill edit` let you search skills, see when one runs next, and update its files. `tedix skill list` shows long lists in full, and `tedix skill inspect` shows failed steps first.
- `tedix skill show` prints a short summary instead of failing on large skills; `--file` prints one file in full.
- `tedix work create` accepts `--description` and `--owner`.
- `tedix work move <id> --project <uuid>` moves a Work Item to another project (owners and admins).

## 0.17.9 — 2026-10-26

### Patch Changes

- When a chat starts, the agent opens its own session on its first Tedix call, so audit records name the exact agent and model.
- `tedix work --help` shows `--project <id>` for listing one project's Work.
- `tedix work neighbours` and `tedix work who` point you to `tedix who --paths <files>` instead of failing.

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
