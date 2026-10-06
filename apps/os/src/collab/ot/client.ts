/**
 * The client half of the OT loop: the classic two-buffer Jupiter client behind an editor.
 * Adapted and modified from Cloudflare OS under Apache-2.0; see
 * `THIRD_PARTY_NOTICES.md`.
 *
 * `./authority` is the single ordering point; this module is what one replica runs against it. It
 * holds the server-acked content at a stream position, at most one in-flight submission plus one
 * composed buffer of newer local edits, transforms both over incoming rows (the priority pairing
 * lives in `./code-change`), and rebases them so the editor's display and the server's stream
 * converge on identical content.
 *
 * Four buffers, and the relationships between them are the whole design:
 *   `#applied`  -- server-acked truth at `#generation`/`#appliedRevision`;
 *   `#inflight` -- at most one submission out, `{wire, change, accepted?}`;
 *   `#pending`  -- the composition of local edits made since the in-flight one left;
 *   `#display`  -- `#applied` + `#inflight.change` + `#pending`: what the editor shows.
 * `#pending` applies on top of `#inflight.change`, which applies on top of `#applied`. Every
 * function that touches one of them must leave that chain true.
 *
 * Transport-agnostic by construction. Everything the client needs from the world is an injected
 * `OtClientDelegate` -- fetch a base snapshot, send a submission, subscribe to rows -- so the whole
 * loop is unit-testable headlessly against a real `OtAuthority` with no socket and no UI.
 *
 * A Tedix `CollabRoom` is one document with one snapshot base. The client therefore
 * needs no cross-document pin map or independent materialization watermark; the
 * two-buffer core, echo/ack discipline, held-row queue, and failure ladder are the
 * complete loop.
 *
 * Single generation, matching the server. `./authority` carries `generation` end to end but never
 * bumps it, so every generation change this client can observe today is a stream it cannot bridge:
 * `#handleForeignGeneration` routes them all to discard-and-rebuild. See that function for what a
 * later step must add instead.
 */

import {
	applyCodeChange,
	type CodeChange,
	type CodeContent,
	composeCodeChange,
	type FileChange,
	transformCodeChange,
} from "./code-change";
import {
	type CodeChangeRow,
	type CodeChangeSubmission,
	selectUnappliedRows,
	type StreamPosition,
} from "./wire";
import type { CodeChangeSubmitResult } from "./authority";

// =======================================================================================
// Delegate

/** A base snapshot: the content the row stream is replayed on top of, and where it sits. */
export interface OtBaseSnapshot {
	position: StreamPosition;
	content: CodeContent;
}

/** A remote content change to one file, for an open editor to apply as a remote transaction. */
export interface RemoteFileEvent {
	path: string;
	change: FileChange;
}

/**
 * Why local editing is blocked in a way the user must act on.
 *
 * Only `capacity` today, and in normal operation it is unreachable: `./authority` materializes
 * inside its accept span, which holds the live window near `MATERIALIZE_THRESHOLD_ROWS`, so
 * `MAX_STREAM_ROWS` is a fail-safe against a regression in that file (materialization made
 * conditional, deferred to an alarm, or allowed to throw) rather than a product limit a user can
 * reach by editing. Handle it anyway: an unreachable state that is silently unhandled becomes an
 * invisible stall the day it stops being unreachable. It must reach the product surface rather than
 * presenting as a submission that never lands.
 *
 * It is not actionable by the user, and the message must not pretend otherwise. The only action a
 * document surface offers is Commit, and a client with an unacknowledged submission -- which is
 * exactly what this state describes -- has no stream position to commit from, so the surface has
 * already disabled it. `CAPACITY_MESSAGE` in `./authority` therefore says what this really is: a
 * server-side fault that holds the edits and clears itself. Local edits are not discarded: they are
 * valid and merely unacceptable for now, so the client keeps retrying and clears the state the
 * moment one is accepted.
 */
export interface OtBlockedState {
	code: "capacity";
	message: string;
}

