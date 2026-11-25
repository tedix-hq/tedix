# Offline change verification

Internal preparation for a portable change-record profile. Nothing here
publishes a package or transfers contribution rights.

`valid.json` and `invalid.json` are DSSE envelopes containing language-neutral
JSON. `statement.json` is the decoded valid payload for inspection. All three
use fictional data. `public-key.spki` is base64 Ed25519 SPKI DER; its example
private key was discarded. This key establishes fixture integrity only.

Copy this directory anywhere outside the repository, then use Node 26.13 or
later. The verifier needs only Node built-ins, no installation or Tedix code:

```sh
node --permission --allow-fs-read=. verify-change.mjs valid.json public-key.spki
# VALID change-record/example-change-1 (exit 0)
node --permission --allow-fs-read=. verify-change.mjs invalid.json public-key.spki
# INVALID: Signature verification failed (exit 1)
```

These permissions grant file reads only. Network, child processes, workers,
native addons and file writes remain denied. `invalid.json` changes the
record's outcome but retains the original signature. Neither file authorizes
an action. The caller must obtain the trusted public key independently; an
envelope's unauthenticated `keyid` never chooses the trusted key.

## Profile

`changeStatement(record)` builds an
[in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md).
Its subject is the immutable change record, named `change-record/<id>`.
The SHA-256 digest uses the existing record format: sorted-key JSON of the
record with `sequence`, `recordDigest` and `chainHash` omitted. Those fields
describe ledger placement; this statement does not verify a ledger chain.
Use the existing checkpoint verifier when chain membership matters.

The predicate type is `https://tedix.dev/attestations/change-record/v1`.
`predicate.record` retains the captured record; the other fields project its
actor, cause (operation, source, task and parent), approval, environment and
time. The verifier checks both the signature and these projections against
the record. It uses the authenticated payload bytes directly, with the
[DSSE pre-authentication encoding](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md).
`signStatement` reuses the existing checkpoint signer and Ed25519 keys.
There is no new signing service, log or production integration.

`ChangeContent` accepts ledger records and gateway execution captures. A
capture may lack a ledger sequence or gate evaluation; neither is invented.
A successful call receipt can establish execution, but does not expose the
policy decision, approval route or delegated principal. Capture signatures
attest the capturer's account of an event, not platform audit provenance.
The real gateway event and its valid/invalid captures belong in the matching
internal Work evidence, alongside the original receipt. Keep live account
and resource identifiers out of these checked-in examples.

## Field map

| Field           | Mapping or remaining gap                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject kind    | `subjectKind: change_record`; `record.resource` identifies the affected resource. The subject digest identifies the record, not the mutable resource. |
| Actor           | `actor` copies the recorded principal and kind.                                                                                                       |
| On behalf of    | Open: records do not capture the delegated principal. `onBehalfOf` is null.                                                                           |
| Task            | `cause.task` copies `record.subject`; absent links are open with a reason.                                                                            |
| Parent          | `cause.parent` copies captured run/root/record links; absent links are open.                                                                          |
| Approval        | Copied when captured; otherwise null and open. An allow verdict alone does not establish human approval.                                              |
| Environment     | Captured fields only. An absent environment is open. Harness facts do not prove the deployed product revision or model.                               |
| Policy version  | `environment.policyDigest` or `approval.policy.revisionId`; open when neither was captured. A digest identifies rules, not a tenant revision.         |
| Time            | `time.recordedAt` copies recorder time. Trusted time remains open: there is no independent timestamp authority receipt.                               |
| Gate evaluation | Retained in the record when available; open for execution receipts that do not expose it.                                                             |

Every absent field above is listed in the signed `openFields` with its reason.
A signature proves integrity under a supplied key; it does not prove the
event's truth, authority, time, completeness, or successful downstream effects.

## Build the portable modules

Copy `standalone/package.json` as `package.json`, `tsconfig.build.json` and
`src/{record,seal,evidence,hash,types,compliance,in-memory,memory-mcp,memory-review}.ts`
into an independent directory, keeping the `src/` directory.
The extraction manifest has no workspace or catalog dependency versions.
The build config is self-contained and the modules have no runtime dependencies.
With TypeScript 7.0.2 installed, run:

```sh
tsc -p tsconfig.build.json
```

This emits runnable ESM and declarations for the record and memory review
modules into `dist/`. Tests are outside this build. The package's normal type check
still covers all its source modules. The workspace manifest and normal
`tsconfig.json` retain the repository's shared development tooling; neither
is needed by the extracted modules.

## Review external memory

The private alpha uses the
[MCP reference memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)
at version 2.2.1. Copy `memory-review-server.mjs` into `examples/` in the
independent directory above, install its manifest dependencies, and build.
Use Node 24 or later to launch it as a private stdio MCP server:

```sh
MEMORY_FILE_PATH=/absolute/path/to/pilot.jsonl MEMORY_REVIEW_SCOPE=pilot \
  node examples/memory-review-server.mjs
```

The launching operator has `propose_memory`, `approve_memory`, `reject_memory`
and `rollback_memory`, plus `recall_memory` for approved retrieval. Proposal
arguments contain only `key` and `value`; review takes a `revisionId` and an
optional `note`; rollback takes `key` and `toRevisionId`. Identity and source
come from the host, never tool arguments. A shared host must supply its own
authentication and authorization before calling `createMemoryReview`.

Each tool returns a revision and a step-3 `ChangeStatement`: actor, source,
operation, argument hash, before/after pointers, outcome and an undo pointer
when there was a previous approved value. Save that statement with the result;
`signStatement` can sign it with the operator's own key. No signature, approval
receipt, trusted time or policy decision is invented. Uncertain storage errors
return an error with an `unknown` record outcome.

The adapter stores an append-only event history in an external graph entity
and replays it using the existing memory semantics. Reads and mutations go to
that server; a failed call never falls back to local storage. Writes are read
back before success. `recallMemory` projects only each key's newest approved
revision; pending and rejected values remain available to reviewers in history.
Rollback through the review tool requires an approved target and appends a
new approved revision. Review decisions cannot be changed after approval or
rejection.

Keep the raw server private to the review host. Its native `read_graph`,
`search_nodes` and resources contain review history, including rejected values,
and must never be exposed as recall. Scope names separate adapter histories;
they do not authenticate a tenant. Use an isolated file and one review writer
for each pilot. Concurrent processes writing one scope are unsupported because
the reference server has no conditional append. File rewrites and full history
replay also make this an alpha for bounded stores, not a scale benchmark.

Run the existing memory conformance cases and the end-to-end stdio proof:

```sh
bun run --cwd packages/agent-governance type-check
bun run --cwd packages/agent-governance test:run src/memory-mcp.test.ts src/conformance.test.ts
```

The external-store test covers write/read/list/history, immutable review,
append rollback and export/import metadata. Its tool proof approves two values,
rejects another, restores the first approved value, restarts the host, and
checks recall again. It also refuses rollback to rejected content and attempts
to bypass proposal review. The per-operation result table belongs in the
matching Work evidence. Tenant store selection and existing tenant migration
are outside this alpha.
