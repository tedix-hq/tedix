/**
 * The Cap'n Web chat connection machine — framework-free, React-free.
 *
 * Split out of `use-capn-chat.ts` so the client half can
 * be driven from a `@cloudflare/vitest-plugin` isolate against a REAL
 * `/capn` socket. The React hooks that wrap it live in `use-capn-chat.ts` and
 * re-export everything here.
 *
 * The wire types come from `@/capnweb/contract` — the same declaration the
 * Worker's `session-root.ts` implements. There is no local mirror of the
 * server's shapes and no `as unknown` cast at the socket: `connectCapnSocket`
 * types capnweb's stub as `CapnSessionStub`, which is DERIVED from the server
 * interface, so any divergence is a compile error.
 *
 * Resume design (see `contract.ts` for the cursor semantics): the machine
 * holds the last `CapnStreamCursor` the SERVER sent — never one it computed —
 * and on reconnect snapshots from it, adopts the snapshot's cursor, then
 * subscribes from that. Cursors are `(runId, offset)` pairs, so a new run's
 * offsets can never be mistaken for the previous run's. Dedupe is by
 * `capnFrameId` (`{conversationId}:{runId}:{offset}`), which makes replay
 * overlap a no-op and cross-run collisions impossible.
 *
 * That cursor survives a socket death, but not this machine's own `close()` —
 * and `realtime-connection.ts` closes machines routinely (navigation teardown,
 * LRU eviction of the least-recently-acquired entry). So the cursor is also
 * PARKED in the tab-wide watermark store and picked back up by the successor,
 * turning what used to be a cold re-page of the current run into a gap replay.
 * Parking obeys one rule, enforced in the shared store rather than restated
 * here: only a session that drained its replay pages, resolved its subscribe,
 * and saw no listener throw may park. Anything else leaves the successor to
 * open cold — slower, always correct.
 *
 * Liveness: socket death (`onRpcBroken` / `lease.onBroken`) is only ONE of the
 * ways this lane can stop receiving. The server's pump can end while the socket
 * stays healthy, and nothing on this wire reports that, so the machine also
 * runs its own watchdog — see {@link CAPN_LIVENESS_IDLE_MS} and
 * {@link isStreamStale}.
 */

import { RuntimeStreamEventSchema } from "@tedix/api-contract/schemas/runtime-submissions";
import type { EnqueueHomeMessageOutput } from "@tedix/api-contract/schemas/kernel-runtime";
import {
	CAPN_ROUTE_PATH,
	type CapnConnectFn,
	type CapnConversationSnapshot,
	type CapnConversationStub,
	type CapnEnqueueInput,
	type CapnEventFrame,
	capnFrameId,
	type CapnRespondApprovalParams,
	type CapnSessionStub,
	capnStreamKey,
	type CapnStreamCursor,
	type CapnStubLike,
} from "@/capnweb/contract";
import type { CapnSessionLeaseHandle } from "@/lib/capn-session-hub";
import {
	type ConversationResumeWatermarks,
	type ConversationStreamFrame,
	type ConversationStreamStatus,
	getConversationResumeWatermarks,
	nextBackoffDelayMs,
	recordStreamFrame,
} from "@/lib/conversation-stream";

/** `https://x.os.tedix.dev` → `wss://x.os.tedix.dev/capn` (same-origin, cookies flow). */
export function capnSocketUrl(origin: string): string {
	return `${origin.replace(/\/+$/, "").replace(/^http/, "ws")}${CAPN_ROUTE_PATH}`;
}

/**
 * Production connect: dial the same-origin socket. capnweb's `RpcStub<T>` is a
 * Proxy typed structurally from `T`; naming `T` as the contract-derived
 * `CapnSessionStub` is the whole binding, and it replaces the pilot's
 * `as unknown as` cast to a hand-written mirror.
 */
export async function connectCapnSocket(): Promise<CapnSessionStub> {
	// Lazy import: capnweb enters the bundle only when the flag is on.
	const { newWebSocketRpcSession } = await import("capnweb");
	return newWebSocketRpcSession<CapnSessionStub>(
		capnSocketUrl(window.location.origin),
	);
}

// ---------------------------------------------------------------------------
// Outcome-unknown enqueue
// ---------------------------------------------------------------------------

