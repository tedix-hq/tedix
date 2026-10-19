---
name: tedix-connect
description: Connect an agent host to an existing Tedix organization and verify workspace, identity, scopes, and a live read-only call. Use for first use, reauthentication, or connection diagnosis, not for routine tasks after access is working.
---

# Connect to Tedix

Use this when the user wants to connect Tedix or a Tedix operation fails before
the task can start. Do not treat an installed plugin, saved login, or visible
tool name as proof that the task's call is authorized.

1. Prefer the authenticated Tedix plugin connection. A shell or installed CLI
   is not a prerequisite. Honor an explicit user surface or repository policy
   requiring the CLI; in that path run `tedix -w <workspace> auth status`.
   Keep the requested organization. Multi-organization Connect exposes selected
   gateways under organization namespaces; a CLI profile is not an OS Workspace.
   If several organizations fit, ask which one before choosing a target.
2. If the plugin is disconnected, use its host-provided Connect/reconnect action
   and Tedix OAuth flow. Explain the organization and capability needed for the
   task; the owner reviews consent. Initial CLI authorization belongs in a
   human terminal outside the agent harness; an existing CLI grant can refresh
   without a browser. A connected chat does not provision its cloud sandbox.
   Never request, print, copy, or store a token, cookie, or password. For access
   changes, use the host's connection management and fresh consent; do not invent
   a Tedix management URL or claim a reauthorization changed every tool.
   After connection, use the authenticated `get_profile` tool when available
   to verify the account label. Its opaque ID identifies the current credential's
   owner; it does not select an organization or grant a capability. Verify the
   selected organization separately through Code Mode runtime/discovery. Never
   infer the actual account from a stale host nickname or another connection.
3. Discover a tool for the user's actual task through `discover.search()` (or
   `discover.list_namespaces()` when the domain is unknown). Request
   `includeParameters: true` for the exact callable, then make one bounded
   read-only call with that namespace. A successful discovery alone proves
   less than a successful authorized call.
4. Report the selected workspace, credential _kind_, relevant scopes, the
   callable tested, and what its result proves. Keep credential values out of
   the answer. For Work execution, continue with `tedix-resume-work` and the
   separate external-agent identity required there. In an MCP-only owner
   connection, discover `start_external_agent_session_for_host`, use the actual
   host/model tuple, and retain its returned session ID as `agentSessionId` on
   subsequent Code Mode calls. This owner-asserted session grants no independent
   review authority. A shell sandbox needs its own credential path below.

If the CLI is absent, continue through the native plugin connection. Suggest
[CLI installation](https://docs.tedix.dev/cli) only when local repository
recovery, shell automation, or a repository policy needs it. If login needs browser consent, pause for the owner. If the
workspace is wrong, use `-w`; if a scope is denied, name that scope and use
normal owner/admin grant flow. If the gateway is unreachable, report the
observed endpoint and error without treating it as expired authentication.
Do not mutate production merely to prove connectivity.

For a shell-only cloud agent, distinguish missing enrollment from expired
access. The existing gateway `POST /external-agents/session` exchanges an
operator-bound API key or exact GitHub Actions OIDC assertion for a short-lived
MCP credential and immutable session. Use it only when the operator already
provisioned the binding and a secure secret handoff. Repository access alone is
not an OIDC assertion, and a raw `sk_*` key is not accepted directly at `/mcp`.
Keep exchange responses out of logs/chat. General self-service cloud enrollment
is not available; missing provider trust or credential delivery is a blocker to
record, not a reason to change auth configuration or borrow the owner's grant.

For a browser-only agent, verify its own enrolled member account and organization
in Tedix OS and read one Work record. A represented-user relationship, findings
intake token and browser membership confer different access; never substitute
one for another or assume representation grants the person's decisions.

For first use, explain what is ready in one short reply: connected account,
selected organization, and the bounded read that worked. Offer the next action
for the user's task (find Work, ask a tedi, or save an Output) subject to actual
permissions. If no task is supplied, start with one read of existing Work rather
than creating a Workspace or dispatching a worker. Use Code Mode for action
discovery and execution; no additional everyday action tools are required.

A read-only grant is a useful completed setup, not a failed installation.
Explain which requested action needs additional access only if the user asks
for it. Do not automatically expand consent during onboarding. If a write is
unavailable, offer a draft in this chat or a read of existing results; do not
claim that a worker was dispatched or an Output saved.

If consent completes but the host says it could not connect, keep that separate
from a successful connection. Capture the time and safe error/trace identifiers
from the supported flow. Check consent, token exchange, connection persistence,
profile identity and the bounded capability read as separate steps. Preserve
existing connections; do not recreate registrations or expand permissions to
diagnose a connection failure.
