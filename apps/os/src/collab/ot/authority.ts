/**
 * The server-side OT authority loop: the single ordering point for a document's uncommitted edits.
 * Adapted and modified from Cloudflare OS under Apache-2.0; see
 * `THIRD_PARTY_NOTICES.md`.
 *
 * Clients submit changes against whatever revision they last saw; this module transforms each
 * submission onto the current head, appends it to the revision stream, and broadcasts the accepted
 * row. `./code-change` owns the algebra; this module owns the *ingestion order* and the atomicity
 * of one accept. Storage, the broadcast sink, the clock and the digest are injected
 * (`OtAuthorityDeps`), so the loop is unit-testable without a runtime.
 *
 * Design rationale and history: `decisions/ot-authority.md` (why a DO and not D1, the
 * materialize/retire/prune ladder, the base-move hazard, canonical grounding, why grounding is a
 * third verb). The invariants below stay here because breaking one is silent.
 *
 * Invariants:
 *  - The base moves only inside `applySubmissionSynchronously`, in the same await-free span that
 *    appends the row that caused it, so the base can never move without the revision counter moving
 *    with it. `OtPrefetch.baseRevision` is re-checked against `state.materialized` regardless.
 *  - `StoredBase` is self-describing: it carries the revision it already includes, so
 *    `base + rows after base.revision` cannot be assembled wrong. Never infer the watermark from
 *    separately-read state.
 *  - Retired rows stay in the transform window. Materialization removes rows from the content fold,
 *    not from the window; deleting what was folded silently breaks any client that was briefly
 *    offline. "Retired" is exactly `revision <= materialized` (single generation, prefix absorption).
 *  - Pruning drops a contiguous prefix only, so the window stays gapless and `rowsSinceRevision`
 *    stays a slice. A submission based before the surviving window is rejected `stream-gone`.
 *  - The stream is always grounded on one canonical revision and the room records which
 *    (`StoredCanonical`). A commit's compare-and-swap pins to that stamp, never to whatever the
 *    canonical store reports at commit time — that substitution is silent data loss.
 *  - Every `*Synchronously` span contains no `await`; `authority.test.ts` asserts it from source.
 *  - Single generation: `generation` is carried end to end but never bumped.
 *  - Everything the loop needs is durable and rehydrated once per wake by `#load()`; there is no
 *    in-memory timer and no in-memory subscriber list.
 */

import {
	applyCodeChange,
	changedPaths,
	type CodeChange,
	type CodeContent,
	diffFiles,
	transformCodeChange,
	validateCodeChangeContent,
	validateCodeChangeSchema,
} from "./code-change";
import {
	CODE_CHANGE_CLIENT_ID_PATTERN,
	type CodeChangeRow,
	type CodeChangeSubmission,
	parseCodeChangeRow,
	type StreamPosition,
} from "./wire";
import type { CollabVerifiedIdentity } from "../presence";
import { sha256Hex } from "@tedix/worker-kit/crypto";

// =======================================================================================
// Storage layout

/** The stream head: `{generation, revision}`. Absent until the first row lands. */
const META_KEY = "ot:meta";

/** The content every live row folds on top of. Written by `seed()` and moved by materialization. */
const BASE_KEY = "ot:base";

/**
 * Which canonical revision the room is grounded on. Written by `seed()` and moved by `adopt()`;
 * never by materialization. See `StoredCanonical`.
 */
const CANONICAL_KEY = "ot:canonical";

/** One accepted row per key, `ot:row:<zero-padded revision>` — lexicographic order is revision order. */
const ROW_PREFIX = "ot:row:";

/** One dedupe record per (authenticated user, client session). See `ClientRecord`. */
const CLIENT_PREFIX = "ot:client:";

const REVISION_KEY_WIDTH = 12;

function rowKey(revision: number): string {
	return `${ROW_PREFIX}${String(revision).padStart(REVISION_KEY_WIDTH, "0")}`;
}

/**
 * The dedupe record's key. The authenticated user's key is opaque and may contain any character,
 * including the separator, so it is length-prefixed: `ot:client:<len>:<userKey>:<clientId>` cannot
 * be ambiguous, and two distinct users therefore cannot collide onto one record. (`clientId` needs
 * no such treatment — `CODE_CHANGE_CLIENT_ID_PATTERN` excludes the separator.)
 */
function clientKey(userKey: string, clientId: string): string {
	return `${CLIENT_PREFIX}${userKey.length}:${userKey}:${clientId}`;
}

/**
 * The durable base record: the content the live rows fold on top of, stamped with the revision it
 * already includes.
 *
 * Self-describing on purpose. Before materialization existed the base was written once by `seed()`
 * and could be a bare `[path, text][]`, with "the base is revision 0" left implicit. Once the base
 * moves, a bare file list is a value whose meaning depends on state read at a *different* instant —
 * precisely the shape of bug this module's span discipline exists to prevent. Carrying the
 * watermark inside the record makes `files + the rows after revision` a fold that cannot be
 * assembled wrong, whichever base a read happened to observe.
 */
interface StoredBase {
	generation: number;

	/** The revision whose content `files` is. Rows at or below it are retired. */
	revision: number;

	files: [string, string][];
}

/**
 * Structurally decode a stored base, returning `null` for anything malformed — the same never-throws
 * discipline `./wire`'s decoders carry, for the same reason: a corrupt record must degrade the room
 * into a rebuild, not throw out of a storage read.
 */
function parseStoredBase(value: unknown): StoredBase | null {
	try {
		if (typeof value !== "object" || value === null) return null;
		const record = value as Record<string, unknown>;
		const { generation, revision, files } = record;
		if (!Number.isSafeInteger(generation) || (generation as number) < 0) {
			return null;
		}
		if (!Number.isSafeInteger(revision) || (revision as number) < 0)
			return null;
		if (!Array.isArray(files)) return null;
		for (const entry of files) {
			if (!Array.isArray(entry) || entry.length !== 2) return null;
			if (typeof entry[0] !== "string" || typeof entry[1] !== "string") {
				return null;
			}
		}
		return {
			generation: generation as number,
			revision: revision as number,
			files: files as [string, string][],
		};
	} catch {
		return null;
	}
}

/**
 * Which canonical revision the room represents — the stamp a commit's compare-and-swap is pinned
 * to. Pinning to whatever the canonical store reports at commit time instead is silent data loss;
 * see `decisions/ot-authority.md` "Canonical grounding".
 *
 * `revision`/`revisionId` is the canonical revision the stream was grounded on (from `seed` or
 * `adopt`); `atRevision` is the stream position at which the room's content last equalled it.
 *
 * `atRevision` is the edited flag, in stream terms: `state.revision === atRevision` means nothing
 * has been accepted since grounding, so a newer canonical revision may be adopted with nothing to
 * lose; anything else means real edits exist and adoption must be user-driven. A byte-identical
 * offer is safe either way and moves the stamp alone.
 *
 * Separate from `StoredBase` on purpose: that is what lets `adopt` move the stamp without ever
 * rewriting the base — no second base-move hazard, and no read-modify-write across an await.
 */
interface StoredCanonical {
	revision: number;
	revisionId: string | null;
	atRevision: number;
}

/** The public shape of that stamp: which canonical revision, by number and immutable id. */
export interface CanonicalStamp {
	revision: number;
	revisionId: string | null;
}

/** A room with no grounding yet: revision 0 is "no canonical revision", the same value a gadget with no revision commits against. */
const UNGROUNDED: StoredCanonical = {
	revision: 0,
	revisionId: null,
	atRevision: 0,
};

/** Structurally decode the grounding record; `null` for anything malformed, like `parseStoredBase`. */
function parseStoredCanonical(value: unknown): StoredCanonical | null {
	try {
		if (typeof value !== "object" || value === null) return null;
		const record = value as Record<string, unknown>;
		const { revision, revisionId, atRevision } = record;
		if (!Number.isSafeInteger(revision) || (revision as number) < 0)
			return null;
		if (!Number.isSafeInteger(atRevision) || (atRevision as number) < 0) {
			return null;
		}
		if (revisionId !== null && typeof revisionId !== "string") return null;
		return {
			revision: revision as number,
			revisionId: revisionId as string | null,
			atRevision: atRevision as number,
		};
	} catch {
		return null;
	}
}

