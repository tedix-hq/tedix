/**
 * The browser end of a collaboration room: one `OtClient` over one WebSocket,
 * presented to the editor as an `OtEditSession`. This module is the only place
 * that knows the session is backed by a socket.
 *
 * - No offline log: OT cannot merge a stale local edit, so the client discards
 *   local edits when its base ages out and the surface says so.
 * - Reconnect is a rebuild: a fresh client refetches the base. The session
 *   outlives the swap (the editor keeps its buffer and gets the difference as
 *   one remote change), stays non-null while disconnected, and reports any
 *   unacknowledged edits lost in the swap through `onDiscarded`.
 * - Commits pin their compare-and-swap to the canonical revision the room says
 *   it holds (`CollabCanonicalStamp`), never to what the store reports at commit
 *   time, which would overwrite an out-of-band revision. A newer loaded
 *   revision is offered with a `canonical` frame; the server decides.
 * - A room's own commit is grounded, not offered: the surface takes a
 *   `CollabCommitBasis` before committing and returns it through
 *   `groundCommit`, which the server validates against its stream.
 * - `commitBasis()` is null while edits are unacknowledged, and the surface
 *   disables Commit until they are; submissions compose, so this clears one
 *   round trip after the last keystroke.
 */

import { useCallback, useEffect, useState } from "react";
import {
	type CodeChange,
	type CodeContent,
	diffFiles,
} from "@/collab/ot/code-change";
import { OtClient, type OtBlockedState } from "@/collab/ot/client";
import type { OtEditSession } from "@/collab/ot/edit-session";
import type {
	CodeChangeSubmission,
	CodeChangeRow,
	StreamPosition,
} from "@/collab/ot/wire";
import type { CodeChangeSubmitResult } from "@/collab/ot/authority";
import {
	type CollabLocation,
	type CollabParticipant,
	type CollabSelection,
	collabParticipantsFromStates,
	mapSelectionThroughChange,
} from "@/collab/presence";
import {
	COLLAB_DOC_PATH,
	type CollabCanonicalStamp,
	type CollabClientFrame,
	type CollabServerFrame,
	encodeFrame,
	parseServerFrame,
} from "@/collab/protocol";

export type CollabDocStatus = "connecting" | "connected" | "disconnected";

/** One canonical revision as the surface loaded it: which revision, and what it says. */
export type CollabDocCanonical = {
	text: string;
	revision: number;
	revisionId: string | null;
};

/**
 * What a commit was written from: the exact text, and the stream position the room held it at.
 *
 * Taken synchronously, before the commit's round trip, and only from a client with nothing
 * unacknowledged — a position only describes text the server has agreed to. It is what
 * `groundCommit` later proves to the room, so the room can be re-grounded on the revision the
 * commit produced without anyone having to claim the document is unchanged.
 */
export type CollabCommitBasis = {
	text: string;
	position: StreamPosition;
};

export type UseCollabDocInput = {
	workspaceId: string;
	docKey: string;
	enabled: boolean;
	/**
	 * The canonical revision the surface has loaded, and its text.
	 *
	 * It does two jobs, both server-decided. A room with no base yet is seeded
	 * from it on the `base` handshake — the first offer establishes the base and
	 * later ones are ignored, so this is safe to send on every connect and from
	 * every peer. An already-grounded room whose canonical revision is older is
	 * offered this one (`adoptCanonical`): an unedited room carries forward
	 * automatically, an edited one is refused and `recoveryRequired` goes true.
	 *
	 * `null` while the surface has not loaded canonical truth — the socket is not
	 * opened until it has, so a room can never be seeded empty or ungrounded.
	 */
	canonical: CollabDocCanonical | null;
	location?: CollabLocation;
};

/** Result of an explicit request to restore the saved version. */
export type CollabRecoveryResult =
	| { ok: true }
	| { ok: false; message: string };