/**
 * The connection died with an enqueue in flight: the kernel may or may not
 * have accepted it. This is an explicit UNKNOWN — never silently retried.
 * The only safe recovery is a SAME-KEY re-enqueue (the idempotency key IS the
 * run id server-side, so a same-key resend is exactly-once), which is what
 * the chat surface's Retry does because it holds the key across failures.
 */
export class CapnOutcomeUnknownError extends Error {
	readonly outcome = "unknown" as const;
	readonly idempotencyKey: string;

	constructor(idempotencyKey: string, cause: unknown) {
		super(
			"The send outcome is unknown: the connection dropped mid-send. " +
				"Retry re-sends with the same idempotency key, which is safe.",
			{ cause },
		);
		this.name = "CapnOutcomeUnknownError";
		this.idempotencyKey = idempotencyKey;
	}
}

export function isOutcomeUnknown(
	error: unknown,
): error is CapnOutcomeUnknownError {
	return error instanceof CapnOutcomeUnknownError;
}

/**
 * The capability session is not open, so the call never left this client —
 * a KNOWN not-sent, the opposite of `CapnOutcomeUnknownError`. The transport
 * seam surfaces it without retrying through a second mutation transport.
 */
export class CapnNotConnectedError extends Error {
	readonly notSent = true as const;

	constructor() {
		super("The Cap'n Web transport is not connected; the call was not sent.");
		this.name = "CapnNotConnectedError";
	}
}

// ---------------------------------------------------------------------------
// Liveness watchdog
// ---------------------------------------------------------------------------

/**
 * Silence after which the machine stops trusting "open" and PROVES the live
 * tail is still moving.
 *
 * The server's pump can die while the WebSocket stays perfectly healthy — an
 * upstream outage that outlasts its retry budget, or a subscriber stub the peer
 * gave up on. There is no server→client signal for that on this wire, so
 * `onRpcBroken`/`lease.onBroken` (socket death) never fire and the UI sits at
 * status "open" rendering a transcript that stopped hours ago.
 */
export const CAPN_LIVENESS_IDLE_MS = 45_000;

/**
 * Does the server hold durable events this client never received?
 *
 * Comparing POSITIONS rather than counting frames is what makes the verdict
 * exact — the naive "no frames for a while means broken" test cannot tell a
 * dead pump from an idle conversation, and firing a reconnect on every quiet
 * minute would be its own storm:
 *
 * - No run at all: nothing can be owed.
 * - The probe names the run our cursor names: stale iff the run has advanced
 *   past our cursor. A closed run we have fully read reports EQUAL offsets, so
 *   an idle conversation whose last run finished is correctly healthy — the
 *   case an emptiness test gets backwards.
 * - The probe names a DIFFERENT run: stale only if that run has already
 *   produced events. A brand-new empty run is one a live pump has legitimately
 *   rolled onto without owing us anything yet.
 *
 * ANCHORING (load-bearing). `snapshot()` serves ONE PAGE — `RUN_EVENT_STREAM_PAGE`
 * is 200 rows in `run-reads-streams.ts`, and the returned cursor is
 * `pageStart + servedRows`, i.e. a PAGE boundary, not the run's end. So the
 * same-run branch above can prove STALE from any probe, but it can only prove
 * HEALTHY from a probe anchored at this client's own cursor: `snapshot(null)`
 * on a run of more than 200 events always reports offset 200, which reads as
 * "healthy" to every client past 200 — exactly the long streaming runs where a
 * dead pump is most visible. {@link probeLiveness} therefore probes from the
 * client cursor, and reaches for `snapshot(null)` only to answer the run-
 * rollover question that an anchored probe structurally cannot see.
 */
export function isStreamStale(
	cursor: CapnStreamCursor | null,
	probe: CapnConversationSnapshot,
): boolean {
	if (probe.runId === null) return false;
	if (cursor === null || probe.runId !== cursor.runId) {
		return probe.events.length > 0;
	}
	return (probe.cursor?.offset ?? 0) > cursor.offset;
}

/**
 * Could the live tail legitimately be on a run OTHER than the probed one?
 *
 * The server's pump follows one run until its stream CLOSES and only then
 * advances to the run created after it (`session-root.ts` `#pump`), so an open
 * run is still the one this connection is owed frames from and no second probe
 * can tell us anything. A missing receipt is treated as "unknown", not "open":
 * the extra probe is a page, a missed rollover is a permanently frozen UI.
 */