/**
 * Per (authenticated user, client editing session) dedupe record: the last accepted seq, where it
 * landed, and a digest of what was accepted.
 *
 * Never pruned — deleted only with the room. Expiring them reopens a double-apply hole, and OT
 * (unlike a CRDT) does not tolerate double application.
 *
 * Scoped to the authenticated user, not to `clientId` alone: `clientId` rides the public broadcast
 * echo, so an unscoped record would let one collaborator consume another's next seq.
 *
 * Rationale: `decisions/ot-authority.md` "Dedupe records are never pruned".
 */
export interface ClientRecord {
	/** The last accepted submission's seq. Only `seq + 1` may continue the session. */
	seq: number;

	/** Where the last accepted submission landed, replayed verbatim to a retry. */
	generation: number;
	revision: number;

	/**
	 * Digest of the accepted submission's content. A same-seq retry must match it: acknowledging
	 * different content as "already applied" would silently strand a change the server never ran.
	 */
	digest: string;
}

/**
 * How many live (unmaterialized) rows the window may hold before submissions are refused.
 *
 * Unreachable in normal operation: the live window is capped at `MATERIALIZE_THRESHOLD_ROWS` by
 * construction, because materialization runs in the same synchronous step as the accept that
 * crosses the threshold and can neither fail nor be deferred. This is a fail-safe against a
 * regression in this file (a materialization made conditional, deferred to an alarm, or allowed to
 * throw), not a product limit. See `decisions/ot-authority.md`.
 */
export const MAX_STREAM_ROWS = 4096;

/**
 * Materialize once the live window reaches this many rows.
 *
 * Upstream's number (`CHAT_CHANGE_MATERIALIZE_THRESHOLD`), kept after checking it against Tedix's
 * own costs rather than copied. Two costs pull in opposite directions. An accept folds the live
 * window (`applyCodeChange` per row) on top of the base, so the per-accept cost is O(live rows) and
 * wants this small. A materialization rewrites the base, which is the whole document, so its
 * amortized cost is O(document) / threshold per accept and wants this large: at 128 and a 64 KiB
 * document that is ~0.5 KiB of base rewrite per accept, which is noise beside the row write itself;
 * at 8 it would be 8 KiB per accept, a real tax on every keystroke batch. 128 sits in the flat part
 * of both curves. It also bounds a reconnecting client's replay to a sensible size, since
 * `rowsSince` serves retired rows too (see the header).
 */
export const MATERIALIZE_THRESHOLD_ROWS = 128;

/**
 * Materialize early once the live window's changes total this much payload, measured in UTF-16 code
 * units of their JSON.
 *
 * Deliberately not upstream's job for this number. `CHAT_CHANGE_MESSAGE_BUDGET` exists because
 * upstream materializes into a *message* whose body is the rows' composed change, and a composition
 * of many rows can exceed what one record may hold — so the budget chunks the batch. Nothing here
 * stores a composed change: the base is the resulting content, already bounded per file by
 * `MAX_FILE_TEXT_LENGTH`, so there is no chunking problem to solve and copying upstream's use would
 * be cargo cult. The budget is repurposed as the second trigger, because the costs materialization
 * removes are byte-driven, not row-driven: a single `{set}` of a 512 KiB file is one row and half
 * this budget, and three of them would make every subsequent accept copy 1.5 MiB of string data
 * through the fold long before the row count noticed. Same magnitude as upstream (1 Mi units ≈
 * 1 MiB for the ASCII-dominant source and structured text these documents hold), for the same
 * reason: it is the scale at which per-accept copying stops being free.
 */
export const MATERIALIZE_BUDGET_UNITS = 1024 * 1024;

/**
 * How long a retired row is kept as a pure transform window before it may be pruned.
 *
 * Five minutes is the tolerance a client gets for being disconnected, and under OT a client whose base aged out
 * must discard its local edits and rebuild from a fresh seed. Reconnect ladders, bfcache freezes
 * and middlebox flaps routinely cost a minute or two. Near-free: retired rows are already written,
 * excluded from the content fold, and pruning is lazy. `MAX_RETAINED_ROWS` is the backstop.
 * Rationale: `decisions/ot-authority.md`.
 */
export const RETIRED_ROW_TTL_MS = 5 * 60_000;

/**
 * Hard ceiling on the retained window (retired rows included), enforced ahead of the TTL.
 *
 * The TTL alone bounds the window by time, which under sustained load is not a bound on size: a
 * hot room accepting ten rows a second retains three thousand of them. This caps the retained
 * history and shortens the effective horizon exactly when the room is moving fast enough that a
 * five-minute-stale client's base is hopeless anyway. Live rows are never pruned whatever this
 * says, so the floor is `MATERIALIZE_THRESHOLD_ROWS` and this can never refuse an edit — it trades
 * transform horizon for storage, never availability.
 */
export const MAX_RETAINED_ROWS = 2048;

/** How many times the loop re-resolves after its prefetch went stale before giving up. */
const MAX_RESOLVE_ATTEMPTS = 4;

// =======================================================================================
// Injected dependencies

/** The DO-storage surface the authority uses. Narrower than `CollabStorage` in `../room.ts`. */
export interface OtAuthorityStorage {
	get<T>(key: string): Promise<T | undefined>;
	list<T>(options: { prefix: string }): Promise<Map<string, T>>;

	/**
	 * Enqueue a write. Called from inside the synchronous span and deliberately not awaited there:
	 * a Durable Object enqueues the write synchronously and its output gate holds every outbound
	 * message until the write commits, so a broadcast can never escape ahead of the durable row.
	 */
	put(key: string, value: unknown): Promise<void>;

	/**
	 * Enqueue a delete. Called from inside the synchronous span and deliberately not awaited there,
	 * for the same reason as `put`. Used only by `pruneRetiredRows`, and only for rows the base
	 * already contains.
	 */
	delete(key: string): Promise<void>;
}

export interface OtAuthorityDeps {
	storage: OtAuthorityStorage;

	/**
	 * Deliver one accepted row to subscribers. Called synchronously; must not throw.
	 *
	 * The row is the same object the stream holds and stores, not a copy, so it is handed over
	 * frozen. Its `change` subtree is shared and must be treated as read-only, like every change in
	 * this stack (`./code-change`); a sink that needs to alter a row builds its own.
	 */
	broadcast(row: CodeChangeRow): void;

	/** Wall clock, in epoch milliseconds. */
	now(): number;

	/** Content digest for dedupe. Defaults to SHA-256 hex. */
	digest?: (input: string) => Promise<string>;
}

// =======================================================================================
// Results

/** Why a submission was refused. Every code is a client-visible outcome, never an internal bug. */
export type CodeChangeRejection =
	/** Failed schema or content validation: the change is not well-formed against the document. */
	| "malformed"
	/** Seq gap, seq reuse with different content, or an unknown session claiming `seq > 1`. */
	| "sequence"
	/**
	 * The claimed `(generation, revision)` is not resolvable at head: another generation, a revision
	 * that never existed, or one pruned past the retention horizon. Rebuild from a fresh seed.
	 */
	| "stream-gone"
	/** The live row window is full; a fail-safe that is unreachable in normal operation, and why:
	 * see `MAX_STREAM_ROWS`. */
	| "capacity"
	/** The stream kept moving under the loop's prefetch. Retryable as-is. */
	| "busy";

export type CodeChangeSubmitResult =
	| (StreamPosition & {
			ok: true;
			/** True when this was a recognized retry, acknowledged without re-applying. */
			duplicate: boolean;
	  })
	| { ok: false; code: CodeChangeRejection; message: string };

