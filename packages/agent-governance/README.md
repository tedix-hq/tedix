# @tedix/agent-governance

Governance contracts for any agent runtime that calls tools or data: a
memory store with provenance and review, an append-only change ledger, and a
compliance check that runs before every call and records after it. The
`wrapBinding` helper enforces check -> call -> record around any async
method, so two runtimes that wrap the same call decide and record it the
same way.

Plain TypeScript. No platform, database or application imports; a test
asserts that. Apache-2.0.

For individual signed change records, the language-neutral valid/invalid
examples and a standalone offline verifier, see [examples](examples/README.md).
`bun run build` emits the portable record, seal and evidence modules without
Tedix build configuration; nothing is published by that command.

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

With working recording adapters, each invocation appends one final ledger row
and records one compliance outcome, including failures in preflight. Compliance
is checked before the `before` revision hook runs. A hook or hashing failure
becomes a recorded denial and never reaches the binding. Cyclic and BigInt
arguments use a stable structural hash; ordinary JSON arguments keep their
existing hash. If neither hash can be computed, the denied row uses the explicit
`unavailable` marker. Errors from `onRecorded` do not change the call's outcome.

`guardedCall` takes an optional `approval` function returning the
`ApprovalEvidence` of the approval that let the call through: which path
(`kind`), who approved and when, a hash of what they were shown
(`presentedHash`, absent when nobody was shown anything), the hash of the
arguments the approval was tied to (`boundArgsHash`, the same function as
`argsHash`), whether it was single use, and the policy identifiers it used. It is
read when the row is written, after the call ran, and only for an allowed
call; a failure to read it never changes the outcome.

## Tamper-evident ledgers (`@tedix/agent-governance/seal`)

Lets anyone holding the public key check an exported ledger offline: a
changed, deleted or reordered record is found, and the result names where.

- `recordDigest(record)`: SHA-256 hex of the record's content, which is every
  field except `sequence`, `recordDigest` and `chainHash`, serialized with
  `serializeGovernanceValue`.
- `chainHash(previous, sequence, digest)`: SHA-256 hex over the UTF-8 of
  `tedix.change-record-chain.v1`, the previous chain hash (64 zeros for the
  first record), the sequence and the digest, joined by newlines.
- `checkpointStatement(...)`: an
  [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md)
  whose subject is `gateway-change-records/<organizationId>` with the head
  chain hash as its `sha256` digest. The predicate type
  `https://tedix.dev/attestations/change-record-checkpoint/v1` holds the
  organization, first and last sequence, record count, previous checkpoint
  digest, previous chain hash and seal time.
- `signCheckpoint` / `verifyCheckpoint`: a
  [DSSE envelope](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md)
  of payload type `application/vnd.in-toto+json`, signed with Ed25519.
- `sealRun(...)` seals the next records and builds their checkpoint;
  `verifyChain({ records, checkpoints, publicKey })` checks an export, also one
  that starts partway through the ledger, and reports the first `order`,
  `digest`, `link`, `gap`, `signature`, `checkpoint` or `unsealed` failure.

Get the public key from the ledger's owner through another channel; a key
read from the same place as the export proves nothing about who signed it.

## In-memory implementations (`@tedix/agent-governance/in-memory`)

`createInMemoryAdapters({ policies, callerScopes, approvedRequestIds,
deniedRequestIds })` returns all three. Use them in tests and as a runtime's
first storage.

## Portable memory (`@tedix/agent-governance/memory-transfer`)

`exportMemory(adapter)` returns a JSON-lines string: one complete revision per
line, including key, revision number, value, hash, provenance, review and rollback
link. `importMemory(destination, bundle, sourceStore)` returns the number copied.
Both use only `MemoryAdapter`; each adapter represents one memory scope. Transfer
workspace, agent and organization stores separately.

Import checks every value hash, revision order and rollback link before writing,
and refuses keys that already exist at the destination. It preserves hashes,
revision numbers, timestamps and review metadata. Local revision IDs are new;
rollback links point to the corresponding local revision. Provenance retains its
actor and source and appends `{ store: sourceStore, revisionId }` to `importedFrom`
for each transfer. The caller supplies a source store reference meaningful to
the recipient. A matching hash checks content integrity, not trust or authority
to transfer or approve it.

Exclude concurrent writes while importing. Storage errors can leave a partial
import; the contract has no transaction or deletion operation. Empty stores
export as an empty string. No storage migration is needed.

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
