# @tedix/agent-governance

Governance contracts for any agent runtime that calls tools or data: a
memory store with provenance and review, an append-only change ledger, and a
compliance check that runs before every call and records after it. The
`wrapBinding` helper enforces check -> call -> record around any async
method, so two runtimes that wrap the same call decide and record it the
same way.

Plain TypeScript. No platform, database or application imports; a test
asserts that. Apache-2.0.

## The three contracts (`@tedix/agent-governance/types`)

| Contract                | What it does                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryAdapter`         | `write` with provenance (actor, source, change-record id), `read`/`list`/`history`, `review` (approve or reject a revision), `rollback` to a prior one.   |
| `AccountabilityAdapter` | One `ChangeRecord` per action: resource, before/after revision or hash, decision, approval evidence, undo plan. Append-only `append`/`list`/`export`.     |
| `ComplianceAdapter`     | `check(call)` before any tool or data call returns `allow`, `needs_approval` or `deny` with risk tier, budget and rate state; `record(outcome)` after it. |

`GovernanceAdapters` bundles the three.

Vocabulary: `riskTier` (`read`, `bounded_write`, `high_impact_write`,
`external_side_effect`), `blastRadius` (`none`, `single_resource`, `tenant`,
`multi_tenant`, `external_system`), policy `disposition` (`allow`, `ask`,
`deny`), gate names (`tool_scope`, `risk_rate_limit`,
`annotation_assertion`, `destructive_approval`, `secret_egress`, `budget`)
and the verdict `allow | needs_approval | deny`. `Actor.kind` is an open
string union (`user`, `agent`, `service`, `system`, or a runtime's own kind).
`Source.surface` is a free string naming the enforcement point, for example
`mcp_gateway`, `mcp_codemode`, `workspace_object`, `migration`, `cli`.

## One decision function (`@tedix/agent-governance/compliance`)

`evaluateCall(facts)` is the only place a verdict is computed. An adapter
collects facts from wherever it lives (policy rows and rate limiters at a
gateway, a table in tests, a runtime's own storage) and hands them in. Gate
order: scope, secret egress, annotation assertion, rate limit, policy
disposition, destructive approval.

## `wrapBinding` (`@tedix/agent-governance/wrap-binding`)

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

## In-memory implementations (`@tedix/agent-governance/in-memory`)

`createInMemoryAdapters({ policies, callerScopes, approvedRequestIds,
deniedRequestIds })` returns all three. Use them in tests and as a runtime's
first storage.

## Consumers in this repository

- `apps/mcp/src/mcp/gateway-adapters.ts`: the MCP gateway implements
  `ComplianceAdapter` over its existing gates (annotation assertion, tier
  rate limiter, destructive approval) and `AccountabilityAdapter` over its
  audit stream. `guardGatewayCall` wraps native and widget tool calls;
  `admitGatewayCall` does check -> execute -> settle for Code Mode.
  `gateway-adapters.test.ts` proves the gateway and `wrapBinding` decide
  identically for reads, budgeted and rate-limited writes, and destructive
  calls that are pending, approved or declined. Refusals are written as
  `access_denied` audit events; applied calls are already written as
  `tool_call` events by the telemetry wrapper.
- `apps/workspace-do`: the workspace object implements the three contracts
  over its own storage and wraps every data binding with `wrapBinding`.