export type UseCollabDocResult = {
	/**
	 * The editing surface's whole contract; `null` only until the first connection
	 * attempt starts, and again once the document changes.
	 *
	 * It outlives a disconnect, deliberately. A reconnect is a rebuild underneath
	 * this object (see the module header), so the buffer, the peers' carets and
	 * the editor's own view survive one. Nulling it here would unmount the editor
	 * and destroy the user's cursor and scroll position every time a laptop lid
	 * closed. Read `status` to decide whether editing is live; the surface makes
	 * the document read-only while it is not.
	 */
	session: OtEditSession | null;
	status: CollabDocStatus;
	/** Verified principals, collapsed across tabs/processes; excludes this client. */
	participants: CollabParticipant[];
	/** Unique verified principals — includes the local client while connected. */
	peers: number;
	/** Local editing is blocked and the user must act. Mirrors `session.blocked()`. */
	blocked: OtBlockedState | null;
	/** Unacknowledged local edits are stuck behind a failing submission. */
	unsynced: boolean;
	/**
	 * This client holds edits the server has not agreed to yet, so `commitBasis()` is `null` and a
	 * commit taken right now could not be grounded. The surface must disable commit on this.
	 *
	 * Transient and self-clearing: every acknowledgement sets it false, and everything typed since
	 * the last one rides one composed submission, so the wait is a single round trip however fast
	 * the user types. Say so on the surface rather than presenting a dead button.
	 */
	unacknowledged: boolean;
	/**
	 * How many times local edits were actually lost; the surface warns on any.
	 *
	 * Scoped to one document's session and reset with every other derived signal when that session
	 * is torn down, so a warning can never follow the user to a document that lost nothing. A
	 * reconnect that ate no keystrokes -- including one whose in-flight submission the server had
	 * already accepted -- does not increment it: see `CollabSession`'s `#lostLocalEdits`.
	 */
	discarded: number;
	/**
	 * Which canonical revision the room represents. `null` until the first
	 * handshake answers. A commit's compare-and-swap must be pinned to this, never
	 * to whatever the canonical store reports at commit time — see the header.
	 */
	canonical: CollabCanonicalStamp | null;
	/**
	 * The room holds edits that a newer canonical revision would replace, so it
	 * refused to adopt it. Only the user can resolve this, through
	 * `replaceWithCanonical`.
	 */
	recoveryRequired: boolean;
	/**
	 * The user's explicit, warned choice to replace the shared draft with the
	 * canonical revision. Lands as one ordinary server-authored change, so peers
	 * see it converge rather than being reset.
	 */
	replaceWithCanonical: () => Promise<CollabRecoveryResult>;
	/**
	 * What a commit would be written from, taken right now: the room's text and
	 * the stream position it sits at. Call it before starting a commit and pass
	 * the result to `groundCommit` once the revision exists.
	 *
	 * `null` when the room is not live, or when this client still holds
	 * unacknowledged edits (`unacknowledged`) — the displayed text is then not any
	 * position's content, so there is nothing the room could be grounded on.
	 *
	 * A commit without a basis is not legal, and calling it legal is what wedged
	 * the document. See the module header's fourth paragraph.
	 */
	commitBasis: () => CollabCommitBasis | null;
	/**
	 * A commit succeeded: `basis` became canonical revision `revision`. Re-ground
	 * the room on it. The server validates the basis against its own stream, so
	 * this cannot move the room onto a revision its content never equalled.
	 */
	groundCommit: (
		basis: CollabCommitBasis,
		revision: number,
		revisionId: string | null,
	) => void;
};

/** Transport-level failure. `OtClient` retries these; everything else is hard. */
class CollabTransportError extends Error {}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
/**
 * How often a client re-publishes its presence. The room's roster is
 * memory-only, so a hibernation wake starts it empty; this is what refills it.
 */
const PRESENCE_REBROADCAST_MS = 15_000;

export function collabSocketUrl(
	location: { protocol: string; host: string },
	workspaceId: string,
	docKey: string,
): string {
	const scheme = location.protocol === "https:" ? "wss:" : "ws:";
	return `${scheme}//${location.host}/collab/${encodeURIComponent(
		workspaceId,
	)}/${encodeURIComponent(docKey)}`;
}

type SessionHandlers = {
	onStatus(status: CollabDocStatus): void;
	onParticipants(participants: CollabParticipant[]): void;
	onBlocked(blocked: OtBlockedState | null): void;
	onDirty(unsynced: boolean): void;
	onUnacknowledged(unacknowledged: boolean): void;
	onDiscarded(): void;
	onCanonical(canonical: CollabCanonicalStamp): void;
	onRecoveryRequired(required: boolean): void;
};