/**
 * What an offer of a newer canonical revision did, and the grounding stamp that is in force
 * afterwards either way — so a caller that was refused still learns which revision its commits must
 * be pinned to.
 *
 *   - `adopted`  — the room was unedited (or the caller forced it): the difference landed as one
 *                  server-authored row and the stamp moved with it.
 *   - `repaired` — the room's content already equalled the offered revision byte for byte, so only
 *                  the stamp moved. Nothing was written to the document and nothing can be lost.
 *   - `current`  — the offer was not newer than the stamp already in force; nothing happened.
 *   - `edited`   — the room holds real edits the offer would destroy. Refused, deliberately: this
 *                  is the state a user must resolve, not one the server may resolve for them.
 */
export type CanonicalAdoptResult =
	| {
			ok: true;
			effect: "adopted" | "repaired" | "current";
			canonical: CanonicalStamp;
	  }
	| {
			ok: false;
			code: "edited" | "malformed" | "stream-gone" | "busy";
			message: string;
			canonical: CanonicalStamp;
	  };

// =======================================================================================
// In-memory state

/**
 * The rehydrated stream. Owned by one `OtAuthority` instance; mutated only inside the synchronous
 * spans. Exported so those spans can be property-tested directly.
 *
 * The window invariant, which everything below relies on:
 *
 *     windowBase <= materialized <= revision
 *     windowBase + rows.length === revision
 *     rows[i].revision === windowBase + i + 1
 *
 * `rows` is the transform window and holds retired rows too, so it is gapless but no longer starts
 * at revision 1: pruning drops a prefix and moves `windowBase` with it. Rows at or below
 * `materialized` are retired — already inside the base, excluded from the content fold, still
 * available to transform against.
 */
export interface OtStreamState {
	generation: number;
	revision: number;
	rows: CodeChangeRow[];

	/** The revision immediately before `rows[0]`; equal to `revision` when the window is empty. */
	windowBase: number;

	/** The revision the durable base already includes. See `StoredBase`. */
	materialized: number;

	/**
	 * Serialized size, in UTF-16 code units, of the live rows' changes — the running total
	 * `MATERIALIZE_BUDGET_UNITS` is compared against. Reset to 0 by materialization, recomputed over
	 * the live rows on a wake.
	 */
	liveChangeUnits: number;

	/** Which canonical revision this room represents, and where it was last equal to it. */
	canonical: StoredCanonical;

	clients: Map<string, ClientRecord>;
}

/** What the synchronous span was entitled to assume when its prefetch ran. */
export interface OtPrefetch {
	generation: number;
	revision: number;

	/**
	 * The `StoredBase.revision` the content below was folded from. Re-checked against
	 * `state.materialized` in the span: see property (1) in this file's header.
	 */
	baseRevision: number;

	/**
	 * The base's own files, exactly as the read returned them — the fold's starting point, kept so a
	 * span that needs the content at a revision other than head (`groundCanonicalSynchronously`) can
	 * re-fold from the same instant's base instead of reading storage inside the span.
	 */
	baseFiles: [string, string][];

	/**
	 * The content at `(generation, revision)`, or `null` when the stored base and the retained row
	 * window do not bridge — a corrupt rehydration, never a race (see `#prefetchContent`).
	 */
	content: CodeContent | null;
}

/** What `adoptCanonical` has established before entering its span. Exported for direct span tests. */
export interface PreparedAdoption {
	/** The canonical revision being offered. */
	canonical: CanonicalStamp;

	/** That revision's content, as the offering client read it from the canonical store. */
	files: CodeContent;

	/** The transport-verified identity the resulting server-authored row is attributed to. */
	author: CollabVerifiedIdentity;

	/** The user has explicitly chosen to replace an edited room's content. Never defaulted true. */
	force: boolean;
}

/**
 * What `groundCanonical` has established before entering its span: a claim, and the whole point of
 * the span is that the claim is checked against the stream rather than believed.
 */
export interface PreparedGrounding {
	/** The canonical revision the caller says it just wrote. */
	canonical: CanonicalStamp;

	/** That revision's content, as the caller committed it. */
	files: CodeContent;

	/**
	 * The stream position the caller says that content came from. Validated, never trusted: the
	 * span folds the stream to `at.revision` and refuses unless the result equals `files` exactly.
	 */
	at: StreamPosition;
}

/**
 * One consistent read of everything the base handshake hands a joining client: where the stream is,
 * what it says there, and which canonical revision that is.
 *
 * One snapshot, not three reads. The handshake used to call `head()`, `content()` and `canonical()`
 * and assemble the answer from whatever each returned; every one of those resolves on a microtask
 * and `content()` yields on a storage read, so the three could describe three different instants —
 * content at revision 2 stamped revision 1, or post-adoption content stamped with the pre-adoption
 * grounding. A client that applies a row it already has throws out of `OtClient` rather than
 * diverging quietly, which is the good outcome of a bad handshake, not a defence against one.
 */
export interface OtRoomSnapshot {
	position: StreamPosition;
	content: CodeContent;
	canonical: CanonicalStamp;
}

/** What `submit` has established before entering the span. Exported for direct span tests. */
export interface PreparedSubmission {
	submission: CodeChangeSubmission;
	author: CollabVerifiedIdentity;
	digest: string;
	recordKey: string;
}

// =======================================================================================
// The synchronous spans
//
// Four of them, and the discipline is the same in all four: every async step happens before the
// span is entered, the span re-reads live state and decides, and the decision and the write it
// authorizes are separated by nothing. `applySubmissionSynchronously` is the accept path,
// `seedSynchronously` the base-establishment path, `adoptCanonicalSynchronously` the carry-forward
// path, and `groundCanonicalSynchronously` the commit-grounding path. A guard that sits on the far
// side of an await is not a guard -- see each function's own note for what specifically breaks.

/**
 * The synchronous core of `OtAuthority.submit`: dedupe, resolve, transform, content-validate,
 * apply, append, broadcast — the whole ingestion order from step (b) on.
 *
 * *** There is no `await` in this function, and adding one reintroduces the race. ***
 *
 * A Durable Object serializes and runs each handler to completion, but only between awaits: at an
 * await on non-storage I/O the input gate does not hold, another submission can land, and the state
 * this function read before the await is then a lie it is about to extend the stream from. The
 * function is deliberately not `async`, takes its prefetched inputs as a parameter, and re-reads the
 * live state at the top: if the stream moved under the prefetch it returns `"retry"` and the caller
 * re-prefetches instead of appending against stale content. Every async step — rehydration, the
 * digest, the content prefetch — happens before this function is entered. `authority.test.ts`
 * asserts this function's source contains no `await`; that guard is not decoration.
 *
 * Exported for that test and for direct property tests; production callers go through `submit`.
 */
