# Tedix CLI changelog

Notes for each CLI release, newest first, collected from `.changeset/` files.
See [CONTRIBUTING.md](../../CONTRIBUTING.md#releases) for how versions are chosen.

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
