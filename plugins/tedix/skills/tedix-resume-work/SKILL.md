---
name: tedix-resume-work
description: Resume one existing governed Tedix Work Item under an admitted Attempt, preserving its identity, lease, scope, and settlement. Use when the user gives a Work Item or asks to continue its execution; not for a general status lookup.
---

# Resume governed Work

Input: a Work Item ID and the intended Tedix workspace. This skill does not
grant authority. The Tedix organization skill `work-item-operating-protocol`
owns the full lifecycle; load it when available in the selected organization.
In a Tedix repository checkout, read `docs/WORKITEMS.md` and applicable
`AGENTS.md` files too.

1. Run `tedix -w <workspace> auth status` and
   `tedix -w <workspace> agent status`. Reuse this
   harness's verified external-agent credential and unique
   `TEDIX_AGENT_SESSION`; if missing, bootstrap through owner-authorized
   `tedix agent start` as the canonical protocol directs. Owner OAuth alone
   is not executor identity. In an MCP-only host, discover the equivalent Work
   tools and use them under the actual principal.
2. Read `tedix -w <workspace> work context <id> --json`,
   `tedix -w <workspace> work attempts <id>`, and
   `tedix -w <workspace> work readiness <id>`. Load the canonical org skill
   through Code Mode with `skills.get_skills_for_mcp` and slug
   `work-item-operating-protocol` when available; otherwise use the current
   `tedix work --help` and [public agent guide](https://docs.tedix.dev/agent-guide)
   without inventing missing authority. Read the accepted
   outcome, recent comments, dependencies, active Attempts, and admission
   reasons before choosing the next action. For repo edits, check neighbours
   and preserve unrelated work.
3. If the item is executable and no other session holds its Attempt, use the
   protocol's `work start` admission, heartbeat the exact returned Attempt
   through long work, and carry out only that accepted scope. Follow the
   protocol for approvals, Git trailers, validation, settlement, and
   `work complete`. Read the final Work disposition and any deployed surface
   separately before calling the result shipped.

If the item is proposed, blocked, already completed, or held by another
Attempt, report that exact state and its next owner/action; do not edit first
or fabricate authority. If a lease expires, stop Attempt-owned writes and use
the canonical recovery path. If a check fails, fix the underlying cause or
report the failure; do not weaken the check to mark the item done.