/**
 * How the client reaches the world. Every callback may be invoked from an async continuation, and
 * none of them may throw.
 */
export interface OtClientDelegate {
	/**
	 * Read the room's base snapshot: the content the client rebuilds `#applied` from, stamped with
	 * the stream position it reflects (`OtAuthority.content()` plus `head()` across the transport).
	 */
	fetchBase(): Promise<OtBaseSnapshot>;

	/**
	 * Submit one change. Resolves with the authority's own result -- an acceptance carries where the
	 * change landed, a refusal carries the `CodeChangeRejection` code that drives the failure ladder
	 * in `#sendInflight`. Rejects only on transport failure, which `isTransientError` classifies.
	 */
	submit(submission: CodeChangeSubmission): Promise<CodeChangeSubmitResult>;

	/** True for transport-level failures a retry or reconnect is expected to cure. */
	isTransientError(error: unknown): boolean;

	/**
	 * Deliver rows to `pushRows`; returns an unsubscribe called from `dispose()`. Optional because a
	 * caller may pump rows in by hand (`pushRow`/`pushRows`) from a socket it already owns.
	 */
	subscribe?(deliver: (rows: readonly CodeChangeRow[]) => void): () => void;

	/**
	 * Remote content changed. `events` carries per-file deltas for open editors; an empty array means
	 * the change is coarse (a rebuild) and open editors must reload from the client wholesale.
	 * Notifications that would change nothing an editor displays -- our own submission's echo, a
	 * doubly-transformed no-op remote row -- are not delivered at all, so empty never means "no-op".
	 * A spurious coarse signal needlessly rebuilds editors, dropping focus and selection.
	 */
	onRemoteChange(events: RemoteFileEvent[]): void;

	/** Queued local edits were discarded (a hard rejection or an unbridgeable generation change). */
	onLocalEditsDiscarded(): void;

	/** Whether unacknowledged local edits are stuck behind a failing submission. */
	onDirtyState(hasUnsyncedEdits: boolean): void;

	/**
	 * Whether this client holds edits the server has not agreed to yet -- `hasLocalEdits()`, pushed.
	 *
	 * DISTINCT from `onDirtyState`, which fires only once a submission is failing. This one is true
	 * from the keystroke until its acknowledgement, on the happy path too, and a product surface
	 * must gate a commit on it: while it is true the displayed text is `#applied` plus buffers the
	 * server has not agreed to, so no stream position describes it and a commit taken now has no
	 * basis to re-ground the room with afterwards. It is self-clearing -- every ack sets it false,
	 * and everything typed since the last one rides a single composed submission -- so a surface
	 * that waits on it waits at most one round trip, however fast the user types.
	 */
	onUnacknowledgedEdits(unacknowledged: boolean): void;

	/** Editing is blocked in a way the user must act on, or unblocked (`null`). */
	onBlocked(blocked: OtBlockedState | null): void;

	/** Unrecoverable failure (the base fetch failed); the surface should show an error. */
	onFatalError(error: unknown): void;
}

// =======================================================================================
// Tunables

/** While a submission is failing transiently or retryably, resend the same payload with backoff. */
const SUBMIT_RETRY_BASE_MS = 1000;
const SUBMIT_RETRY_MAX_MS = 15_000;

const EMPTY_CHANGE: CodeChange = [];

function isEmptyChange(change: CodeChange): boolean {
	return change.length === 0;
}

// =======================================================================================
// The client

/**
 * One document's OT client. Construct one per (room, view), `start()` it, feed it rows, route
 * editor edits through `applyLocalChange`, and `dispose()` it on teardown. `getContent()` is the
 * room's uncommitted content as this client displays it.
 */
export class OtClient {
	readonly #delegate: OtClientDelegate;

	// ---- server-acked state ----
	// Content through (#generation, #appliedRevision). Treated as immutable (copy-on-write), like
	// everything `./code-change` touches.
	#applied: CodeContent = new Map();
	#generation = 0;
	#appliedRevision = 0;

