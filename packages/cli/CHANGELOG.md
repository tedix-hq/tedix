# Tedix CLI changelog

Hand-written notes for each CLI release, newest first. See
[RELEASING.md](../../RELEASING.md) for how versions are chosen.

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
