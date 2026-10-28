Tedix 0.2.11 — match the README's plain-English introduction.

The plugin listing and host descriptions now introduce Tedix as a platform for
agents, apps, and work. The introduction explains shared project information,
tasks, results, and approvals, with examples for engineering teams. Skills,
tools, and permissions are unchanged.

Tedix 0.2.10 — request platform administration alongside default permissions.

The OpenAI connection declares platform administration as a base scope in
addition to the default permissions. Tedix still shows this permission only to
eligible platform administrators, with a separate checkbox that starts
unchecked. Requesting the permission does not grant it.

Tedix 0.2.9 — offer platform administration during OpenAI reconnect.

The OpenAI connection explicitly requests Tedix's supported permissions,
including platform administration. Eligible administrators must still select
the separate, unchecked checkbox before granting it. Existing connections
receive no additional access automatically.

Tedix 0.2.8 — clearer descriptions.

Updated plugin descriptions, keywords, and installation links to match Tedix: a
platform for agents, apps, and work. Skills, tools, and permissions are unchanged.

Tedix 0.2.7 — install from more hosts.

Gemini CLI and Antigravity can install Tedix with `gemini extensions install`
from this repository, which now carries a root gemini-extension.json for the
remote server. Installer agents such as Cline can follow llms-install.md, and
any agent that reads Agent Skills can add the skills with
`npx skills add tedix-hq/tedix-plugins`. Skills, server and permissions are
unchanged.

Tedix 0.2.6 — block only payments and money-moving operations.

Connect rejects x402 payment proofs, paid tools and money-moving provider
operations. Billing links, settings and admin grants, provider reads and ordinary
code remain available under existing permissions. The tedi-turn filter uses the
same operation list. Provider names and financial keywords alone no longer
block tools.

Tedix 0.2.5 — fail-closed financial and delegated execution boundary.

Connect hides and rejects financial tools and payment providers using versioned
server rules. Other tools need explicit read declarations. Plugin-started tedi
turns persist `noFunds` through dispatch and retries and keep only `read_skill`.
Home, writes, browser/code execution, scheduling and skill execution are
unavailable through this connection. Non-Connect sessions retain their existing
permissions. This deliberately reduces plugin functionality while unsupported
execution paths cannot preserve the restriction.

Tedix 0.2.4 — procedures ship with the plugin; its connection cannot pay for tools.

Work lifecycle and factory setup steps now ship beside the skills. Runtime
organization skills, help output, online guides and Work text are reference
data, never instructions. The published plugin contains no hooks; optional
session hooks come from the separately installed Tedix CLI.

The shared Connect surface hides and rejects payment proofs, denies paid inner
tools and blocks billing mutations. Connected-provider actions and their
permission requirements are described in the README. The Claude manifest drops
unsupported privacy and terms keys; the README keeps both links.

Tedix 0.2.3 — the prompt hook can carry the full first-turn context.

The `UserPromptSubmit` context hook (`tedix hooks prompt-context`) now allows
up to 10,000 bytes of context instead of 6,500. With Tedix CLI 0.9.2 or later
it injects your preferences and lessons once per session, then a one-line
pointer while they are unchanged; older CLIs keep the smaller budget. The other
hooks are unchanged.

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