export function applySubmissionSynchronously(
	state: OtStreamState,
	deps: OtAuthorityDeps,
	prepared: PreparedSubmission,
	prefetched: OtPrefetch,
): CodeChangeSubmitResult | "retry" {
	const { submission, author, digest, recordKey } = prepared;

	// The prefetch's revalidation. Content is the only prefetched input today; a future prefetch
	// (a canonical read, a policy lookup) revalidates here too, or the append below is unsound.
	if (
		prefetched.generation !== state.generation ||
		prefetched.revision !== state.revision
	) {
		return "retry";
	}
	// And the base the content was folded from. Today this cannot disagree once the stamp above
	// matched, because the base moves only in this function, in the same step that bumps `revision`
	// (header property 1) -- which is exactly why the check is here rather than assumed: it is what
	// catches an edit that ever moves the base anywhere else. Applying this submission against a
	// base other than the one it was validated against is silent corruption, not a visible failure.
	if (prefetched.baseRevision !== state.materialized) return "retry";

	// ---- (b) Dedupe by (authenticated user, clientId, seq) --------------------------------
	// first, before anything that can reject the base. An already-accepted retry must get its
	// recorded landing spot back even when its base is no longer resolvable — recognition must
	// never require the base to remain transformable, or a client that retried across a
	// destructive bump would be told to rebuild after its change had in fact been applied.
	const record = state.clients.get(recordKey);
	if (record !== undefined) {
		if (submission.seq === record.seq) {
			if (digest !== record.digest) {
				return reject(
					"sequence",
					"A submission reused a seq with different content; discard local edits and rebuild under a fresh clientId.",
				);
			}
			// A retry of the already-accepted change: acknowledge without re-applying.
			return {
				ok: true,
				duplicate: true,
				generation: record.generation,
				revision: record.revision,
			};
		}
		// Only seq + 1 continues a session. This is what enforces at most one submission in flight
		// per client, server-side: a client that pipelined a second submission before the first was
		// acknowledged has its second rejected, rather than the server assuming it never happens.
		if (submission.seq !== record.seq + 1) {
			return reject(
				"sequence",
				"Out-of-sequence submission; discard local edits and rebuild under a fresh clientId.",
			);
		}
	} else if (submission.seq !== 1) {
		return reject(
			"sequence",
			"Unknown client session with seq > 1; discard local edits and rebuild under a fresh clientId.",
		);
	}

	// ---- (c) Resolve the claimed revision position ----------------------------------------
	// Single generation: anything not resolvable at head is gone. No epoch bridge (see the header).
	if (submission.generation !== state.generation) {
		return reject("stream-gone", STREAM_GONE_MESSAGE);
	}
	if (submission.revision > state.revision) {
		return reject(
			"stream-gone",
			"Submission claims a revision that does not exist yet.",
		);
	}
	// The fail-safe, on the live window only: retired rows cost nothing to fold and are prunable, so
	// they must never refuse an edit. See `MAX_STREAM_ROWS` for when this can fire at all.
	if (state.revision - state.materialized >= MAX_STREAM_ROWS) {
		return reject("capacity", CAPACITY_MESSAGE);
	}
	// Retired rows are included here on purpose: a submission based inside the materialized range
	// still rebases over exactly the rows accepted since it. That is the entire reason retirement is
	// soft (see the header). Only rows pruned past the retention horizon are gone, and this returns
	// null for them -- a clean `stream-gone`, never a mistransform.
	const rows = rowsSinceRevision(state, submission.revision);
	if (rows === null) return reject("stream-gone", STREAM_GONE_MESSAGE);

	// ---- (d) Transform over every row accepted since the claimed revision ------------------
	// Each accepted row is the earlier change (`a`), the submission the later one (`b`), which is
	// the priority convention `transformCodeChange` documents: server order decides.
	let transformed: CodeChange = submission.change;
	for (const row of rows) {
		transformed = transformCodeChange(row.change, transformed).b;
	}

	// ---- (e) Content-validate the transformed change ---------------------------------------
	// Not the submitted one: lengths and boundaries only mean anything against the content the
	// change will actually apply to, which is head, not the client's stale base.
	const content = prefetched.content;
	// Only reachable on a corrupt rehydration whose base and row window do not bridge; the client's
	// correct action is the same as for any unresolvable position, so it gets the same answer.
	if (content === null) return reject("stream-gone", STREAM_GONE_MESSAGE);
	try {
		validateCodeChangeContent(transformed, content);
	} catch (error) {
		return reject("malformed", (error as Error).message);
	}

	// ---- (f) Apply, append, broadcast ------------------------------------------------------
	const revision = state.revision + 1;
	// Frozen because this one object is simultaneously the appended stream row, the value handed to
	// `storage.put`, and the value handed to `broadcast` — three aliases of live stream state. The
	// `broadcast` contract says the sink must not throw; freezing means it also cannot renumber a
	// row or restamp its author in memory, which no contract wording would actually prevent. The
	// freeze is shallow and O(1): `change` is a shared subtree, immutable by this stack's convention
	// (see `./code-change`'s type docs), and deep-freezing it would put a walk of the whole change
	// on the accept path for a hazard the convention already covers.
	const row: CodeChangeRow = Object.freeze({
		generation: state.generation,
		revision,
		timestampMs: deps.now(),
		author,
		change: transformed,
		submission: { clientId: submission.clientId, seq: submission.seq },
	});
	// The dedupe record is written in the same synchronous step as the row. Split across an await,
	// a concurrent retry could observe the row without the record and apply the change twice.
	const clientRecord: ClientRecord = {
		seq: submission.seq,
		generation: state.generation,
		revision,
		digest,
	};

	state.revision = revision;
	state.rows.push(row);
	state.clients.set(recordKey, clientRecord);

	void deps.storage.put(rowKey(revision), row);
	void deps.storage.put(META_KEY, {
		generation: state.generation,
		revision,
	} satisfies StreamPosition);
	void deps.storage.put(recordKey, clientRecord);
	deps.broadcast(row);

	// ---- (g) Materialize, retire, prune ----------------------------------------------------
	// in this span, not after it, and that placement is the safety argument rather than an
	// optimization: the base moves in the same indivisible step that appended the row it now
	// includes, so no row can be accepted "during" a materialization -- there is no during. A
	// materialize that awaited anything (re-reading the base, folding from storage) would put an
	// accept inside its own window and lose or double-count that row, which is the same hazard class
	// `seed` already shipped once. It also needs no I/O of its own: the head content is the
	// prefetched content with the change just content-validated against it, so `applyCodeChange`
	// here cannot throw.
	reclaimWindowSynchronously(state, deps, transformed, content);

	return { ok: true, duplicate: false, generation: state.generation, revision };
}

/**
 * Step (g) for every path that appends a row: materialize once the window has grown enough, then
 * prune what has outlived the retention horizon.
 *
 * *** There is no `await` in this function, and adding one reintroduces the race. ***
 *
 * `contentBefore` is the content the row's `change` was validated against, so
 * `applyCodeChange(contentBefore, change)` is head — computed here, and only when a materialization
 * actually runs, so a non-materializing accept pays nothing. Shared by the accept span and the
 * adoption span so the two can never drift on when the base moves.
 */
function reclaimWindowSynchronously(
	state: OtStreamState,
	deps: OtAuthorityDeps,
	change: CodeChange,
	contentBefore: CodeContent,
): void {
	state.liveChangeUnits += JSON.stringify(change).length;
	if (
		state.revision - state.materialized >= MATERIALIZE_THRESHOLD_ROWS ||
		state.liveChangeUnits >= MATERIALIZE_BUDGET_UNITS
	) {
		materializeSynchronously(
			state,
			deps,
			applyCodeChange(contentBefore, change),
		);
	}
	// Every accept, not only a materializing one, so the retention horizon is a real horizon rather
	// than something that only advances in 128-row jumps. It is O(1) when there is nothing to drop.
	pruneRetiredRows(state, deps);
}

/**
 * Move the base forward to `contentAtHead`, retiring every row through `state.revision`.
 *
 * *** There is no `await` in this function, and adding one reintroduces the race. ***
 *
 * The span with the sharpest failure mode. It is only ever reached through
 * `reclaimWindowSynchronously`, from inside a span (`applySubmissionSynchronously` or
 * `adoptCanonicalSynchronously`) whose caller has already revalidated that `contentAtHead`
 * describes `state.revision`; an await here would break that between the fold and the write,
 * installing a base that omits or double-counts a row that landed meanwhile. Retirement
 * is the watermark move alone -- the rows are left exactly where they are, which is what keeps them
 * available to transform against (see the header).
 *
 * Exported for the structural no-await test and for direct span tests.
 */
export function materializeSynchronously(
	state: OtStreamState,
	deps: OtAuthorityDeps,
	contentAtHead: CodeContent,
): void {
	void deps.storage.put(BASE_KEY, {
		generation: state.generation,
		revision: state.revision,
		files: [...contentAtHead],
	} satisfies StoredBase);
	state.materialized = state.revision;
	state.liveChangeUnits = 0;
}

