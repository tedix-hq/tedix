Tedix 0.2.2 — the session preflight needs Tedix CLI 0.8.17 or later.

The opt-in `SessionStart` preflight now checks the installed CLI first. An
older CLI gets one line naming its version and asking you to run
`tedix update`, instead of running a preflight with the organization-slug and
Work heartbeat bugs that CLI 0.8.17 fixed. The other hooks are unchanged.

Tedix 0.2.1 — the prompt hook gets a 30-second safety net.

The `UserPromptSubmit` context hook (`tedix hooks prompt-context`) now
declares a 30-second timeout instead of 15, so a slow gateway no longer makes
Claude Code discard its output. The CLI side of the same fix (Tedix CLI
0.8.4 or later) reads its sources in parallel and caches the slow-changing
ones for ten minutes, so a turn normally takes well under five seconds.

Tedix 0.2.0 — a version number no earlier release used.

Claude Code caches a plugin by its version. Machines that had installed an
earlier 0.1.x series kept those old files under the reused 0.1.0 and 0.1.1
numbers, so they ran an old prompt hook or none. 0.2.0 ships the 0.1.1
content under a new number, so every install refreshes.

Tedix 0.1.1 — hooks stay silent without the Tedix CLI.

Every local hook now exits immediately, with no output, when the `tedix`
command is not installed. The install guides describe each hook, when it runs,
what it sends once opted in, and how to turn it off.

Tedix 0.1.0 — first public preview of the Tedix plugin.

Connect ChatGPT, Codex and Claude Code to an authorized Tedix organization
through the shared Tedix gateway. Bundled skills guide connection checks,
scoped Work reads, governed task handoff, tedi delegation and Workspace Output
workflows. Each operation remains subject to the account's actual grants and
organization policy; installing a skill does not enable writes or grant
execution authority.

The public package uses one canonical Tedix identity, onboarding guidance and
light/dark brand assets. It contains no local lifecycle hooks, credentials or
copied tokens. Local lifecycle hooks are a separate local install: they run in
the installed Tedix CLI (`tedix hooks <name>`) and are opt-in.

Tedix Cloud is an invited beta; using the plugin requires an account in an
organization you have been invited to. Version numbers stay below 1.0 while
the plugin and its gateway contract may still change.