function selectionOf(state: unknown): CollabSelection | null {
	if (typeof state !== "object" || state === null) return null;
	const selection = (state as { selection?: unknown }).selection;
	if (typeof selection !== "object" || selection === null) return null;
	const candidate = selection as Partial<CollabSelection>;
	return typeof candidate.path === "string" &&
		typeof candidate.anchor === "number" &&
		typeof candidate.head === "number"
		? { path: candidate.path, anchor: candidate.anchor, head: candidate.head }
		: null;
}

/**
 * One live room connection. Implements `OtEditSession` for the editor and
 * `OtClientDelegate` for the OT client; both halves share the socket.
 */
class CollabSession implements OtEditSession {
	#socket: WebSocket | null = null;
	#client: OtClient | null = null;
	#nextRequestId = 1;
	#requests = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: unknown) => void }
	>();
	#deliverRows: ((rows: readonly CodeChangeRow[]) => void) | null = null;
	#listeners = new Set<(change: CodeChange) => void>();
	/** What the editor is displaying; the base every emitted change is relative to. */
	#content: CodeContent = new Map();
	#peerId = 0;
	#peers = new Map<number, unknown>();
	#location: CollabLocation | null = null;
	#selection: CollabSelection | null = null;
	#blocked: OtBlockedState | null = null;
	#ready = false;
	#disposed = false;
	/** The room's own grounding stamp, from the handshake and later broadcasts. */
	#roomCanonical: CollabCanonicalStamp | null = null;
	/** The (target, room) pair already offered, so a refusal is not retried forever. */
	#offered: string | null = null;
	/**
	 * The most recent commit this client made and the basis it was written from, until the room is
	 * grounded on it. What makes a `ground` frame possible at all — see the module header.
	 */
	#committed: {
		basis: CollabCommitBasis;
		revision: number;
		revisionId: string | null;
	} | null = null;
	/**
	 * The socket died while the OT client still held edits the server had not agreed to.
	 *
	 * Those edits die with the client — `#teardownSocket` disposes it and the replacement rebuilds
	 * from a fresh base fetch, so the replacement has no buffers to notice the loss in. The client's
	 * own discard signal therefore cannot fire for this path, and without this latch the reconnect
	 * was silent: the typed character vanished, `discarded` stayed 0, and the surface went on
	 * promising Commit "as soon as the room has them" about edits the room would never see.
	 *
	 * Reported once the replacement client has published the room's content, not at teardown, so the
	 * warning's claim that the document below is what everyone sees is true when it is rendered.
	 *
	 * And the latch is a suspicion, not a verdict. `hasLocalEdits()` is also true for a submission
	 * the server already accepted whose response died with the socket: the replacement's base
	 * already contains that character, its republish is byte-identical to what this session last
	 * showed, and nothing was lost at all. Warning there is exactly the spurious alert
	 * `@/collab/ot/client` refuses to raise on its own path -- it teaches the user to ignore the
	 * true one. So the republish decides: no delta, no discard. The latch is still cleared either
	 * way, because a suspicion that survives its own resolution re-fires on every later row.
	 */
	#lostLocalEdits = false;
	#reconnectMs = RECONNECT_BASE_MS;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	#presenceTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly url: string,
		private readonly canonical: () => CollabDocCanonical | null,
		private readonly path: string,
		private readonly handlers: SessionHandlers,
	) {
		this.#connect();
		this.#presenceTimer = setInterval(
			() => this.#sendPresence(),
			PRESENCE_REBROADCAST_MS,
		);
	}

	// =====================================================================
	// OtEditSession

	text(path: string): string {
		return this.#content.get(path) ?? "";
	}

	applyLocal(change: CodeChange, path: string, newText: string): void {
		const client = this.#client;
		if (!client || !this.#ready) return;
		client.applyLocalChange(change);
		const next = client.getContent();
		this.#content = next;
		this.#mapPeerSelections(change);
		// The editor already applied `change` to its own buffer. If the client's
		// content disagrees, the two replicas have diverged and the quiet failure
		// is the dangerous one — hand the editor the correcting delta instead.
		const applied = next.get(path) ?? "";
		if (applied !== newText) {
			const corrective = diffFiles(
				new Map([[path, newText]]),
				new Map([[path, applied]]),
			);
			if (corrective.length > 0) this.#emit(corrective);
		}
	}

	onRemote(listener: (change: CodeChange) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	blocked(): OtBlockedState | null {
		return this.#blocked;
	}

	// =====================================================================
	// Canonical grounding

	/**
	 * The room said which canonical revision its content represents — on the
	 * handshake, in an offer's answer, or in the broadcast that follows a peer's
	 * adoption. Record it, publish it, and then decide whether the revision this
	 * surface has loaded is newer.
	 */
	#observeCanonical(canonical: CollabCanonicalStamp): void {
		this.#roomCanonical = canonical;
		this.handlers.onCanonical(canonical);
		this.#maybeOfferCanonical();
	}

	/**
	 * Offer the room the canonical revision this surface loaded, when it is newer
	 * than the room's own grounding.
	 *
	 * One offer per (target, room) pair. The server decides, and its refusal of an
	 * edited room is a state only the user can resolve — re-offering it on every
	 * broadcast would be a retry loop against a decision that will not change.
	 * A newer target, or a room that has since moved, is a different pair and is
	 * offered again.
	 */
	#maybeOfferCanonical(): void {
		const target = this.canonical();
		const room = this.#roomCanonical;
		if (target === null || room === null) return;
		if (target.revision <= room.revision) {
			// The room is at or ahead of what this surface loaded, so there is
			// nothing to adopt and nothing for the user to resolve.
			this.#offered = null;
			this.handlers.onRecoveryRequired(false);
			return;
		}
		const pair = `${target.revision}:${room.revision}`;
		if (this.#offered === pair) return;
		this.#offered = pair;
		// A revision this client committed is not an offer to adopt: the room is
		// already ahead of it and would be refused. Prove where it came from
		// instead. See the module header.
		const committed = this.#committed;
		if (committed !== null && committed.revision === target.revision) {
			void this.#groundOn(committed);
			return;
		}
		void this.#offerCanonical(target, false);
	}

	/**
	 * The text and stream position a commit would be written from, taken in one synchronous read.
	 *
	 * `null` while this client holds unacknowledged edits: the displayed text is then `#applied`
	 * plus buffers the server has not agreed to, so no stream position describes it and there is
	 * nothing the room could later be grounded on. A commit must not proceed on a `null` basis —
	 * see the module header. The surface learns the same fact reactively through
	 * `onUnacknowledged`, and this read is the guard in the span that starts the commit.
	 */
	commitBasis(): CollabCommitBasis | null {
		const client = this.#client;
		if (!client || !this.#ready || client.hasLocalEdits()) return null;
		return {
			text: client.getContent().get(this.path) ?? "",
			position: client.getPosition(),
		};
	}

	/**
	 * A commit landed: re-ground the room on the revision it produced.
	 *
	 * Sent immediately rather than waiting for the surface's query to refetch, because until the
	 * room's stamp moves every peer's commit is still pinned to the revision this one superseded.
	 * The record is kept so a later refetch of the same revision grounds instead of offering.
	 */
	groundCommit(
		basis: CollabCommitBasis,
		revision: number,
		revisionId: string | null,
	): void {
		const committed = { basis, revision, revisionId };
		this.#committed = committed;
		void this.#groundOn(committed);
	}

	/**
	 * Send one `ground` frame and take the room's answer.
	 *
	 * A refusal means the position this commit named no longer describes the room — a peer's row
	 * landed on top of it, or the window aged out. Drop the record and reconsider: the ordinary
	 * offer can still succeed if the room has since converged on the committed text byte for byte,
	 * and if it has not, the user gets the explicit recovery they would have got anyway.
	 */
	async #groundOn(committed: {
		basis: CollabCommitBasis;
		revision: number;
		revisionId: string | null;
	}): Promise<void> {
		let frame: Extract<CollabServerFrame, { t: "canonicalResult" }>;
		try {
			const answer = await this.#request({
				t: "ground",
				id: 0,
				offer: {
					revision: committed.revision,
					revisionId: committed.revisionId,
					files: [[this.path, committed.basis.text]] as [string, string][],
				},
				at: committed.basis.position,
			});
			if (answer.t !== "canonicalResult") return;
			frame = answer;
		} catch {
			// The socket died under the claim. Nothing was written; the next
			// handshake re-observes the room's grounding and this record is retried.
			return;
		}
		const refused = frame.outcome === "edited";
		if (refused && this.#committed === committed) {
			this.#committed = null;
			this.#offered = null;
		}
		this.handlers.onRecoveryRequired(refused);
		this.#roomCanonical = frame.canonical;
		this.handlers.onCanonical(frame.canonical);
		if (refused) this.#maybeOfferCanonical();
	}

	/**
	 * Send one offer. `force` is the user's explicit, warned choice to replace an
	 * edited room's content and is never set by this module's own initiative.
	 */
	async #offerCanonical(
		target: CollabDocCanonical,
		force: boolean,
	): Promise<CollabRecoveryResult> {
		let frame: Extract<CollabServerFrame, { t: "canonicalResult" }>;
		try {
			const answer = await this.#request({
				t: "canonical",
				id: 0,
				offer: {
					revision: target.revision,
					revisionId: target.revisionId,
					files: [[this.path, target.text]] as [string, string][],
				},
				...(force ? { force: true } : {}),
			});
			if (answer.t !== "canonicalResult")
				return {
					ok: false,
					message: "The shared draft did not confirm recovery. Try again.",
				};
			frame = answer;
		} catch {
			return {
				ok: false,
				message:
					"Recovery was not confirmed. Reconnect and check the draft before trying again.",
			};
		}
		// The room holds edits this revision would replace. Only the user can
		// resolve that, through `replaceWithCanonical`.
		this.handlers.onRecoveryRequired(frame.outcome === "edited");
		this.#roomCanonical = frame.canonical;
		this.handlers.onCanonical(frame.canonical);
		if (
			frame.outcome === "adopted" ||
			frame.outcome === "repaired" ||
			(frame.outcome === "current" &&
				(!force || this.text(this.path) === target.text))
		)
			return { ok: true };
		return {
			ok: false,
			message:
				frame.outcome === "current"
					? "The shared draft was not replaced. Reload the document and compare again."
					: `The shared draft could not be restored (${frame.outcome}). Your draft remains available to download. Try again after reconnecting.`,
		};
	}

	/**
	 * The user's explicit choice to replace the shared draft. It lands as one
	 * ordinary server-authored change, so peers see the document converge rather
	 * than being reset underneath them.
	 */
	replaceWithCanonical(): Promise<CollabRecoveryResult> {
		const target = this.canonical();
		if (target === null)
			return Promise.resolve({
				ok: false,
				message: "The saved version has not loaded yet.",
			});
		return this.#offerCanonical(target, true);
	}

	/** The surface loaded a different canonical revision; reconsider the offer. */
	canonicalChanged(): void {
		this.#maybeOfferCanonical();
	}

	// =====================================================================
	// Surface-driven presence

	setLocation(location: CollabLocation | null): void {
		this.#location = location;
		this.#sendPresence();
	}

	setSelection(selection: CollabSelection | null): void {
		this.#selection = selection;
		this.#sendPresence();
	}

	// =====================================================================
	// Lifecycle

	dispose(): void {
		this.#disposed = true;
		if (this.#presenceTimer !== null) clearInterval(this.#presenceTimer);
		if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
		this.#teardownSocket();
	}

	#connect(): void {
		if (this.#disposed) return;
		this.handlers.onStatus("connecting");
		let socket: WebSocket;
		try {
			socket = new WebSocket(this.url);
		} catch (error) {
			console.error("Collaboration socket could not be opened", error);
			this.#scheduleReconnect();
			return;
		}
		this.#socket = socket;
		socket.addEventListener("open", () => {
			if (this.#socket !== socket) return;
			this.#reconnectMs = RECONNECT_BASE_MS;
			this.#sendPresence();
			// A fresh client per socket: see the module header. The session object
			// the editor holds is unaffected; it receives the difference as one
			// ordinary remote change once the base lands.
			const client = new OtClient({
				fetchBase: async () => {
					const seed = this.canonical();
					const frame = await this.#request({
						t: "base",
						id: 0,
						...(seed === null
							? {}
							: {
									seed: {
										revision: seed.revision,
										revisionId: seed.revisionId,
										files: [[this.path, seed.text]] as [string, string][],
									},
								}),
					});
					if (frame.t !== "base") throw new Error("Unexpected base reply.");
					// The handshake is where the room says which canonical revision its content
					// represents. Recording it here is what lets the surface pin a commit to the
					// document the user is actually editing.
					this.#observeCanonical(frame.canonical);
					return {
						position: {
							generation: frame.generation,
							revision: frame.revision,
						},
						content: new Map(frame.files),
					};
				},
				submit: async (submission: CodeChangeSubmission) => {
					const frame = await this.#request({ t: "submit", id: 0, submission });
					if (frame.t !== "result") {
						throw new Error("Unexpected submission reply.");
					}
					return frame.result satisfies CodeChangeSubmitResult;
				},
				isTransientError: (error) => error instanceof CollabTransportError,
				subscribe: (deliver) => {
					this.#deliverRows = deliver;
					return () => {
						if (this.#deliverRows === deliver) this.#deliverRows = null;
					};
				},
				onRemoteChange: (events) => {
					this.#ready = true;
					this.handlers.onStatus("connected");
					const republished = this.#publish(
						events.length > 0
							? events.map(({ path, change }) => [path, change])
							: null,
					);
					// The room's content is now on screen, so the loss the previous socket took
					// with it can be reported truthfully -- and only if there was one. Read and
					// cleared in one await-free span so a second publish cannot double-count the
					// same loss, and reported only when the republish actually moved the document:
					// see `#lostLocalEdits` for the accepted-but-unacknowledged case this filters.
					if (this.#lostLocalEdits) {
						this.#lostLocalEdits = false;
						if (republished) this.handlers.onDiscarded();
					}
				},
				onLocalEditsDiscarded: () => this.handlers.onDiscarded(),
				onDirtyState: (dirty) => this.handlers.onDirty(dirty),
				onUnacknowledgedEdits: (unacknowledged) =>
					this.handlers.onUnacknowledged(unacknowledged),
				onBlocked: (blocked) => {
					this.#blocked = blocked;
					this.handlers.onBlocked(blocked);
				},
				onFatalError: (error) => {
					// The client cannot recover; only a new one can. Dropping the socket
					// is what produces one, on the reconnect ladder's own schedule.
					console.error("Collaboration session failed", error);
					this.#teardownSocket();
					this.#scheduleReconnect();
				},
			});
			this.#client = client;
			client.start();
		});
		socket.addEventListener("message", (event) => {
			if (this.#socket !== socket) return;
			if (typeof event.data !== "string") return;
			this.#handleFrame(event.data);
		});
		const drop = () => {
			if (this.#socket !== socket) return;
			this.#teardownSocket();
			this.#scheduleReconnect();
		};
		socket.addEventListener("close", drop);
		socket.addEventListener("error", drop);
	}

	#teardownSocket(): void {
		const socket = this.#socket;
		this.#socket = null;
		this.#ready = false;
		// Read in the same await-free span that destroys the buffers, and latched rather than
		// reported: the replacement client cannot see edits that died with its predecessor, and
		// until it has published the room's content there is nothing truthful to say about them.
		if (this.#client?.hasLocalEdits() === true) this.#lostLocalEdits = true;
		this.#client?.dispose();
		this.#client = null;
		this.#deliverRows = null;
		this.#failPendingRequests();
		this.#peers = new Map();
		this.handlers.onParticipants([]);
		this.handlers.onStatus("disconnected");
		try {
			socket?.close();
		} catch {
			// Already closing; nothing to do.
		}
	}

	#scheduleReconnect(): void {
		if (this.#disposed || this.#reconnectTimer !== null) return;
		const delay = this.#reconnectMs;
		this.#reconnectMs = Math.min(delay * 2, RECONNECT_MAX_MS);
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = null;
			this.#connect();
		}, delay);
	}

	// =====================================================================
	// Frames

	#handleFrame(data: string): void {
		const frame = parseServerFrame(data);
		if (!frame) return;
		switch (frame.t) {
			case "hello":
				this.#peerId = frame.peerId;
				this.#sendPresence();
				return;
			case "presence":
				this.#peers = new Map(frame.peers);
				this.handlers.onParticipants(
					collabParticipantsFromStates(this.#peers, this.#peerId),
				);
				return;
			case "row":
				this.#deliverRows?.([frame.row]);
				return;
			case "canonical":
				// A peer moved the room's grounding. Every socket is told, so no peer
				// keeps pinning its commits to a revision the room has left behind.
				this.#observeCanonical(frame.canonical);
				return;
			case "base":
			case "canonicalResult":
			case "result": {
				this.#requests.get(frame.id)?.resolve(frame);
				this.#requests.delete(frame.id);
				return;
			}
			case "error": {
				if (frame.id === null) return;
				this.#requests.get(frame.id)?.reject(new Error(frame.message));
				this.#requests.delete(frame.id);
				return;
			}
		}
	}

	#request(
		frame: Extract<CollabClientFrame, { id: number }>,
	): Promise<
		Extract<
			CollabServerFrame,
			{ t: "base" } | { t: "canonicalResult" } | { t: "result" }
		>
	> {
		return new Promise((resolve, reject) => {
			const socket = this.#socket;
			if (!socket || socket.readyState !== WebSocket.OPEN) {
				reject(new CollabTransportError("The collaboration socket is closed."));
				return;
			}
			const id = this.#nextRequestId++;
			this.#requests.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
			});
			try {
				socket.send(encodeFrame({ ...frame, id }));
			} catch (error) {
				this.#requests.delete(id);
				reject(new CollabTransportError((error as Error).message));
			}
		});
	}

	/**
	 * Every outstanding request dies with the socket, as a transient failure:
	 * the OT client must resend its in-flight submission byte-identically rather
	 * than discard the user's work over a dropped connection.
	 */
	#failPendingRequests(): void {
		const pending = [...this.#requests.values()];
		this.#requests.clear();
		for (const request of pending) {
			request.reject(
				new CollabTransportError("The collaboration socket closed."),
			);
		}
	}

	#sendPresence(): void {
		const socket = this.#socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) return;
		try {
			socket.send(
				encodeFrame({
					t: "presence",
					state: {
						...(this.#location ? { location: this.#location } : {}),
						...(this.#selection ? { selection: this.#selection } : {}),
					},
				}),
			);
		} catch {
			// The close handler owns the failure.
		}
	}

	// =====================================================================
	// Content

	/**
	 * Publish the client's content to the editor.
	 *
	 * `change` is the precise per-file delta when the client had one. `null`
	 * means coarse — a rebuild — and the delta is derived by diffing the content
	 * we last published against the new one, so the editor still receives an
	 * ordinary change it can apply in place instead of losing its cursor to a
	 * wholesale reload.
	 *
	 * Returns whether the document actually moved. An empty delta means this session is already
	 * displaying the content the client now holds, which is what tells a rebuild apart from a
	 * data loss -- see `#lostLocalEdits`.
	 */
	#publish(change: CodeChange | null): boolean {
		const client = this.#client;
		if (!client) return false;
		const next = client.getContent();
		const delta = change ?? diffFiles(this.#content, next);
		this.#content = next;
		if (delta.length === 0) return false;
		this.#mapPeerSelections(delta);
		this.#emit(delta);
		return true;
	}

	#emit(change: CodeChange): void {
		for (const listener of this.#listeners) listener(change);
	}

	/**
	 * Carry every peer caret across a change that has just been applied. A peer
	 * publishes offsets against the text it saw; each replica keeps them true by
	 * mapping across the changes it applies afterwards (see `@/collab/presence`).
	 */
	#mapPeerSelections(change: CodeChange): void {
		let moved = false;
		for (const [peerId, state] of this.#peers) {
			const selection = selectionOf(state);
			if (!selection) continue;
			const mapped = mapSelectionThroughChange(selection, change);
			if (mapped === selection) continue;
			moved = true;
			const next = { ...(state as Record<string, unknown>) };
			if (mapped) next.selection = mapped;
			else delete next.selection;
			this.#peers.set(peerId, next);
		}
		if (moved) {
			this.handlers.onParticipants(
				collabParticipantsFromStates(this.#peers, this.#peerId),
			);
		}
	}
}