/**
 * Hard-delete retired rows that have outlived the retention horizon, oldest first.
 *
 * *** There is no `await` in this function, and adding one reintroduces the race. ***
 *
 * Called from inside `applySubmissionSynchronously`, so the deletes commit atomically with the row
 * that triggered them; an await would let a submission be admitted against a window this function
 * is midway through dismantling.
 *
 * A contiguous prefix only — this keeps the window gapless by construction, so the window invariant
 * on `OtStreamState` holds unconditionally and the transform window stays a slice. Dropping a row
 * out of the middle would leave a hole every earlier position must then be rejected for.
 *
 * A live row is never dropped, whatever `MAX_RETAINED_ROWS` says: the base does not contain it, so
 * deleting it would delete content. That is why the loop breaks on the watermark before it
 * considers age at all.
 */
export function pruneRetiredRows(
	state: OtStreamState,
	deps: OtAuthorityDeps,
): void {
	const cutoff = deps.now() - RETIRED_ROW_TTL_MS;
	let dropped = 0;
	while (dropped < state.rows.length) {
		const row = state.rows[dropped]!;
		if (row.revision > state.materialized) break;
		const overRetained = state.rows.length - dropped > MAX_RETAINED_ROWS;
		if (!overRetained && row.timestampMs > cutoff) break;
		dropped += 1;
	}
	if (dropped === 0) return;
	for (let index = 0; index < dropped; index += 1) {
		void deps.storage.delete(rowKey(state.rows[index]!.revision));
	}
	state.rows = state.rows.slice(dropped);
	state.windowBase += dropped;
}

const STREAM_GONE_MESSAGE =
	"The room's change stream moved on and this edit cannot be carried across; rebuild from a fresh revision.";

/**
 * The `capacity` refusal, and it is not a user-actionable limit.
 *
 * `MAX_STREAM_ROWS` is only reachable if in-span reclamation regressed, so the copy names a server
 * fault that holds the edits and clears itself (what the client's retry ladder does) rather than
 * telling the user to commit — the one action the surface has already had to disable.
 *
 * And it does not promise delivery: `capacity` implies an unacknowledged submission, so this alert
 * and `UNACKNOWLEDGED_COMMIT_MESSAGE` (in `@/components/canvas-doc-panel`) render at the same time
 * and must agree — there is no offline log (`@/lib/use-collab-doc`), so a disconnect before the
 * acknowledgement loses the edits. See `decisions/ot-authority.md`.
 */
export const CAPACITY_MESSAGE =
	"The room's change window stopped being reclaimed, which is a fault on our side, not something you did. Your edits are kept and resent until the room recovers. If the connection drops first, they are discarded.";

function reject(
	code: CodeChangeRejection,
	message: string,
): CodeChangeSubmitResult {
	return { ok: false, code, message };
}

/**
 * The synchronous core of `OtAuthority.seed`: decide whether the base may still be written, and
 * write it, with nothing able to land in between.
 *
 * *** There is no `await` in this function, and adding one reintroduces the race. ***
 *
 * The second place in this file where that discipline is load-bearing, for the same reason as
 * `applySubmissionSynchronously`: a Durable Object runs a handler to completion only BETWEEN
 * awaits. `seed` must read storage to learn whether a base already exists, and that read yields. A
 * submission landing inside that window is accepted against the empty base and content-validated
 * against it, so writing the base afterwards installs it underneath an already-accepted row --
 * `content()` becomes a fold over content the server never had, and an `edit`-bearing row throws
 * outright rather than merely diverging. So the read is hoisted into the caller as a prefetch, and
 * everything that decides -- the stream re-check and the put -- lives here.
 *
 * Exported for the structural no-await test and for direct span tests, exactly like the submission
 * span; production callers go through `seed`.
 */
export function seedSynchronously(
	state: OtStreamState,
	deps: OtAuthorityDeps,
	base: CodeContent,
	canonical: CanonicalStamp,
	basePresent: boolean,
): { seeded: boolean } {
	// Re-checked after the caller's read, never only before it. `state` is the live object the
	// submission span mutates, so a submission accepted during that read is visible here -- which
	// is the entire point of re-checking rather than trusting what `seed` saw on entry.
	if (state.rows.length > 0 || state.revision !== 0) return { seeded: false };
	if (basePresent) return { seeded: false };
	// Not awaited, for the reason `OtAuthorityStorage.put` documents: a Durable Object enqueues the
	// write synchronously and its output gate holds the response until the write commits.
	void deps.storage.put(BASE_KEY, {
		generation: state.generation,
		revision: 0,
		files: [...base],
	} satisfies StoredBase);
	// The base and the stamp that says which canonical revision it is are written in the same
	// synchronous step. A base whose grounding is written separately is a base whose meaning
	// depends on state read at a different instant -- the shape of bug this file is built around,
	// and the shape of the commit that overwrote an unseen revision.
	groundSynchronously(state, deps, {
		revision: canonical.revision,
		revisionId: canonical.revisionId,
		atRevision: 0,
	});
	return { seeded: true };
}

/** Write the grounding stamp and mirror it into live state. Synchronous, like every other write here. */
function groundSynchronously(
	state: OtStreamState,
	deps: OtAuthorityDeps,
	canonical: StoredCanonical,
): void {
	state.canonical = canonical;
	void deps.storage.put(CANONICAL_KEY, canonical satisfies StoredCanonical);
}

/**
 * The synchronous core of `OtAuthority.adoptCanonical`: decide whether the room may be carried
 * forward onto a newer canonical revision, and carry it, with nothing able to land in between.
 *
 * *** There is no `await` in this function, and adding one reintroduces the race. ***
 *
 * The decision this span makes is "does the room hold edits an adoption would destroy", and the
 * write it authorizes is a row that destroys exactly those edits. A guard on the far side of an
 * await would decide about a room that has since been typed in.
 *
 * Adoption is one server-authored row, not a base swap. Swapping the stored base under a live
 * stream would move every replica's ground truth with no row to tell them.
 *
 * The three outcomes, in the order they are decided:
 *   1. Not newer — the stamp in force is at or ahead of the offer; nothing happens. This makes
 *      concurrent offers idempotent, and the stamp never moves backwards.
 *   2. BYTE-identical — the room's content already equals the offered revision; the stamp moves
 *      alone, edited or not. This is the path a room takes after committing its own text.
 *   3. Different — an unedited room (`state.revision === state.canonical.atRevision`) adopts. An
 *      edited room is refused unless the caller forced it; the surface blocks Commit and offers the
 *      user an explicit, warned replacement.
 *
 * Rationale: `decisions/ot-authority.md` "Adoption is one server-authored row".
 *
 * Exported for the structural no-await test and for direct span tests; production callers go
 * through `adoptCanonical`.
 */