function mayHaveRolledOver(probe: CapnConversationSnapshot): boolean {
	return probe.stream === null || probe.stream.closed;
}

// ---------------------------------------------------------------------------
// Connection machine
// ---------------------------------------------------------------------------

export type CapnChatActions = {
	enqueue(
		input: CapnEnqueueInput,
		idempotencyKey: string,
	): Promise<EnqueueHomeMessageOutput>;
	cancel(runId: string): Promise<unknown>;
	respondApproval(params: CapnRespondApprovalParams): Promise<unknown>;
};

export type CapnChatMachineOptions = {
	conversationId: string;
	/**
	 * Dials a session directly. Used only when no `lease` is supplied — the
	 * global connection manager always supplies one, so production never opens
	 * a socket per conversation.
	 */
	connect: CapnConnectFn;
	/**
	 * A lease on the SHARED session (`capn-session-hub.ts`). When present the
	 * machine borrows the hub's root instead of dialing: it neither adopts nor
	 * disposes the root, and it learns about socket death from the hub rather
	 * than registering its own `onRpcBroken`. Retry, backoff, cursors, and
	 * capability re-acquisition stay HERE — the hub owns only the socket, so the
	 * lane keeps exactly one reconnect implementation.
	 */
	lease?: CapnSessionLeaseHandle;
	/**
	 * Where this machine picks up a cursor parked by a CLEANLY SETTLED
	 * predecessor for the same conversation, and where it parks its own.
	 *
	 * The machine's in-memory cursor already survives socket death; it does not
	 * survive `close()`, and `realtime-connection.ts` closes machines routinely
	 * (navigation teardown, LRU eviction of the least-recently-acquired entry).
	 * Without this the successor opens cold and the server honestly re-serves
	 * the current run from offset 0.
	 *
	 * Defaults to the tab-wide store. Pass `null` to disable, which is what a
	 * test wants when it is asserting the cold-open path.
	 */
	resumeWatermarks?: ConversationResumeWatermarks | null;
	/** Called once per UNSEEN frame id, in arrival order (schema-valid only). */
	onFrame: (frame: ConversationStreamFrame) => void;
	onStatus?: (status: ConversationStreamStatus) => void;
	/** Dev measurement taps (absent in production). */
	recordWireOffset?: (streamKey: string, offset: number) => void;
	recordConnectFailure?: () => void;
	/** A resume cursor was abandoned as unresolvable; the lane replays the current run. */
	recordCursorReset?: () => void;
	/** One replay snapshot was served: reconnect resume or liveness probe. */
	recordSnapshotReplay?: (streamKey: string, eventCount: number) => void;
	/**
	 * The live tail went silent while the socket stayed healthy and the watchdog
	 * forced a reconnect. The connection manager treats this as a degradation
	 * signal, so the surfaces that poll when push delivery is unreliable arm.
	 */
	recordStreamStall?: () => void;
	trackStub?: (label: string) => () => void;
	/** Injectable timers so backoff is unit-testable without a DOM clock. */
	setTimeoutFn?: (callback: () => void, ms: number) => unknown;
	clearTimeoutFn?: (handle: unknown) => void;
	/**
	 * The liveness watchdog's own timer seam, deliberately SEPARATE from the
	 * backoff seam: a test that drives backoff by hand must not have its queue
	 * interleaved with a 45s watchdog rearm it never asked for.
	 */
	setLivenessTimerFn?: (callback: () => void, ms: number) => unknown;
	clearLivenessTimerFn?: (handle: unknown) => void;
	/** Injectable clock for the watchdog's silence window. */
	nowFn?: () => number;
	/** Injectable randomness for backoff jitter. */
	randomFn?: () => number;
};

export type CapnChatMachineHandle = {
	close(): void;
	actions: CapnChatActions;
	getFrames(): ConversationStreamFrame[];
	/** The last cursor the SERVER issued; null before the first snapshot. */
	getCursor(): CapnStreamCursor | null;
};

/**
 * True for anything that can carry `[Symbol.dispose]`. `"function"` is NOT
 * defensive breadth: capnweb's stubs and `RpcPromise`s are `Proxy` objects
 * whose target is a function, so an `"object"`-only guard skips every real
 * stub and leaks it — the peer's export stays pinned until the session ends.
 */