/**
 * One collaboration session per (workspaceId, docKey) while enabled and a seed
 * is available. The session object is stable for the life of that tuple —
 * reconnects happen underneath it.
 */
export function useCollabDoc(input: UseCollabDocInput): UseCollabDocResult {
	const { workspaceId, docKey, enabled, canonical, location } = input;
	const [session, setSession] = useState<CollabSession | null>(null);
	const [status, setStatus] = useState<CollabDocStatus>("disconnected");
	const [participants, setParticipants] = useState<CollabParticipant[]>([]);
	const [blocked, setBlocked] = useState<OtBlockedState | null>(null);
	const [unsynced, setUnsynced] = useState(false);
	const [unacknowledged, setUnacknowledged] = useState(false);
	const [discarded, setDiscarded] = useState(0);
	const [roomCanonical, setRoomCanonical] =
		useState<CollabCanonicalStamp | null>(null);
	const [recoveryRequired, setRecoveryRequired] = useState(false);
	// Read at handshake time, not at connect time: the surface may load canonical
	// truth after the socket is up, and a later value must not recreate the
	// session (which would discard the user's in-flight edits).
	const [canonicalBox] = useState<{ value: CollabDocCanonical | null }>({
		value: canonical,
	});
	canonicalBox.value = canonical;
	const hasCanonical = canonical !== null;
	const canonicalRevision = canonical?.revision ?? null;
	const canonicalRevisionId = canonical?.revisionId ?? null;
	const locationSurface = location?.surface;
	const locationArtifactKind = location?.artifactKind;
	const locationArtifactLabel = location?.artifactLabel;
	const locationSelectionLabel = location?.selectionLabel;

	useEffect(() => {
		if (!enabled || workspaceId === "" || docKey === "" || !hasCanonical) {
			return;
		}
		let active = true;
		const guard =
			<T>(apply: (value: T) => void) =>
			(value: T) => {
				if (active) apply(value);
			};
		const next = new CollabSession(
			collabSocketUrl(window.location, workspaceId, docKey),
			() => canonicalBox.value,
			COLLAB_DOC_PATH,
			{
				onStatus: guard(setStatus),
				onParticipants: guard(setParticipants),
				onBlocked: guard(setBlocked),
				onDirty: guard(setUnsynced),
				onUnacknowledged: guard(setUnacknowledged),
				onCanonical: guard(setRoomCanonical),
				onRecoveryRequired: guard(setRecoveryRequired),
				onDiscarded: () => {
					if (active) setDiscarded((count) => count + 1);
				},
			},
		);
		setSession(next);
		setStatus("connecting");
		// Every derived signal is reset here, `discarded` included. It describes one
		// document's session, so carrying it into the next document would put a
		// "your edits were discarded" warning over a document that never had any --
		// and until now the only thing preventing that was a `key` on the consuming
		// surface, in another file, which nothing in this module could enforce.
		return () => {
			active = false;
			next.dispose();
			setSession(null);
			setStatus("disconnected");
			setParticipants([]);
			setBlocked(null);
			setUnsynced(false);
			setUnacknowledged(false);
			setDiscarded(0);
			setRoomCanonical(null);
			setRecoveryRequired(false);
		};
	}, [workspaceId, docKey, enabled, hasCanonical, canonicalBox]);

	// A refetch that carried a newer canonical revision must reach the room: the
	// session reads the box at offer time, but nothing else would tell it to look.
	useEffect(() => {
		session?.canonicalChanged();
	}, [session, canonicalRevision, canonicalRevisionId]);

	useEffect(() => {
		session?.setLocation(
			locationSurface
				? {
						surface: locationSurface,
						...(locationArtifactKind
							? { artifactKind: locationArtifactKind }
							: {}),
						...(locationArtifactLabel
							? { artifactLabel: locationArtifactLabel }
							: {}),
						...(locationSelectionLabel
							? { selectionLabel: locationSelectionLabel }
							: {}),
					}
				: null,
		);
	}, [
		locationArtifactKind,
		locationArtifactLabel,
		locationSelectionLabel,
		locationSurface,
		session,
	]);

	const replaceWithCanonical = useCallback(() => {
		return (
			session?.replaceWithCanonical() ??
			Promise.resolve({
				ok: false as const,
				message: "Reconnect before restoring the saved version.",
			})
		);
	}, [session]);

	const commitBasis = useCallback(
		() => session?.commitBasis() ?? null,
		[session],
	);

	const groundCommit = useCallback(
		(basis: CollabCommitBasis, revision: number, revisionId: string | null) => {
			session?.groundCommit(basis, revision, revisionId);
		},
		[session],
	);

	return {
		// Not gated on `status`: see the module header and `UseCollabDocResult.session`.
		// A transient disconnect must not unmount the editor and destroy its view.
		session,
		status,
		participants,
		peers: status === "connected" ? participants.length + 1 : 0,
		blocked,
		unsynced,
		unacknowledged,
		discarded,
		canonical: roomCanonical,
		recoveryRequired,
		replaceWithCanonical,
		commitBasis,
		groundCommit,
	};
}