export function adoptCanonicalSynchronously(
	state: OtStreamState,
	deps: OtAuthorityDeps,
	prepared: PreparedAdoption,
	prefetched: OtPrefetch,
): CanonicalAdoptResult | "retry" {
	// The same revalidation the accept span runs, for the same reason: `prefetched.content` is what
	// the difference below is computed against, and the row is appended at the position this stamp
	// names. See `applySubmissionSynchronously`.
	if (
		prefetched.generation !== state.generation ||
		prefetched.revision !== state.revision ||
		prefetched.baseRevision !== state.materialized
	) {
		return "retry";
	}
	const stamp = (): CanonicalStamp => ({
		revision: state.canonical.revision,
		revisionId: state.canonical.revisionId,
	});

	// (1) Not newer. Ordinary repeated offers remain idempotent. Only an
	// explicit recovery of the exact current saved version may discard edits
	// without requiring a newer canonical revision to exist first.
	const restoringCurrent =
		prepared.force &&
		prepared.canonical.revision === state.canonical.revision &&
		prepared.canonical.revisionId === state.canonical.revisionId;
	if (
		prepared.canonical.revision <= state.canonical.revision &&
		!restoringCurrent
	) {
		return { ok: true, effect: "current", canonical: stamp() };
	}
	const content = prefetched.content;
	if (content === null) {
		return {
			ok: false,
			code: "stream-gone",
			message: STREAM_GONE_MESSAGE,
			canonical: stamp(),
		};
	}

	// (2) Byte-identical: the stamp alone, and no row at all.
	const change = diffFiles(content, prepared.files);
	if (change.length === 0) {
		groundSynchronously(state, deps, {
			revision: prepared.canonical.revision,
			revisionId: prepared.canonical.revisionId,
			atRevision: state.revision,
		});
		return { ok: true, effect: "repaired", canonical: stamp() };
	}

	// (3) Different.
	const edited = state.revision !== state.canonical.atRevision;
	if (edited && !prepared.force) {
		return {
			ok: false,
			code: "edited",
			message:
				"The shared draft has unsaved changes this revision would replace; the room was left as it is.",
			canonical: stamp(),
		};
	}
	// Server-built, but validated like anything else that enters the stream: a canonical revision
	// too large for the document's own limits must be refused, not appended and discovered later.
	try {
		validateCodeChangeSchema(change);
		validateCodeChangeContent(change, content);
	} catch (error) {
		return {
			ok: false,
			code: "malformed",
			message: (error as Error).message,
			canonical: stamp(),
		};
	}

	const revision = state.revision + 1;
	// Frozen and aliased three ways, exactly like an accepted submission's row; see the freeze note
	// in `applySubmissionSynchronously`. No `submission` echo: this row is server-authored, so no
	// client has a pending edit to retire on it.
	const row: CodeChangeRow = Object.freeze({
		generation: state.generation,
		revision,
		timestampMs: deps.now(),
		author: prepared.author,
		change,
	});
	state.revision = revision;
	state.rows.push(row);
	void deps.storage.put(rowKey(revision), row);
	void deps.storage.put(META_KEY, {
		generation: state.generation,
		revision,
	} satisfies StreamPosition);
	// In the same step as the row, so the stamp can never name a revision the content does not have.
	groundSynchronously(state, deps, {
		revision: prepared.canonical.revision,
		revisionId: prepared.canonical.revisionId,
		atRevision: revision,
	});
	deps.broadcast(row);
	reclaimWindowSynchronously(state, deps, change, content);

	return { ok: true, effect: "adopted", canonical: stamp() };
}

/**
 * The synchronous core of `OtAuthority.groundCanonical`: decide whether the room may be re-grounded
 * on a canonical revision the caller says it just wrote from a named stream position, and move the
 * stamp, with nothing able to land in between.
 *
 * *** There is no `await` in this function, and adding one reintroduces the race. ***
 *
 * Adoption asks "is the room's content NOW equal to this revision"; grounding asks "was it, at the
 * position the caller committed from". Why this verb exists at all (a room that keeps typing
 * through its own commit wedges permanently under adoption): `decisions/ot-authority.md`.
 *
 * A peer cannot forge one. `prepared` is a client claim, and every part that matters is re-derived
 * here from the stream rather than believed:
 *   - the position is resolved against the live window (`contentAtRevision`); a position the stream
 *     never held, or one pruned past the retention horizon, is refused;
 *   - the content at that position is folded by the server and compared byte for byte with the
 *     files the caller says are canonical revision N.
 * A caller can never move the stamp onto a position whose content it does not also supply, so no
 * peer's unsaved edits can be relabelled as committed.
 *
 * Nothing is ever written to the document — the only write is the grounding stamp, so a refusal and
 * an acceptance both leave the room's text exactly as it was.
 *
 * This span revalidates less than the accept span, and that is not a hole: it reads a historical
 * fact (content at `at.revision` is immutable once the stream passed it — rows are frozen, pruning
 * drops only a prefix the base contains, and a base at a given revision is written at most once).
 * A fold that reached `at.revision` can only become unavailable, which `contentAtRevision` reports
 * as `null`. What does move — `state.generation`, `state.revision`, `state.canonical` — is read
 * here, inside the span, immediately before the put.
 *
 * Exported for the structural no-await test and for direct span tests; production callers go
 * through `groundCanonical`.
 */
export function groundCanonicalSynchronously(
	state: OtStreamState,
	deps: OtAuthorityDeps,
	prepared: PreparedGrounding,
	prefetched: OtPrefetch,
): CanonicalAdoptResult | "retry" {
	// A generation the stream has left behind makes the claimed position meaningless: the same
	// number names a different row. Single-generation today, so this is unreachable in operation and
	// is here for the same reason the accept span's base re-check is.
	if (prefetched.generation !== state.generation) return "retry";
	const stamp = (): CanonicalStamp => ({
		revision: state.canonical.revision,
		revisionId: state.canonical.revisionId,
	});

	// (1) Not newer. Identical to adoption's first branch, and it must stay first: a stamp already
	// at or ahead of the claim is not something a re-delivered commit answer may walk backwards.
	if (prepared.canonical.revision <= state.canonical.revision) {
		return { ok: true, effect: "current", canonical: stamp() };
	}
	if (
		prepared.at.generation !== state.generation ||
		prepared.at.revision > state.revision
	) {
		return {
			ok: false,
			code: "stream-gone",
			message: STREAM_GONE_MESSAGE,
			canonical: stamp(),
		};
	}

	// (2) The check. Fold the stream to the claimed position and compare it with what the caller
	// says that position was. Everything this verb is allowed to do rests on this line.
	const at = contentAtRevision(state, prefetched, prepared.at.revision);
	if (at === null) {
		return {
			ok: false,
			code: "stream-gone",
			message: STREAM_GONE_MESSAGE,
			canonical: stamp(),
		};
	}
	if (diffFiles(at, prepared.files).length > 0) {
		return {
			ok: false,
			code: "edited",
			message:
				"The room's content at the position this commit named is not the revision it claims; the room was left as it is.",
			canonical: stamp(),
		};
	}

	// (3) Move the stamp alone. `atRevision` is the position that was just proven equal to the
	// revision, so a room that has typed since reads as edited relative to it -- which is exactly
	// what it is -- while its commits pin the revision its text actually descends from.
	groundSynchronously(state, deps, {
		revision: prepared.canonical.revision,
		revisionId: prepared.canonical.revisionId,
		atRevision: prepared.at.revision,
	});
	return { ok: true, effect: "repaired", canonical: stamp() };
}

/**
 * The content the stream held at `revision`, folded from the prefetched base.
 *
 * `null` when the window cannot reach that position from the base the prefetch read: the rows
 * between them were pruned, the base is ahead of the position (its rows are retired into it and
 * cannot be un-applied), or the two do not bridge at all. Every one of those is a clean refusal.
 */
function contentAtRevision(
	state: OtStreamState,
	prefetched: OtPrefetch,
	revision: number,
): CodeContent | null {
	if (prefetched.content === null) return null;
	if (revision === prefetched.revision) return prefetched.content;
	if (revision < prefetched.baseRevision) return null;
	const rows = rowsSinceRevision(state, prefetched.baseRevision);
	if (rows === null) return null;
	const upTo = rows.filter((row) => row.revision <= revision);
	if (upTo.length !== revision - prefetched.baseRevision) return null;
	return foldRows(new Map(prefetched.baseFiles), upTo);
}

/**
 * The transform window: rows after `afterRevision` through head, in revision order, retired rows
 * included. A submission based at `afterRevision` rebases over exactly these.
 *
 * `null` when the window cannot serve the position: before the retained window (pruned past the
 * retention horizon), after head, or — only on a corrupt rehydration — across a gap. The caller
 * turns that into a rejection, never a mistransform.
 */
function rowsSinceRevision(
	state: OtStreamState,
	afterRevision: number,
): CodeChangeRow[] | null {
	if (afterRevision < state.windowBase || afterRevision > state.revision) {
		return null;
	}
	const rows = state.rows.slice(afterRevision - state.windowBase);
	if (rows.length !== state.revision - afterRevision) return null;
	for (let index = 0; index < rows.length; index += 1) {
		if (rows[index]!.revision !== afterRevision + index + 1) return null;
	}
	return rows;
}

// =======================================================================================
// The authority

/**
 * One document's change-stream authority. Construct one per Durable Object instance; it rehydrates
 * lazily on first use and holds the stream in memory for the life of the wake.
 */
export class OtAuthority {
	#state?: Promise<OtStreamState>;