function isStubLike(stub: unknown): boolean {
	return (
		stub !== null && (typeof stub === "object" || typeof stub === "function")
	);
}

function disposeQuietly(stub: unknown): void {
	if (!isStubLike(stub)) return;
	try {
		(stub as CapnStubLike)[Symbol.dispose]?.();
	} catch {
		// disposal must never throw into the app
	}
}

export function createCapnChatMachine(
	options: CapnChatMachineOptions,
): CapnChatMachineHandle {
	const setTimeoutFn =
		options.setTimeoutFn ??
		((callback: () => void, ms: number) => setTimeout(callback, ms));
	const clearTimeoutFn =
		options.clearTimeoutFn ??
		((handle: unknown) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>));
	const setLivenessTimerFn =
		options.setLivenessTimerFn ??
		((callback: () => void, ms: number) => setTimeout(callback, ms));
	const clearLivenessTimerFn =
		options.clearLivenessTimerFn ??
		((handle: unknown) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>));
	const nowFn = options.nowFn ?? (() => Date.now());
	const randomFn = options.randomFn ?? Math.random;

	/** Keyed by `capnFrameId` — run-namespaced, so run 2 offset 0 is not run 1's. */
	const frames = new Map<string, ConversationStreamFrame>();
	let closed = false;
	let attempt = 0;
	/** Consecutive establish failures while holding a resume cursor. */
	let resumeFailures = 0;
	/**
	 * This machine's slot in the tab-wide watermark store. It carries in the
	 * cursor a cleanly settled predecessor parked, and carries this machine's
	 * own out — but only if THIS machine also settles cleanly. See the settle
	 * rule in `@tedix/chat-transport/resume-watermark`.
	 */
	const resume = (
		options.resumeWatermarks === null
			? null
			: (options.resumeWatermarks ?? getConversationResumeWatermarks())
	)?.open(options.conversationId);
	/**
	 * The last cursor the SERVER issued. Never recomputed locally — the seed is
	 * a value a previous connection was GIVEN, not one anybody derived.
	 */
	let cursor: CapnStreamCursor | null = resume?.seed ?? null;
	/** Bumped on every connection death/teardown; stale async work no-ops. */
	let epoch = 0;
	let conversation: CapnConversationStub | null = null;
	/** Reverse-order disposal ledger: adopted root → conversation → subscription. */
	let disposers: Array<() => void> = [];
	let timer: unknown = null;
	/** Watchdog handle; non-null only while the machine believes it is open. */
	let livenessTimer: unknown = null;
	/** Last moment the live tail proved itself: a frame, or a clean probe. */
	let lastLivenessAt = 0;

	/**
	 * Status is also the settle signal, because on this machine the two are the
	 * same fact. `establish()` publishes "open" only after the replay page has
	 * been delivered AND `subscribe` resolved and was adopted — clauses 1 and 2
	 * of the settle rule — so there is no window where "open" runs ahead of
	 * undelivered replay records. Anything that is not open (a first connect,
	 * backoff, a proven stall) disarms parking again.
	 *
	 * "idle" is deliberately NOT routed here: it is published by `close()`,
	 * which must be free to park the position this session legitimately reached.
	 */
	const setStatus = (status: ConversationStreamStatus) => {
		if (status === "open") resume?.settle();
		else if (status !== "idle") resume?.unsettle();
		options.onStatus?.(status);
	};

	const adoptStub = (stub: CapnStubLike | null | undefined, label: string) => {
		if (stub === undefined || !isStubLike(stub)) return;
		const release = options.trackStub?.(label);
		disposers.push(() => {
			try {
				disposeQuietly(stub);
			} finally {
				release?.();
			}
		});
	};

	const disposeStubs = () => {
		conversation = null;
		const pending = disposers;
		disposers = [];
		// Deterministic order: subscription, then conversation, then root.
		for (let index = pending.length - 1; index >= 0; index -= 1) {
			pending[index]?.();
		}
	};

	/**
	 * Advance the resume cursor to a frame's `nextOffset`, but only within the
	 * frame's own run: offsets are run-local, so "highest number wins" would
	 * strand the client on a stale run's ordinals forever.
	 */
	/**
	 * The ONE write path for `cursor`, so the watermark slot can never observe a
	 * position this machine did not actually reach. Every assignment goes
	 * through here — snapshot adoption, frame advance, and the unresolvable-run
	 * reset alike.
	 */
	const setCursor = (next: CapnStreamCursor | null) => {
		cursor = next;
		resume?.advance(next);
	};

	const advanceCursor = (frame: CapnEventFrame) => {
		if (cursor === null || cursor.runId !== frame.runId) {
			setCursor({ runId: frame.runId, offset: frame.nextOffset });
			return;
		}
		if (frame.nextOffset > cursor.offset) {
			setCursor({ runId: frame.runId, offset: frame.nextOffset });
		}
	};

	const deliver = (frame: CapnEventFrame) => {
		if (closed) return;
		if (
			typeof frame?.runId !== "string" ||
			frame.runId === "" ||
			!Number.isInteger(frame.offset) ||
			frame.offset < 0 ||
			!Number.isInteger(frame.nextOffset) ||
			frame.nextOffset <= frame.offset
		) {
			return;
		}
		// The tail just proved itself — this is what the watchdog measures
		// silence against.
		lastLivenessAt = nowFn();
		options.recordWireOffset?.(
			capnStreamKey(options.conversationId, frame.runId),
			frame.offset,
		);
		// The resume cursor advances for every well-formed frame — including
		// schema-invalid events — so reconnects never re-fetch known-undecodable
		// rows. Dedupe below only tracks DELIVERED frames.
		advanceCursor(frame);
		const parsed = RuntimeStreamEventSchema.safeParse(frame.event);
		if (!parsed.success) return;
		const streamFrame: ConversationStreamFrame = {
			offset: frame.offset,
			eventId: capnFrameId({
				conversationId: options.conversationId,
				runId: frame.runId,
				offset: frame.offset,
			}),
			event: parsed.data,
		};
		if (!recordStreamFrame(frames, streamFrame)) return;
		try {
			options.onFrame(streamFrame);
		} catch (error) {
			// Third clause of the settle rule: a listener that threw means this
			// frame may not be folded anywhere, so the position past it is not a
			// position anyone can safely resume from. Disarm parking and let the
			// throw travel exactly as it did before — swallowing it here would
			// hide a consumer bug behind a silently degraded stream.
			resume?.unsettle();
			throw error;
		}
	};

	const scheduleReconnect = () => {
		if (closed) return;
		setStatus("reconnecting");
		// Jittered: every tab that lost the socket to the same deploy would
		// otherwise re-dial on the same millisecond, at every rung of the ladder.
		const delay = nextBackoffDelayMs(attempt, randomFn);
		attempt += 1;
		timer = setTimeoutFn(() => void establish(), delay);
	};

	// -------------------------------------------------------------------------
	// Liveness watchdog
	// -------------------------------------------------------------------------

	const streamKeyOf = (runId: string | null): string =>
		runId === null
			? options.conversationId
			: capnStreamKey(options.conversationId, runId);

	const stopLivenessWatch = () => {
		if (livenessTimer === null) return;
		clearLivenessTimerFn(livenessTimer);
		livenessTimer = null;
	};

	/**
	 * One-shot rearm. It re-checks the elapsed silence when it fires instead of
	 * being reset per frame, so a streaming burst of hundreds of deltas costs
	 * one timestamp write rather than hundreds of timer churns.
	 */
	const armLivenessWatch = (watchEpoch: number) => {
		stopLivenessWatch();
		if (closed || watchEpoch !== epoch) return;
		const elapsed = nowFn() - lastLivenessAt;
		const wait = Math.max(CAPN_LIVENESS_IDLE_MS - elapsed, 0);
		livenessTimer = setLivenessTimerFn(() => {
			livenessTimer = null;
			if (closed || watchEpoch !== epoch) return;
			if (nowFn() - lastLivenessAt < CAPN_LIVENESS_IDLE_MS) {
				armLivenessWatch(watchEpoch);
				return;
			}
			void probeLiveness(watchEpoch);
		}, wait);
	};

	/**
	 * Prove the tail, or reconnect. A stale verdict means the server holds
	 * durable events this connection was supposed to push and did not — the
	 * pump is dead behind a healthy socket, which no `onRpcBroken` will ever
	 * report. The recovery is the ordinary establish path (snapshot from the
	 * cursor, resubscribe), entered immediately: backoff exists to protect a
	 * server that is refusing connections, and this one is answering.
	 *
	 * The probe is ANCHORED at the cursor (see {@link isStreamStale}): only a
	 * page that starts where this client stopped can prove the run drained,
	 * and it costs exactly the events we are owed — nothing on a healthy tail,
	 * instead of a 200-row page re-served every idle window.
	 *
	 * An anchored probe is blind to ONE thing: the server rolling onto a newer
	 * run, because `snapshot(cursor)` honors the cursor's own run even when a
	 * newer one exists. That is why a drained, CLOSED run — the only state the
	 * pump ever rolls forward out of — costs a second `snapshot(null)` to ask
	 * which run is current now.
	 */
	const probeLiveness = async (watchEpoch: number): Promise<void> => {
		const target = conversation;
		if (closed || watchEpoch !== epoch || target === null) return;
		const anchor = cursor;
		const takeProbe = async (
			at: CapnStreamCursor | null,
		): Promise<CapnConversationSnapshot | null> => {
			let probe: CapnConversationSnapshot;
			try {
				probe = await target.snapshot(at);
			} catch {
				// The capability itself is unreachable: that IS a broken connection,
				// and the backoff ladder owns it.
				if (closed || watchEpoch !== epoch) return null;
				onBroken(watchEpoch);
				return null;
			}
			if (closed || watchEpoch !== epoch) return null;
			options.recordSnapshotReplay?.(
				streamKeyOf(probe.runId),
				probe.events.length,
			);
			return probe;
		};

		const probe = await takeProbe(anchor);
		if (probe === null) return;
		let stale = isStreamStale(anchor, probe);
		// Deliver either way: the probe already paid for the page, and dedupe
		// makes a re-delivery free.
		for (const frame of probe.events) deliver(frame);
		if (!stale && anchor !== null && mayHaveRolledOver(probe)) {
			const rollover = await takeProbe(null);
			if (rollover === null) return;
			stale = isStreamStale(anchor, rollover);
			for (const frame of rollover.events) deliver(frame);
		}
		lastLivenessAt = nowFn();
		if (!stale) {
			armLivenessWatch(watchEpoch);
			return;
		}
		options.recordStreamStall?.();
		epoch += 1;
		disposeStubs();
		setStatus("reconnecting");
		void establish();
	};

	const onBroken = (brokenEpoch: number) => {
		if (closed || brokenEpoch !== epoch) return;
		epoch += 1;
		stopLivenessWatch();
		disposeStubs();
		scheduleReconnect();
	};

	const establish = async (): Promise<void> => {
		if (closed) return;
		const myEpoch = epoch;
		try {
			// SHARED-SESSION PATH: the hub owns the socket's lifetime, so the root
			// is neither adopted into this machine's disposal ledger nor disposed
			// on teardown — only the capabilities opened ON it are. Socket death
			// arrives through the hub's generation notification and lands in the
			// SAME `onBroken` the direct path uses, so both paths retry
			// identically.
			const lease = options.lease;
			let root: CapnSessionStub;
			if (lease !== undefined) {
				const session = await lease.session();
				if (closed || myEpoch !== epoch) return;
				root = session.root;
				const unbind = lease.onBroken(session.generation, () =>
					onBroken(myEpoch),
				);
				disposers.push(unbind);
			} else {
				root = await options.connect();
				if (closed || myEpoch !== epoch) {
					disposeQuietly(root);
					return;
				}
				adoptStub(root, "root");
				root.onRpcBroken?.(() => onBroken(myEpoch));
			}

			// PIPELINED: `openConversation` is synchronous on the server (it
			// returns the capability, not a promise), so awaiting it here bought
			// nothing but a full round trip on every connect AND every reconnect —
			// the moment latency is already worst, because backoff was just paid.
			// capnweb's result is usable as a stub immediately, so `snapshot`
			// leaves in the same round trip that opens the conversation.
			//
			// Adoption is now synchronous too, which closes a window rather than
			// opening one: teardown during the (removed) await previously relied on
			// a manual dispose, so a `close()` landing between the two statements
			// left the capability un-adopted and un-disposed.
			const conversationStub = root.openConversation(options.conversationId);
			adoptStub(conversationStub, "conversation");

			// RESUME: everything after the last cursor the server issued. On a
			// first connection `cursor` is null, which the server reads as "the
			// current run from its start" — no sentinel offset is ever sent.
			const snapshot = await conversationStub.snapshot(cursor);
			if (closed || myEpoch !== epoch) return;
			options.recordSnapshotReplay?.(
				streamKeyOf(snapshot.runId),
				snapshot.events.length,
			);
			for (const frame of snapshot.events) deliver(frame);
			// The snapshot's own cursor is authoritative even when it delivered
			// no events (an empty page still moves the client onto the live run).
			if (snapshot.cursor !== null) setCursor(snapshot.cursor);

			const subscription = await conversationStub.subscribe((frame) => {
				if (!closed && myEpoch === epoch) deliver(frame);
			}, cursor);
			if (closed || myEpoch !== epoch) {
				disposeQuietly(subscription);
				return;
			}
			adoptStub(subscription, "subscription");

			conversation = conversationStub;
			attempt = 0;
			resumeFailures = 0;
			// A fresh subscription is a fresh liveness claim, and the watchdog is
			// the thing that will make the server keep proving it.
			lastLivenessAt = nowFn();
			armLivenessWatch(myEpoch);
			setStatus("open");
		} catch {
			if (closed || myEpoch !== epoch) return;
			epoch += 1;
			stopLivenessWatch();
			options.recordConnectFailure?.();
			disposeStubs();
			// A cursor names a specific run, and a run can stop resolving —
			// eviction, retirement, a revoked conversation. The server then
			// rejects the resume, and retrying the SAME cursor rejects
			// identically forever: the connection never recovers and the client
			// sits at the backoff ceiling claiming to be reconnecting. Retrying
			// a resume that has now failed twice drops the cursor and resumes
			// from the current run instead. One retry is kept because the
			// common failure is transport, not a dead run, and dropping the
			// cursor on the first blip would replay the run from its start.
			if (cursor !== null) {
				if (resumeFailures >= 1) {
					// Also drops the PARKED watermark: a cursor whose run stopped
					// resolving must not be handed to the next machine, or the
					// reset is undone by the very store that survived the close.
					resume?.reset();
					cursor = null;
					resumeFailures = 0;
					options.recordCursorReset?.();
				} else {
					resumeFailures += 1;
				}
			}
			scheduleReconnect();
		}
	};

	setStatus("connecting");
	void establish();

	const requireConversation = (): CapnConversationStub => {
		if (closed || conversation === null) throw new CapnNotConnectedError();
		return conversation;
	};

	return {
		close() {
			if (closed) return;
			closed = true;
			if (timer !== null) clearTimeoutFn(timer);
			timer = null;
			stopLivenessWatch();
			epoch += 1;
			disposeStubs();
			// Park BEFORE the idle status and the lease release: this is the whole
			// point of the store, and it parks only if this session settled
			// cleanly and never went unclean afterwards.
			resume?.close();
			// Release AFTER the capabilities: the hub disposes the socket when its
			// last lease goes, and a socket torn down under a live conversation
			// stub would strand the server-side pump.
			options.lease?.release();
			setStatus("idle");
		},
		getFrames() {
			// Arrival order. Sorting by offset would interleave runs wrongly:
			// offsets restart at 0 for every run.
			return [...frames.values()];
		},
		getCursor() {
			return cursor;
		},
		actions: {
			async enqueue(input, idempotencyKey) {
				const target = requireConversation();
				const myEpoch = epoch;
				try {
					return await target.enqueue(input, idempotencyKey);
				} catch (error) {
					// Give a same-tick onRpcBroken a chance to bump the epoch before
					// classifying, so a transport death racing the RPC rejection is
					// still recognized as an unknown outcome.
					await Promise.resolve();
					if (closed || myEpoch !== epoch) {
						throw new CapnOutcomeUnknownError(idempotencyKey, error);
					}
					throw error; // app-level rejection while the session stayed healthy
				}
			},
			async cancel(runId) {
				// Idempotent canonical verb: a connection-death rejection is safe to
				// retry, so it needs no unknown-outcome classification.
				return requireConversation().cancel(runId);
			},
			async respondApproval(params) {
				// Idempotent server-side (the approval latch resolves exactly once).
				return requireConversation().respondApproval(params);
			},
		},
	};
}
