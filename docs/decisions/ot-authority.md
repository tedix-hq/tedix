---
summary: "ADR for the server-side OT authority loop in apps/os: a Durable Object is the single ordering point for a document's uncommitted edits; why a DO and not D1, the materialize/retire/prune ladder, the base-move hazard, the canonical grounding stamp, and why grounding is a separate verb from adoption"
read_when:
  - Changing apps/os/src/collab/ot/authority.ts or its storage records
  - Adding an await to one of the *Synchronously spans, or wondering why they are not async
  - Asking why the room pins commits to a stored canonical stamp instead of reading the canonical store
  - Touching retention, pruning, or the capacity refusal
title: "OT authority loop"
status: active
date: 2026-09-22
---

# ADR: the OT authority loop

**Status:** Active. The invariants live in
`apps/os/src/collab/ot/authority.ts`; this record explains why they are the
invariants.

The server-side OT authority loop is the **single ordering point for a
document's uncommitted edits**. Clients submit changes against the revision
they last saw; the loop transforms each submission onto the current head,
appends it to the revision stream, and broadcasts the accepted row. Every
replica applies rows in the same order and converges on the same content.
`code-change.ts` owns the transform algebra; `authority.ts` owns ingestion
order and the atomicity of one accept. Storage, the broadcast sink, the clock
and the digest are injected (`OtAuthorityDeps`), so the loop is unit-testable
without a runtime.

## Decision

### A Durable Object, not D1

Correctness rests on single-writer serialization: one accept must read the
stream, transform against it, and extend it with no other accept interleaving.
A Durable Object gives that within a synchronous span; D1 does not. The loop
issues no D1 calls; DO storage is its only store.

### Hibernation-safe by construction

The revision counter, rows, base snapshot, materialization watermark (carried
by the base record) and dedupe records all live in DO storage and are
rehydrated lazily once per wake by `#load()`. There is no in-memory timer or
subscriber list: the room implements `broadcast` by iterating
`state.getWebSockets()`, which survives a wake. A client that missed rows asks
for `rowsSince()` and deduplicates by `(generation, revision)`
(`selectUnappliedRows` in `wire.ts`), the same path as a reconnect.

### Materialize, retire, prune

- **Materialize.** When the live window crosses `MATERIALIZE_THRESHOLD_ROWS`
  rows or `MATERIALIZE_BUDGET_UNITS` of payload, the base moves forward to the
  content at the row just accepted, so the per-accept fold returns to zero rows.
- **Retire (soft).** A materialized row leaves the content fold (the base
  already contains it) but stays in the transform window. A briefly offline
  client can still submit against a revision in the materialized range and be
  rebased instead of rejected. Materialization always absorbs a prefix and the
  loop is single-generation, so "retired" is exactly `revision <= materialized`
  and needs no per-row flag.
- **Prune (hard).** A retired row is deleted once older than
  `RETIRED_ROW_TTL_MS` or when the window exceeds `MAX_RETAINED_ROWS`. Only a
  contiguous prefix is dropped, so the window stays gapless. A submission based
  before the surviving window is rejected `stream-gone`: an explicit rebuild
  instruction, never a mistransform.

The retention horizon is the tolerance a client gets for being disconnected.
Under OT there is no offline mode, so a client whose base aged out must discard
local edits. The horizon is sized for ordinary reconnects (retry ladders,
bfcache resume, a closed laptop lid), not just in-flight round trips. Widening
it is close to free: retired rows are already written, excluded from the fold,
and pruned lazily. `MAX_RETAINED_ROWS` keeps storage bounded under load.

### Moving the base is the central hazard

The accept path prefetches the content a submission is validated against. If
the base moved between prefetch and append, the submission would be applied to
content the server never had: silent corruption. Two properties make this
unreachable:

1. **The base moves only inside `applySubmissionSynchronously`**, in the same
   await-free span that appends the row that caused it. The base cannot move
   without the revision counter moving, so the `(generation, revision)` stamp
   the span revalidates is also the base's stamp. `OtPrefetch.baseRevision` is
   re-checked against `state.materialized` to catch any future edit that moves
   the base elsewhere.
2. **The base record is self-describing.** `StoredBase` carries the revision it
   includes, so `base + rows after base.revision` cannot be assembled wrong.

The prefetch stamps _after_ the read: a base read can return a base newer than
a stamp taken beforehand, and folding it with the old stamp's rows would
re-apply rows the base already contains. The fold starts at the base's own
revision, so a `null` result means storage is corrupt, not that a race
happened. The base is re-read per submission rather than cached, because
materialization moves it.

### The `*Synchronously` spans contain no `await`