	/**
	 * Whether this wake has already written the base. Two concurrent `seed` calls both issue their
	 * hoisted read before either writes, so neither read can report the other's base however
	 * promptly it commits — and without this flag both would write, each with a different base, and
	 * both would answer `seeded: true`. The stream re-check in the span does not cover it: no row
	 * has landed yet in that race. It is in-memory only because it guards a race between two calls
	 * on one instance; across a wake, the durable read is authoritative.
	 */
	#baseWritten = false;

	constructor(private readonly deps: OtAuthorityDeps) {}

	/**
	 * Seed the stream's base content. Idempotent and refused once anything has been accepted: the
	 * base is what every row transforms on top of, so replacing it under a live stream would
	 * silently redefine what every accepted row meant.
	 *
	 * Runs the same prefetch-then-synchronous-span discipline as `submit`: the storage read is
	 * hoisted, and the decision plus the write happen in `seedSynchronously` with no await between
	 * them. See that function for why the guard cannot be left on the other side of the read.
	 */
	async seed(
		base: CodeContent,
		canonical: CanonicalStamp,
	): Promise<{ seeded: boolean }> {
		const state = await this.#load();
		const existing = await this.deps.storage.get<unknown>(BASE_KEY);

		// ==== synchronous span: no await from here through the base write ====
		const outcome = seedSynchronously(
			state,
			this.deps,
			base,
			canonical,
			existing !== undefined || this.#baseWritten,
		);
		if (outcome.seeded) this.#baseWritten = true;
		return outcome;
	}

	/** Which canonical revision this room represents. `revision` 0 means it is not grounded yet. */
	async canonical(): Promise<CanonicalStamp> {
		const state = await this.#load();
		return {
			revision: state.canonical.revision,
			revisionId: state.canonical.revisionId,
		};
	}

	/**
	 * Offer the room a newer canonical revision.
	 *
	 * Runs the same prefetch-then-synchronous-span discipline as `submit`, including its
	 * re-resolve loop: the content the difference is computed from is prefetched, and the decision
	 * plus every write happen in `adoptCanonicalSynchronously` with no await between them.
	 */
	async adoptCanonical(
		prepared: PreparedAdoption,
	): Promise<CanonicalAdoptResult> {
		const state = await this.#load();
		for (let attempt = 0; ; attempt += 1) {
			const prefetched = await this.#prefetchContent(state);

			// ==== synchronous span: no await from here through the row write ====
			const outcome = adoptCanonicalSynchronously(
				state,
				this.deps,
				prepared,
				prefetched,
			);
			if (outcome !== "retry") return outcome;
			if (attempt + 1 >= MAX_RESOLVE_ATTEMPTS) {
				return {
					ok: false,
					code: "busy",
					message: "The room is changing too quickly; please retry.",
					canonical: {
						revision: state.canonical.revision,
						revisionId: state.canonical.revisionId,
					},
				};
			}
		}
	}

	/**
	 * Re-ground the room on a canonical revision the caller says it just committed from a named
	 * stream position. Moves the grounding stamp and writes nothing else.
	 *
	 * The claim is verified, not believed: `groundCanonicalSynchronously` folds the stream to the
	 * claimed position and refuses unless the content there is byte-for-byte the revision named.
	 * See that function for why a peer cannot forge one, and the file header for why this verb
	 * exists at all instead of being folded into `adoptCanonical`.
	 *
	 * No re-resolve loop, unlike `submit` and `adoptCanonical`, and that is deliberate rather than
	 * an omission: this span appends nothing at head and reads a historical fact that cannot move
	 * (see its note). Retrying a room that is being typed in fast — which is exactly the room this
	 * verb exists for — would turn a decidable question into `busy`.
	 */
	async groundCanonical(
		prepared: PreparedGrounding,
	): Promise<CanonicalAdoptResult> {
		const state = await this.#load();
		const prefetched = await this.#prefetchContent(state);

		// ==== synchronous span: no await from here through the stamp write ====
		const outcome = groundCanonicalSynchronously(
			state,
			this.deps,
			prepared,
			prefetched,
		);
		if (outcome !== "retry") return outcome;
		return {
			ok: false,
			code: "busy",
			message: "The room is changing too quickly; please retry.",
			canonical: {
				revision: state.canonical.revision,
				revisionId: state.canonical.revisionId,
			},
		};
	}

	/**
	 * Everything the base handshake answers with, read at one instant: the stream position, the
	 * content there, and which canonical revision that content is.
	 *
	 * There is exactly one `await` after rehydration, and everything that describes the room is
	 * taken in its synchronous continuation. Assembling the same answer from `head()`, `content()`
	 * and `canonical()` cannot state that: each resolves separately, so the three may describe three
	 * different instants and the client is handed a base whose stamp does not name its bytes.
	 *
	 * Throws only when the stored base and the retained row window do not bridge — a corrupt
	 * rehydration, not a race. See `content()`.
	 */
	async snapshot(): Promise<OtRoomSnapshot> {
		const state = await this.#load();
		const stored = await this.deps.storage.get<unknown>(BASE_KEY);
		// ==== synchronous continuation: base, window, position and grounding at one instant ====
		const prefetched = prefetchFrom(state, stored);
		if (prefetched.content === null) {
			throw new Error(
				"The room's stored base and retained row window do not bridge; the stream must be rebuilt.",
			);
		}
		return {
			position: {
				generation: prefetched.generation,
				revision: prefetched.revision,
			},
			content: new Map(prefetched.content),
			canonical: {
				revision: state.canonical.revision,
				revisionId: state.canonical.revisionId,
			},
		};
	}

	/** The current stream head. */
	async head(): Promise<StreamPosition> {
		const state = await this.#load();
		return { generation: state.generation, revision: state.revision };
	}

	/**
	 * The document's current content: the base with every live row applied. Retired rows are already
	 * inside the base, so folding them again would double-apply them.
	 *
	 * Throws only when the stored base and the retained row window do not bridge — a corrupt
	 * rehydration, not a race (see `#prefetchContent`). There is no content to return in that case
	 * and inventing one would be the silent divergence this module exists to prevent.
	 */
	async content(): Promise<CodeContent> {
		return (await this.snapshot()).content;
	}

	/**
	 * The rows a subscriber at `position` has not seen — what a reconnecting client asks for. `null`
	 * when the position is not resolvable (another generation, or a revision that never existed), in
	 * which case the client must reseed rather than replay.
	 */
	async rowsSince(position: StreamPosition): Promise<CodeChangeRow[] | null> {
		const state = await this.#load();
		if (position.generation !== state.generation) return null;
		if (position.revision > state.revision) return null;
		return rowsSinceRevision(state, position.revision);
	}

	/**
	 * Ingest one client submission. `author` is the transport-verified identity of the submitter —
	 * `author.key` is the authenticated principal the dedupe record is scoped to, and the client's
	 * `clientId` is never trusted as identity.
	 *
	 * The ingestion order, in full:
	 *   (a) schema-validate the change — before any transform, because transformation is structural
	 *       and must never see malformed input;
	 *   (b) dedupe by (user, clientId, seq) — before anything that can reject the base;
	 *   (c) resolve the claimed revision position;
	 *   (d) transform over the rows accepted since it;
	 *   (e) content-validate the transformed change;
	 *   (f) apply, append, broadcast;
	 *   (g) materialize the window into the base once it has grown enough, then prune retired rows
	 *       that have outlived the retention horizon.
	 * Steps (b) through (g) run in one synchronous span; see `applySubmissionSynchronously`.
	 */
	async submit(
		submission: CodeChangeSubmission,
		author: CollabVerifiedIdentity,
	): Promise<CodeChangeSubmitResult> {
		const state = await this.#load();

		// ---- (a) Schema-validate, before any transform -------------------------------------
		const invalid = validateSubmissionShape(submission);
		if (invalid !== null) return reject("malformed", invalid);

		const prepared: PreparedSubmission = {
			submission,
			author,
			digest: await (this.deps.digest ?? sha256Hex)(digestInput(submission)),
			recordKey: clientKey(author.key, submission.clientId),
		};

		for (let attempt = 0; ; attempt += 1) {
			// The prefetch. Everything async the span needs is gathered here, never inside it.
			const prefetched = await this.#prefetchContent(state);

			// ==== synchronous span: no await from here through the row write ====
			const outcome = applySubmissionSynchronously(
				state,
				this.deps,
				prepared,
				prefetched,
			);
			if (outcome !== "retry") return outcome;
			// The stream moved while the prefetch awaited. Re-resolve against fresh state rather
			// than failing a submission that is still perfectly transformable.
			if (attempt + 1 >= MAX_RESOLVE_ATTEMPTS) {
				return reject(
					"busy",
					"The room is changing too quickly; please retry.",
				);
			}
		}
	}

