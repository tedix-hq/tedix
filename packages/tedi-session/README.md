# @tedix/tedi-session

Body-neutral per-conversation session contract for tedi runtimes.

## Overview

Every tedi is the Agent runtime (Cloudflare Agents with native Pi Worker + Durable
Object, `apps/tedi-runtime`), but a tedi's cognitive state must survive
runtime replacement and body swaps. This package defines the session
contract that keeps per-conversation history reconstructable from the
durable, canonical cognitive ledger (D1 `tedi_runtime_events`) rather than
tying it to any one runtime body's in-memory state.

`session-harness.ts` is the pure, body-neutral contract: no `@cloudflare/*`
or Durable Object (DO) types leak through it. `session-repo.ts` is the current
concrete backend — an append-only DO-SQLite `session_entries` table used by
the Agent runtime (`apps/tedi-runtime`). API kernel context assembly uses
`SessionHarness` over its own `KernelHomeSessionBackend`, which reads D1
directly and has no hot cache. Both implement `SessionHarnessBackend`.

Targets the Cloudflare Workers runtime (DO-SQLite via `SessionRepoSql`, a
tagged-template port matching a Durable Object's `this.sql`), but the
harness itself has no Workers dependency and is unit-testable offline.

## Features

- **`SessionHarness`** — reference implementation of `TediSessionHarness` over
  a pluggable `SessionHarnessBackend`. `buildContext` is ledger-first: it
  reconstructs prompt history from the durable transcript and merges the
  in-flight tail from the hot cache (`mergeDurableAndCache`), so a
  cold/rebound body still gets full context.
- **`selectSessionContext`** — pure function that slices a
  flat turn list by `sessionKey`, the single guard against cross-conversation
  context bleed.
- **`mergeDurableAndCache`** — reconciles the durable D1 transcript against
  the runtime-local cache by stable `ts` (not content), so repeated/identical
  messages never mis-align the boundary.
- **`TediSessionRepo`** — append-only DO-SQLite backend (`SessionHarnessBackend`)
  with idempotent dedup on a deterministic `{runId}:{seq}` key, branch traversal
  (`getBranch`), and non-destructive compaction (`compactSession`) via a
  read-time overlay that never deletes rows. The runtime calls repository
  compaction directly; the harness exposes `appendTurn` and `buildContext`.

```typescript
import {
	SessionHarness,
	DEFAULT_SESSION_KEY,
} from "@tedix/tedi-session/session-harness";
import { TediSessionRepo } from "@tedix/tedi-session/session-repo";

const repo = new TediSessionRepo({
	sql: this.sql, // DO-SQLite tagged-template runner
	// D1 callback returns { entries: TediSessionDurableEntry[], compaction: TediSessionDurableCompaction | null }
	readDurable: readDurableLedgerState,
});
const harness = new SessionHarness(repo);

harness.appendTurn(DEFAULT_SESSION_KEY, {
	role: "user",
	content: "hi",
	ts: Date.now(),
});
const messages = await harness.buildContext(DEFAULT_SESSION_KEY);
```

## Compaction and branching

`compactSession` collapses the head of a conversation into a single summary
once it crosses a token budget (`keepRecentTokens`, default 20k), cutting on
a user-message boundary so a turn is never split. The cut is a read-time
overlay (`projectBranch`) over append-only rows — dropped entries stay on
disk. Branch traversal can still read the original entries from an older leaf.

## Related

- [Workers and governance](../../docs/public/workers-and-governance.md) — public context for
  the durable identity/runtime layering this session harness implements.
- The Agent runtime owns the DO-SQLite repository. API kernel context assembly
  shares the harness contract through its D1 backend.