A Durable Object runs a handler to completion only between awaits; at an await
on non-storage I/O another submission can land, and state read before the
await becomes stale. The spans are not `async`, take prefetched inputs as
parameters, and re-read live state at the top. `authority.test.ts` asserts
their source contains no `await`. This applies to
`applySubmissionSynchronously`, `seedSynchronously`,
`materializeSynchronously`, `pruneRetiredRowsSynchronously`,
`adoptCanonicalSynchronously` and `groundCanonicalSynchronously`.

### Canonical grounding

D1 is the source of truth, but the stream is always grounded on one canonical
revision, and the room records which one in `StoredCanonical` (written by
`seed`, moved by `adoptCanonical` and `groundCanonical`). A surface pins its
commit's compare-and-swap to that stamp. Pinning to whatever the canonical store
reports at commit time would lose data: a revision committed out of band would
satisfy the CAS while the room still held older text.

`atRevision` is the edited flag in stream terms: `state.revision ===
atRevision` means nothing was accepted since grounding. The stamp is kept
separate from `StoredBase` so adoption can move it without rewriting the base.

**Adoption is one server-authored row, not a base swap.** Swapping the base
under a live stream would move every replica's ground truth without a row to
tell them. As a row, adoption converges through the ordinary path: peers apply
it, carets map across it, and in-flight submissions are transformed over it.
Outcomes, in order:

1. **Not newer** — the stamp in force is at or ahead of the offer; nothing
   happens. Concurrent offers are idempotent. Even forced recovery never moves
   the stamp backwards.
2. **Byte-identical** — the room's content already equals the offer; the stamp
   moves alone. This is the path after a room commits its own text.
3. **Different** — an unedited room adopts; an edited room is refused unless the
   caller forces it. The surface blocks Commit and offers an explicit, warned
   replacement rather than silently discarding a colleague's unsaved work.

**Grounding is a separate verb.** A commit makes the room's text at stream
position P canonical revision N, but by the time the surface learns N exists the
room may be at P + k. Offered as an adoption, N would be refused and the
document would wedge. `groundCanonical` asks a different question: was the
content at position P equal to revision N? The caller names P; the server folds
the stream to P (`contentAtRevision`), compares byte-for-byte with the claimed
files, and only then moves the stamp to `{revision: N, atRevision: P}`. Nothing
is written to the document.

A peer cannot forge a grounding: the position must exist in the live window and
its server-folded content must match the supplied files, so no one's unsaved
edits can be relabelled as committed. The only thing taken on the caller's word
— that revision N's content is those bytes — is the same trust `adoptCanonical`
already extends to an authorized editor, since the room cannot read D1.

The grounding span revalidates less than the accept span because it reads a
historical fact: content at a past revision is immutable (rows are never
renumbered, pruning drops only a prefix the base contains, and a base record at
a revision is written at most once). A fold can become unavailable (`null`),
never wrong. The moving fields — `generation`, `revision`, `canonical` — are
read inside the span immediately before the write.

### Dedupe records are never pruned

They are deleted only with the room. Expiring them would let a delayed retry of
a pruned session's first change (`seq: 1`) apply twice, and OT does not
tolerate double application. They are small (one per submitting session).
They are scoped to the authenticated user, not `clientId` alone, because
`clientId` is visible in the broadcast echo and an unscoped record would let one
collaborator consume another's next sequence number.

### `capacity` is a server fault

Materialization inside the accept span keeps the window small, so
`MAX_STREAM_ROWS` is reachable only if reclamation regressed. The client copy
says so — a server fault that clears itself — and does not promise delivery:
there is no offline log (`apps/os/src/lib/use-collab-doc.ts`), so edits not yet
acknowledged are lost if the socket closes.

### Single generation

`generation` is carried end to end but never bumped: no epoch reset and no
straggler bridge. A submission whose position cannot be resolved is rejected
`stream-gone` and the client rebuilds from a fresh seed.

## Consequences

- Offline editing is not supported; the retention horizon bounds how long a
  client can be disconnected without losing unacknowledged edits.
- Any new code path that moves the base, or adds an `await` inside a span,
  reopens silent corruption; the no-`await` test guards the second.
- Out-of-band canonical revisions are never merged silently into an edited room.

## Rejected alternatives

- **D1 as the ordering point** — no single-writer, run-to-completion isolation.
- **Deleting rows as soon as they are folded** — silently breaks briefly offline
  clients.
- **Swapping the stored base on adoption** — replicas diverge with no row to
  follow.
- **Treating a room's own commit as an adoption** — refuses the room's own
  commit and wedges the document.
- **Expiring dedupe records** — reopens double application.

## Related

- `apps/os/src/collab/ot/authority.ts` — the loop.
- `apps/os/src/collab/ot/code-change.ts` — the transform algebra.
- `apps/os/src/collab/room.ts` — the Durable Object room.
- [Tedix OS](../product/tedix-os.md)
