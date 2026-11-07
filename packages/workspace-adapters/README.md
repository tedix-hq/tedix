# @tedix/workspace-adapters

Three contracts every workspace binding call passes through, plus the
`wrapBinding` helper that enforces check -> call -> record around any async
method. A workspace object (`apps/workspace-do`) and the MCP gateway
(`apps/mcp`) use the same contracts, so the same call gets the same decision
and the same ledger row whichever path carried it.

The package is runtime-neutral: interfaces, pure decision logic and in-memory
implementations only. No Durable Object, D1 or Worker imports.

## The three contracts (`@tedix/workspace-adapters/types`)

| Contract                | What it does                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryAdapter`         | `write` with provenance (actor, source, change-record id), `read`/`list`/`history`, `review` (approve or reject a revision), `rollback` to a prior one.   |
| `AccountabilityAdapter` | One `ChangeRecord` per action: resource, before/after revision or hash, decision, approval evidence, undo plan. Append-only `append`/`list`/`export`.     |
| `ComplianceAdapter`     | `check(call)` before any tool or binding call returns `allow`, `needs_approval` or `deny` with risk tier, budget and rate state; `record(outcome)` after. |

Vocabulary is the gateway's existing one: `riskTier` (`read`,
`bounded_write`, `high_impact_write`, `external_side_effect`), `blastRadius`,
policy `disposition` (`allow`, `ask`, `deny`), gate names
(`tool_scope`, `risk_rate_limit`, `annotation_assertion`,
`destructive_approval`, `secret_egress`) and the `needs_approval` verdict
from delegation dispatch.

## One decision function (`@tedix/workspace-adapters/compliance`)

`evaluateCall(facts)` is the only place a verdict is computed. An adapter
collects facts from wherever it lives (D1 policy rows and rate limiters at
the gateway, a table in tests, a workspace object's own storage) and hands
them in. Gate order mirrors the gateway: scope, secret egress, annotation
assertion, rate limit, policy disposition, destructive approval.

## `wrapBinding` (`@tedix/workspace-adapters/wrap-binding`)

```ts
const crm = wrapBinding(rawBinding, {
	compliance,
	accountability,
	actor: { id: "user-1", kind: "user", organizationId: "org-1" },
	source: { surface: "workspace_object", traceId },
	resource: "tool:crm",
	methods: {
		deleteCustomer: { riskTier: "high_impact_write", blastRadius: "tenant", destructive: true },
		renameCustomer: { before: ..., after: ..., undo: ... },
	},
});
await crm.deleteCustomer("c1"); // throws CallRefusedError until approved
```

A refused call throws `CallRefusedError` carrying the decision and the ledger
row; the binding is never called. `guardedCall` is the same flow for one call
without a Proxy.

## In-memory implementations (`@tedix/workspace-adapters/in-memory`)

`createInMemoryAdapters({ policies, callerScopes, approvedRequestIds,
deniedRequestIds })` returns all three. Use them in tests and as the first
storage of a workspace object.

## Gateway consumer

`apps/mcp/src/mcp/gateway-adapters.ts` implements `ComplianceAdapter` over the
gateway's existing gates (annotation assertion, tier rate limiter, destructive
approval with its policy candidates) and `AccountabilityAdapter` over the MCP
audit stream. `guardGatewayCall` wraps native and widget tool calls;
`admitGatewayCall` does check -> execute -> settle for Code Mode, which owns
its own execution loop. `gateway-adapters.test.ts` proves the gateway path and
`wrapBinding` decide identically for reads, budgeted writes, rate-limited
writes and destructive calls that are pending, approved or declined.

Refusals are written to the audit stream as `access_denied` events. Applied
calls are already written there as `tool_call` events by the telemetry
wrapper, keyed by the same trace id, so the gateway ledger does not duplicate
them. The gateway has no durable `ChangeRecord` table yet; the workspace
object owns that storage.
