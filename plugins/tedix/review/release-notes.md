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