	// ---- local (unacknowledged) state ----
	/**
	 * At most one submission in flight -- the authority's seq rule makes that a checked invariant,
	 * not an assumption (a pipelined second submission is rejected with `sequence`).
	 *
	 * `wire` is the payload as first sent and a retry must resend it BYTE-identically: the server
	 * dedupes on a digest, and `digestInput` in `./authority` covers the claimed `generation` and
	 * `revision` as well as the change. A retry that renumbered its seq, re-composed newer edits in,
	 * or re-based itself onto a newer revision is therefore different content under a used seq, which
	 * the authority rejects as `sequence` -- discarding the user's work over a transport hiccup.
	 *
	 * `change` is that same change transformed over every remote row since, which is what `#display`
	 * and the rebase chain need. The two diverge the instant a remote row lands while the RPC is out,
	 * so they are separate fields and must not be collapsed into one.
	 *
	 * `accepted` is where the RPC response said the submission landed. Normally the echo row has
	 * already cleared this whole record by the time it is set (the server broadcasts before it
	 * responds), so it only matters as the lost-echo backstop -- see `#tryApplyInflightAck`.
	 */
	#inflight: {
		wire: CodeChangeSubmission;
		change: CodeChange;
		accepted?: StreamPosition;
	} | null = null;

	#pending: CodeChange = EMPTY_CHANGE;

	// ---- derived ----
	// #applied + #inflight.change + #pending: what editors display. Kept incrementally so remote
	// rows can be delivered to editors as per-file deltas rather than as a wholesale reload.
	#display: CodeContent = new Map();

	// ---- stream bookkeeping ----
	#clientId = crypto.randomUUID();
	#seq = 0;

	/**
	 * Rows received but not yet applicable, keyed `generation -> revision -> row`. HELD, not dropped:
	 * a row that runs ahead of the applied position is the stream's next-but-one step and dropping it
	 * would wedge the stream at the gap forever. Keying by `(generation, revision)` also makes
	 * duplicate delivery free -- the first copy of a revision wins.
	 */
	#heldRows = new Map<number, Map<number, CodeChangeRow>>();

	#blocked: OtBlockedState | null = null;
	/** The last `hasLocalEdits()` value pushed to the delegate, so only transitions are reported. */
	#unacknowledgedNotified = false;

	// ---- lifecycle ----
	#ready = false;
	#started = false;
	#disposed = false;
	#fatal = false;
	#unsubscribe: (() => void) | null = null;
	/**
	 * Serializes the async work (rebuilds and the drains that can trigger one) so state mutations
	 * happen in synchronous tails, in order -- mirroring the server's prefetch-then-commit pattern.
	 * Local edits are deliberately not queued: they are synchronous, and the queued tasks'
	 * synchronous tails read the then-current buffers.
	 */
	#queue: Promise<void> = Promise.resolve();
	#submitScheduled = false;
	#submitBackoffMs = SUBMIT_RETRY_BASE_MS;
	/** Bumped by every rebuild, so a rebuild superseded while its fetch awaited abandons its tail. */
	#rebuildEpoch = 0;

	constructor(delegate: OtClientDelegate) {
		this.#delegate = delegate;
	}

	/** Fetch the base and subscribe. Idempotent. */
	start(): void {
		if (this.#started || this.#disposed) return;
		this.#started = true;
		this.#unsubscribe =
			this.#delegate.subscribe?.((rows) => this.pushRows(rows)) ?? null;
		this.#enqueue(() => this.#rebuild());
	}

	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe?.();
		this.#unsubscribe = null;
	}

	/** False until the first base snapshot has been folded (and after a fatal error). */
	isReady(): boolean {
		return this.#ready && !this.#fatal;
	}

	/** The room's uncommitted content as displayed: server-acked rows plus local edits. */
	getContent(): CodeContent {
		return this.#display;
	}

	/** The stream position `#applied` sits at. */
	getPosition(): StreamPosition {
		return { generation: this.#generation, revision: this.#appliedRevision };
	}

	/** Whether unacknowledged local edits exist (in flight or still pending). */
	hasLocalEdits(): boolean {
		return this.#inflight !== null || !isEmptyChange(this.#pending);
	}

	/** The actionable block, if any. See `OtBlockedState`. */
	getBlocked(): OtBlockedState | null {
		return this.#blocked;
	}

	/** The client session token the next submission will carry. Exposed for tests and diagnostics. */
	getClientId(): string {
		return this.#clientId;
	}

	// =====================================================================================
	// Rows in

	/** Feed one broadcast row. */
	pushRow(row: CodeChangeRow): void {
		this.pushRows([row]);
	}

	/**
	 * Feed a batch of rows: a live broadcast, or the replay a reconnect asks for. Safe to deliver
	 * redundantly and out of order.
	 *
	 * `selectUnappliedRows` (in `./wire`) owns the reconnect dedupe by `(generation, revision)`, and
	 * is used here rather than reimplemented. It returns `null` when the batch cannot be applied at
	 * the current position at all -- a foreign generation, or a gap between the applied revision and
	 * the batch's first row. Neither is fatal here the way it is for a subscriber with no buffer: the
	 * rows go into `#heldRows` and the drain decides, because a gap can close from a later delivery
	 * (a replay racing a live broadcast) and a foreign generation is `#handleForeignGeneration`'s
	 * call, not this method's.
	 */
	pushRows(rows: readonly CodeChangeRow[]): void {
		if (rows.length === 0 || this.#disposed) return;
		this.#enqueue(async () => {
			const unapplied = selectUnappliedRows(this.getPosition(), rows) ?? rows;
			for (const row of unapplied) this.#hold(row);
			await this.#drainHeldRows();
		});
	}

	#hold(row: CodeChangeRow): void {
		let generationRows = this.#heldRows.get(row.generation);
		if (generationRows === undefined) {
			generationRows = new Map();
			this.#heldRows.set(row.generation, generationRows);
		}
		// First copy of a revision wins: a duplicate must never re-apply (OT, unlike a CRDT, does not
		// tolerate double application) and a later copy carries no information the first lacked.
		if (!generationRows.has(row.revision))
			generationRows.set(row.revision, row);
	}

	/**
	 * Apply every held row that is applicable now, in strict revision order, stopping at the first
	 * that is not -- a gap, or a position the client cannot reach.
	 */
	async #drainHeldRows(): Promise<void> {
		if (!this.#ready || this.#fatal || this.#disposed) return;
		for (;;) {
			// Prune what can never apply again: generations left behind, and revisions already folded
			// into `#applied` (a duplicate arriving after its original was applied). Deleting the key
			// currently being visited is well-defined for a Map iterator, so these need no copy.
			for (const generation of this.#heldRows.keys()) {
				if (generation < this.#generation) this.#heldRows.delete(generation);
			}
			const generationRows = this.#heldRows.get(this.#generation);
			if (generationRows !== undefined) {
				for (const revision of generationRows.keys()) {
					if (revision <= this.#appliedRevision) {
						generationRows.delete(revision);
					}
				}
			}

			const next = generationRows?.get(this.#appliedRevision + 1);
			if (next !== undefined) {
				this.#applyRow(next);
				continue;
			}
			// No next row: our own accepted-but-unechoed change may be exactly what sits there.
			if (this.#tryApplyInflightAck()) continue;
			// Still stuck, and a later generation is waiting: that is a stream boundary, not a gap.
			if (this.#hasFutureGeneration()) {
				await this.#handleForeignGeneration();
				return;
			}
			return; // A gap, or nothing to do. The rows stay held until it closes.
		}
	}

	#hasFutureGeneration(): boolean {
		for (const [generation, rows] of this.#heldRows) {
			if (generation > this.#generation && rows.size > 0) return true;
		}
		return false;
	}

	/**
	 * Apply one row -- the next in sequence, by the drain's construction.
	 *
	 * Synchronous on purpose: unlike the upstream client, there is nothing to fetch here (a Tedix
	 * room's base is one snapshot, not a set of per-gadget pins resolved lazily), so this cannot
	 * yield and the buffers cannot move underneath it.
	 */
	#applyRow(row: CodeChangeRow): void {
		const own =
			row.submission !== undefined &&
			row.submission.clientId === this.#clientId &&
			this.#inflight !== null &&
			row.submission.seq === this.#inflight.wire.seq;

		this.#applied = applyCodeChange(this.#applied, row.change);
		this.#appliedRevision = row.revision;

		if (own) {
			// Our own echo -- and this, not the RPC response, is the ack that matters: the authority
			// broadcasts before it responds. The broadcast change is our in-flight change as the server
			// transformed it, which is exactly the transform sequence we applied locally (same rows,
			// same priority convention), so `#display` already reflects it: `#applied` gained precisely
			// what `#inflight.change` contributed. Editors are therefore notified of nothing. An empty
			// call would read as a coarse reset (see `OtClientDelegate.onRemoteChange`) and rebuild
			// every open editor after every acknowledged keystroke, dropping focus and selection.
			this.#inflight = null;
			this.#submitBackoffMs = SUBMIT_RETRY_BASE_MS;
			this.#delegate.onDirtyState(false);
			this.#notifyUnacknowledgedEdits();
			this.#scheduleSubmit();
			return;
		}

		// A remote row: rebase the local buffers over it -- the row has priority, the server ordered
		// it first -- and apply its doubly-transformed form to the display. This is the core of the
		// whole client.
		let displayChange = row.change;
		if (this.#inflight !== null) {
			const { a, b } = transformCodeChange(
				displayChange,
				this.#inflight.change,
			);
			displayChange = a;
			this.#inflight.change = b;
		}
		if (!isEmptyChange(this.#pending)) {
			const { a, b } = transformCodeChange(displayChange, this.#pending);
			displayChange = a;
			this.#pending = b;
		}
		this.#display = applyCodeChange(this.#display, displayChange);

		// A row whose doubly-transformed form changed no displayed file is a display no-op: deliver
		// nothing rather than a spurious coarse reset. See `onRemoteChange`.
		if (displayChange.length === 0) return;
		this.#delegate.onRemoteChange(
			displayChange.map(([path, change]) => ({ path, change })),
		);
	}

	/**
	 * Backstop for a lost echo: the submission was accepted (the RPC response said where it landed)
	 * but its broadcast row never reached us -- it was materialized while we were disconnected, so no
	 * reconnect replay will ever carry it. Once the stream reaches the position just below the
	 * accepted one, apply our own change exactly as the echo would have: the broadcast change is our
	 * in-flight change as the server transformed it, i.e. the same transforms we applied locally (see
	 * the own-echo path in `#applyRow`). Notifies editors of nothing, for the same reason.
	 */
	#tryApplyInflightAck(): boolean {
		const accepted = this.#inflight?.accepted;
		if (
			accepted === undefined ||
			accepted.generation !== this.#generation ||
			accepted.revision !== this.#appliedRevision + 1
		) {
			return false;
		}
		const inflight = this.#inflight!;
		this.#applied = applyCodeChange(this.#applied, inflight.change);
		this.#appliedRevision = accepted.revision;
		this.#inflight = null;
		this.#submitBackoffMs = SUBMIT_RETRY_BASE_MS;
		this.#delegate.onDirtyState(false);
		this.#notifyUnacknowledgedEdits();
		this.#scheduleSubmit();
		return true;
	}

	// =====================================================================================
	// Generation handoff

	/**
	 * Stubbed to the discard-and-rebuild branch, deliberately and in step with the server.
	 *
	 * `./authority` carries `generation` end to end but never bumps it: every submission whose
	 * claimed position is unresolvable at head is hard-rejected (`stream-gone`) and the client
	 * rebuilds. So every generation change reachable today is one this client cannot bridge, and
	 * discarding is the correct, complete behavior for it -- not a placeholder that is wrong now.
	 *
	 * What a later step must add (Steps 7/9, retire/materialize plus the generation bump). A
	 * content-preserving bump -- the boundary is byte-identical on both sides -- must not discard
	 * keystrokes. It must instead: (1) wait for the closing generation's tail, applying rows through
	 * the closed generation's final revision before switching; (2) submit `#pending` under the
	 * closing generation's claim, so it rides the server's straggler bridge (a new-generation claim
	 * cannot work -- the fresh generation has no rows the change could be based against); (3) carry
	 * `#applied`, `#inflight`, and `#pending` across unchanged and reset `#appliedRevision` to 0.
	 * A destructive bump keeps this branch. Both need a server signal distinguishing the two
	 * (upstream carried a `prior` record naming the closed generation and its final revision) and a
	 * stall timeout, so an unfinishable handoff rebuilds instead of wedging the view. Do not build
	 * the straggler bridge before the server has one.
	 */
	async #handleForeignGeneration(): Promise<void> {
		await this.#rebuild();
	}

	// =====================================================================================
	// Rebuild

	/**
	 * Rebuild server-acked state from a fresh base snapshot, dropping the local buffers. This is a
	 * client-session boundary: a fresh `clientId` and `seq` 0, per the dedupe contract in
	 * `./authority` -- reusing the old session's `clientId` after discarding its work would collide
	 * with the seq the server still has recorded for it.
	 *
	 * Every rebuild is a possible data loss, and this is the only place that can tell whether it
	 * was one: the buffers are read in the synchronous tail, in the same await-free span that
	 * clears them. Deciding before the base fetch instead -- as a wrapper around this call did --
	 * misses a keystroke typed while the fetch was in flight (`applyLocalChange` is synchronous and
	 * deliberately unqueued), silently discarding it with no notification at all. The read has to
	 * sit next to the write.
	 */
	async #rebuild(): Promise<void> {
		const epoch = ++this.#rebuildEpoch;
		let base: OtBaseSnapshot;
		try {
			base = await this.#delegate.fetchBase();
		} catch (error) {
			if (!this.#disposed && !this.#fatal) {
				this.#fatal = true;
				this.#delegate.onFatalError(error);
			}
			return;
		}
		if (this.#disposed || this.#fatal) return;
		if (this.#rebuildEpoch !== epoch) return; // superseded; the newer rebuild covers it

		// ---- synchronous tail ----
		// Read in the same await-free span that clears them: whether this rebuild is about to
		// destroy keystrokes the server never agreed to. A rebuild that discards nothing must stay
		// silent -- a spurious "your edits were discarded" alert over an ordinary reconnect teaches
		// the user to ignore the one that is true.
		const discardedLocalEdits = this.hasLocalEdits();
		this.#applied = new Map(base.content);
		this.#generation = base.position.generation;
		this.#appliedRevision = base.position.revision;
		this.#inflight = null;
		this.#pending = EMPTY_CHANGE;
		this.#clientId = crypto.randomUUID();
		this.#seq = 0;
		this.#ready = true;
		this.#display = this.#applied;
		// All three recovery signals are republished unconditionally here, never through their
		// per-client transition guards. The guards compare against state this client was born
		// with, but the state they drive lives on the session, which outlives the socket: a
		// reconnect disposes one client and builds a fresh one whose guard starts at the
		// default, so a gated call compares `null === null` (or `false === false`), stays
		// silent, and leaves the surface believing whatever the dead client last told it.
		// Each one wedges a different affordance -- a stuck `blocked` makes the editor
		// permanently read-only, a stuck `unacknowledged` disables Commit forever, a stuck
		// `unsynced` leaves a false "unsent edits" banner -- and every one of them is
		// escapable only by a reload. They must not disagree; keep them together.
		this.#blocked = null;
		this.#delegate.onBlocked(null);
		this.#delegate.onDirtyState(false);
		this.#unacknowledgedNotified = false;
		this.#delegate.onUnacknowledgedEdits(false);
		// Coarse: editors must reload from the client wholesale (see `onRemoteChange`).
		this.#delegate.onRemoteChange([]);
		// After the content is published, so the surface's "the document below is what every
		// connected editor now sees" is true at the moment it is rendered.
		if (discardedLocalEdits) this.#delegate.onLocalEditsDiscarded();
		await this.#drainHeldRows();
	}

	// =====================================================================================
	// Local edits out

	/**
	 * Apply one locally-authored change, which the editor has already applied to its own document:
	 * fold it into the display and the pending buffer, and schedule a submission. The change must fit
	 * the current display content.
	 *
	 * Synchronous and deliberately not queued. A keystroke must reach `#display` and `#pending`
	 * immediately; the queued tasks' synchronous tails read the then-current buffers, so there is
	 * nothing to serialize against.
	 */
	applyLocalChange(change: CodeChange): void {
		if (this.#fatal || this.#disposed || !this.#ready) return;
		if (isEmptyChange(change)) return;
		this.#display = applyCodeChange(this.#display, change);
		// Submissions compose: everything typed since the last ack rides one submit, so submissions
		// land at roughly RTT granularity rather than one per keystroke.
		this.#pending = isEmptyChange(this.#pending)
			? change
			: composeCodeChange(this.#pending, change);
		this.#notifyUnacknowledgedEdits();
		this.#scheduleSubmit();
	}

	// =====================================================================================
	// Submission

	#scheduleSubmit(): void {
		if (this.#submitScheduled || this.#disposed) return;
		this.#submitScheduled = true;
		queueMicrotask(() => {
			this.#submitScheduled = false;
			this.#enqueue(async () => this.#maybeSubmit());
		});
	}

	#maybeSubmit(): void {
		if (this.#fatal || this.#disposed || !this.#ready) return;
		if (this.#inflight !== null || isEmptyChange(this.#pending)) return;

		const submission: CodeChangeSubmission = {
			generation: this.#generation,
			revision: this.#appliedRevision,
			clientId: this.#clientId,
			seq: ++this.#seq,
			change: this.#pending,
		};
		// `wire` and `change` start as the same value and then diverge: `change` is reassigned (never
		// mutated) as remote rows rebase it, while `wire` keeps the payload as first sent.
		// No `#notifyUnacknowledgedEdits()`: moving `#pending` into `#inflight` leaves
		// `hasLocalEdits()` exactly as it was, and both buffers are still unacknowledged.
		this.#inflight = { wire: submission, change: this.#pending };
		this.#pending = EMPTY_CHANGE;
		void this.#sendInflight();
	}

	/**
	 * Send (and re-send) the in-flight submission until it is accepted or hard-rejected.
	 *
	 * Runs outside the task queue, on purpose: rows must keep arriving and rebasing `#inflight.change`
	 * while the RPC is outstanding. Queueing this would stall the drain behind a submission that is
	 * waiting for exactly the rows the drain would deliver.
	 *
	 * The failure ladder:
	 *   transport error the delegate calls transient  -> resend `wire`, backoff;
	 *   `busy` (the authority's prefetch kept going stale) -> resend `wire`, backoff;
	 *   `capacity` (the row window is full) -> surface `OtBlockedState` and keep resending, because a
	 *       commit reseeds the room and the very next attempt then succeeds;
	 *   `malformed` / `sequence` / `stream-gone` -> hard: discard local work, rebuild under a fresh
	 *       clientId and seq 0.
	 * Every retry resends `wire` untouched. If the previous attempt was in fact accepted and only its
	 * response was lost, the server's dedupe digest requires the identical payload; if it was not
	 * accepted, the server re-derives from the claimed revision the same transforms we applied
	 * locally, so the untransformed change is equally correct.
	 */
	async #sendInflight(): Promise<void> {
		for (;;) {
			const inflight = this.#inflight;
			if (inflight === null || this.#fatal || this.#disposed) return;

			let result: CodeChangeSubmitResult;
			try {
				result = await this.#delegate.submit(inflight.wire);
			} catch (error) {
				if (this.#disposed || this.#fatal) return;
				if (this.#inflight !== inflight) return; // superseded by a rebuild
				if (!this.#delegate.isTransientError(error)) {
					this.#hardReject(error);
					return;
				}
				await this.#backoff();
				continue;
			}

			if (this.#disposed || this.#fatal) return;
			if (this.#inflight !== inflight) return; // the echo already retired it

			if (result.ok) {
				this.#setBlocked(null);
				// Record where the submission landed as the lost-echo backstop. Normally the echo row
				// has already cleared `#inflight` (it is broadcast before this response), in which case
				// the identity check above returned. See `#tryApplyInflightAck`.
				inflight.accepted = {
					generation: result.generation,
					revision: result.revision,
				};
				this.#enqueue(() => this.#drainHeldRows());
				return;
			}

			if (result.code === "busy") {
				await this.#backoff();
				continue;
			}
			if (result.code === "capacity") {
				this.#setBlocked({ code: "capacity", message: result.message });
				await this.#backoff();
				continue;
			}
			this.#hardReject(new Error(`${result.code}: ${result.message}`));
			return;
		}
	}

	async #backoff(): Promise<void> {
		this.#delegate.onDirtyState(true);
		const delay = this.#submitBackoffMs;
		this.#submitBackoffMs = Math.min(delay * 2, SUBMIT_RETRY_MAX_MS);
		await new Promise((resolve) => setTimeout(resolve, delay));
	}

	// A hard rejection: the claimed base is gone, the seq is unusable, or the change was refused
	// outright. None of those can be cured by resending, and all of them leave the local buffers
	// rooted in state the server does not have -- so discard and rebuild under a fresh session.
	#hardReject(error: unknown): void {
		console.error("Code change rejected; discarding local edits:", error);
		this.#enqueue(() => this.#rebuild());
	}

	/**
	 * Push `hasLocalEdits()` to the delegate whenever it changes.
	 *
	 * Called from every span that changes `hasLocalEdits()`, immediately after the mutation and never
	 * across an await, so the value the surface holds always describes the buffers as they are right
	 * now -- including synchronously with the keystroke, before any submission has been scheduled.
	 * Transition-only, because a commit button that re-rendered on every keystroke would flicker for
	 * no information gained.
	 */
	#notifyUnacknowledgedEdits(): void {
		const unacknowledged = this.hasLocalEdits();
		if (unacknowledged === this.#unacknowledgedNotified) return;
		this.#unacknowledgedNotified = unacknowledged;
		this.#delegate.onUnacknowledgedEdits(unacknowledged);
	}

	#setBlocked(blocked: OtBlockedState | null): void {
		if (this.#blocked === null && blocked === null) return;
		if (this.#blocked?.code === blocked?.code) return;
		this.#blocked = blocked;
		this.#delegate.onBlocked(blocked);
	}

	// =====================================================================================

	/**
	 * Run `task` after everything already queued, and never leave the queue rejected.
	 *
	 * This is the containment boundary for the whole client: every path that can throw --
	 * `#applyRow` folding a row the buffers cannot take, a rebuild's synchronous tail -- runs inside
	 * a task, and a throw here becomes exactly one `onFatalError`. It must also survive a delegate
	 * that throws out of `onFatalError` itself: `#queue` is a chained promise, so a rejection left on
	 * it would propagate into every task enqueued afterwards and turn one bad handler into an
	 * unbounded run of unhandled rejections. The handler is therefore called inside its own
	 * try/catch, and the chain always resolves.
	 */
	#enqueue(task: () => Promise<void>): void {
		this.#queue = this.#queue.then(async () => {
			if (this.#disposed) return;
			try {
				await task();
			} catch (error) {
				if (this.#disposed || this.#fatal) return;
				this.#fatal = true;
				try {
					this.#delegate.onFatalError(error);
				} catch (handlerError) {
					console.error(
						"Collaboration fatal-error handler threw",
						handlerError,
					);
				}
			}
		});
	}
}