	/** Rehydrate the stream from DO storage exactly once per wake. Single-flight, like `../room.ts`. */
	#load(): Promise<OtStreamState> {
		this.#state ??= (async () => {
			const { storage } = this.deps;
			const [meta, storedBase, storedCanonical, storedRows, storedClients] =
				await Promise.all([
					storage.get<StreamPosition>(META_KEY),
					storage.get<unknown>(BASE_KEY),
					storage.get<unknown>(CANONICAL_KEY),
					storage.list<unknown>({ prefix: ROW_PREFIX }),
					storage.list<ClientRecord>({ prefix: CLIENT_PREFIX }),
				]);
			// The base is read here, not inferred, because it carries the materialization watermark:
			// after a wake there is no other record of which rows are retired, and guessing would
			// either double-apply a folded row or drop a live one.
			const base = parseStoredBase(storedBase);
			const baseRevision = base?.revision ?? 0;

			const rows: CodeChangeRow[] = [];
			// The window no longer starts at revision 1: pruning drops a prefix. Take the first
			// decodable row's revision as the window's origin and require contiguity from there.
			let windowBase = -1;
			for (const key of [...storedRows.keys()].sort()) {
				// A row that no longer decodes is a corrupt record. Stop the window there rather
				// than transforming across the hole: `rowsSinceRevision` then refuses every
				// submission based at or before it, which is a rebuild, not a divergence.
				const row = parseCodeChangeRow(storedRows.get(key));
				if (row === null) break;
				if (windowBase < 0) windowBase = row.revision - 1;
				if (row.revision !== windowBase + rows.length + 1) break;
				rows.push(row);
			}
			// With no rows at all the meta record is the only surviving head -- which is the normal
			// state for a fully materialized, fully pruned room, not an error.
			if (windowBase < 0) windowBase = meta?.revision ?? 0;
			// The rows are otherwise authoritative for the head: a row is written in the same
			// synchronous step as the meta record, so they cannot disagree, and truncating to the
			// decodable prefix must move the head with them.
			let revision = windowBase + rows.length;

			// The base and the window must bridge: `windowBase <= baseRevision <= revision`. A base
			// ahead of the window means the rows between them are gone while still live, and a
			// window that starts above the base means the same thing from the other side; trusting
			// either would transform a submission over rows the base already contains and apply
			// them twice. Neither is reachable in operation -- pruning only ever drops rows the base
			// contains, and the base moves in the same atomic step as the row it absorbs -- so this
			// is a corrupt-storage guard: fall back to the base alone, which makes every stale
			// position reject with `stream-gone` and rebuild.
			if (windowBase > baseRevision || baseRevision > revision) {
				rows.length = 0;
				windowBase = baseRevision;
				revision = baseRevision;
			}

			let liveChangeUnits = 0;
			for (const row of rows) {
				if (row.revision > baseRevision) {
					liveChangeUnits += JSON.stringify(row.change).length;
				}
			}

			// A missing or corrupt grounding record reads as ungrounded rather than as "grounded at
			// something plausible": `revision: 0` is behind every real canonical revision, so the
			// surface blocks Commit and the room re-grounds through an ordinary adoption offer. An
			// `atRevision` ahead of the head needs no clamping -- it simply cannot equal
			// `state.revision`, so the room reads as edited, which is the safe side of that guess.
			return {
				generation: meta?.generation ?? 0,
				revision,
				rows,
				windowBase,
				materialized: baseRevision,
				liveChangeUnits,
				canonical: parseStoredCanonical(storedCanonical) ?? UNGROUNDED,
				clients: new Map(storedClients),
			};
		})();
		return this.#state;
	}

	/**
	 * The PREFETCH: the content the next submission will be validated and applied against, stamped
	 * with the stream position and the base revision it reflects.
	 *
	 * The stamp is taken after the read. Since the base became movable, stamping first and folding
	 * `rows[0 .. stamp.revision]` can re-apply rows a newer base already contains — content the
	 * server never had, assembled without a single check firing. Everything after the `await` is one
	 * synchronous continuation, so the base, the rows and the position are read at the same instant
	 * and the returned content is content at exactly that `(generation, revision)`. It can still go
	 * stale before the span runs, which is what the span's revalidation is for; it can no longer be
	 * internally inconsistent. See `decisions/ot-authority.md`.
	 *
	 * The fold starts at the base's own revision, so a base that moved is folded with the rows that
	 * actually follow it; `null` means the two do not bridge at all — corrupt storage, not a race.
	 * The base is re-read per submission because materialization moves it; nothing is memoized.
	 */
	async #prefetchContent(state: OtStreamState): Promise<OtPrefetch> {
		const stored = await this.deps.storage.get<unknown>(BASE_KEY);
		// ==== synchronous continuation: base, window, and stamp are read at one instant ====
		return prefetchFrom(state, stored);
	}
}

/**
 * The prefetch's synchronous half: everything after the storage read, in one continuation.
 *
 * Separated from the read so a caller that needs more than the content at one instant —
 * `snapshot`, which also needs the grounding stamp — can take all of it in the same continuation
 * as the fold, rather than assembling an answer from several independently-resolved reads.
 */
function prefetchFrom(state: OtStreamState, stored: unknown): OtPrefetch {
	const base = parseStoredBase(stored);
	const baseRevision = base?.revision ?? 0;
	const baseFiles = base?.files ?? [];
	const live =
		baseRevision > state.revision
			? null
			: rowsSinceRevision(state, baseRevision);
	return {
		generation: state.generation,
		revision: state.revision,
		baseRevision,
		baseFiles,
		content: live === null ? null : foldRows(new Map(baseFiles), live),
	};
}

function foldRows(
	base: CodeContent,
	rows: readonly CodeChangeRow[],
): CodeContent {
	let content = base;
	for (const row of rows) content = applyCodeChange(content, row.change);
	return content;
}

/** The bytes a dedupe digest covers: everything that affects what the change does. */
function digestInput(submission: CodeChangeSubmission): string {
	return JSON.stringify({
		generation: submission.generation,
		revision: submission.revision,
		change: submission.change,
	});
}

/**
 * Step (a): the submission's own invariants plus `validateCodeChangeSchema` on the change. Returns
 * the failure message, or `null` when the submission is well-formed.
 *
 * The envelope fields are re-checked even though `parseCodeChangeSubmission` established them,
 * because `submit` is also reachable from in-process producers whose values the compiler typed but
 * never range-checked. They are cheap.
 */
function validateSubmissionShape(
	submission: CodeChangeSubmission,
): string | null {
	if (!CODE_CHANGE_CLIENT_ID_PATTERN.test(submission.clientId)) {
		return "Invalid clientId.";
	}
	if (!Number.isSafeInteger(submission.seq) || submission.seq < 1) {
		return "Invalid seq.";
	}
	if (
		!Number.isSafeInteger(submission.generation) ||
		submission.generation < 0 ||
		!Number.isSafeInteger(submission.revision) ||
		submission.revision < 0
	) {
		return "Invalid generation/revision.";
	}
	try {
		validateCodeChangeSchema(submission.change);
	} catch (error) {
		return (error as Error).message;
	}
	if (changedPaths(submission.change).length === 0) {
		return "A code change submission must change something.";
	}
	return null;
}
