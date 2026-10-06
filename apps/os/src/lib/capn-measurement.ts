/**
 * Transport measurement harness for the Cap'n Web chat transport:
 *
 * - `first_token_ms`         enqueue() call → first assistant `message.delta`
 *                            for that run (idempotencyKey IS the run id
 *                            server-side, so deltas correlate by runId).
 * - `send_to_visible_ms`     enqueue() call → enqueue settled (the optimistic
 *                            user bubble renders synchronously from the
 *                            response, so settle time is the visible bound).
 * - `reconnect_recovery_ms`  status "reconnecting" → next "open".
 * - `duplicate_event`        app-layer re-delivery, keyed by event id, counted
 *                            AFTER each transport's own dedupe (expected 0 —
 *                            a nonzero value is a transport defect).
 * - `wire_duplicate_offset`  Cap'n wire-layer duplicate offsets, PRE-dedupe
 *                            (reconnect replay overlap shows up here).
 * - `snapshot_replay_events` events served by ONE `ConversationCap.snapshot()`
 *                            — every reconnect and every liveness probe pays
 *                            one. Sample count is how many replays happened,
 *                            the summed value is how much they re-shipped, so
 *                            a reconnect storm is legible instead of being
 *                            inferred from duplicate offsets.
 * - `stream_stall`           the subscription pump went silent while the
 *                            socket stayed healthy: the client's liveness
 *                            probe found durable events the live tail never
 *                            delivered and forced a reconnect.
 * - wire missing offsets     summary-computed per stream ledger: the offset
 *                            span minus distinct offsets seen.
 * - `connect_failed`         a session establish attempt that did not reach
 *                            "open". Without it, a lane that can NEVER connect
 *                            records nothing at all (no reconnect sample is
 *                            emitted, because recovery is measured on the
 *                            reconnecting→open edge) and the harness cannot
 *                            tell "healthy" from "never connected".
 * - `unknown_outcome`        enqueues whose connection died mid-call.
 * - `leaked_stub`            stubs still live when their session closed
 *                            (tracked via an acquire/release registry).
 *
 * Everything is pure, in-memory, clock-injectable, and bounded by a ring.
 * In dev builds the shared instance is exposed as
 * `window.__tedixTransportMetrics` (samples() / summary() from the console).
 */

export type TransportLane = "capn";

export type TransportMetricName =
	| "first_token_ms"
	| "send_to_visible_ms"
	| "reconnect_recovery_ms"
	| "duplicate_event"
	| "wire_duplicate_offset"
	| "snapshot_replay_events"
	| "stream_stall"
	| "connect_failed"
	| "unknown_outcome"
	| "leaked_stub";

export type TransportMetricSample = {
	at: number;
	lane: TransportLane;
	metric: TransportMetricName;
	/** Latency in ms for `*_ms` metrics; the occurrence count (1) otherwise. */
	value: number;
	/** Correlation key: runId / idempotencyKey / offset / stub label. */
	key?: string;
};

export type LatencyStat = {
	count: number;
	meanMs: number | null;
	maxMs: number | null;
	lastMs: number | null;
};

export type TransportLaneSummary = {
	firstToken: LatencyStat;
	sendToVisible: LatencyStat;
	reconnectRecovery: LatencyStat;
	duplicateEvents: number;
	wireDuplicateOffsets: number;
	/** Gaps in the per-stream offset ledgers: span minus offsets seen. */
	wireMissingOffsets: number;
	/** `ConversationCap.snapshot()` calls served (reconnects + liveness probes). */
	replaySnapshots: number;
	/** Events those snapshots re-shipped, summed. */
	replayEvents: number;
	/** Pump stalls detected by the client watchdog (healthy socket, dead tail). */
	streamStalls: number;
	/** Establish attempts that never reached "open". */
	connectFailures: number;
	unknownOutcomes: number;
	leakedStubs: number;
	liveStubs: number;
};

export type TransportMetricsSummary = Record<
	TransportLane,
	TransportLaneSummary
>;

export type TransportMetrics = {
	/** Enqueue initiated — arms first-token and send-to-visible pairing. */
	markEnqueued(lane: TransportLane, idempotencyKey: string): void;
	/** Enqueue settled successfully — the optimistic bubble is renderable. */
	markVisible(lane: TransportLane, idempotencyKey: string): void;
	/** First assistant delta for a run; no-op unless that run was enqueue-armed. */
	markFirstAssistantDelta(lane: TransportLane, runId: string): void;
	markDisconnected(lane: TransportLane): void;
	markReconnected(lane: TransportLane): void;
	/** App-layer delivery, post transport dedupe — duplicates by event id. */
	recordEventId(lane: TransportLane, eventId: string): void;
	/** Cap'n wire-layer offsets, pre-dedupe — duplicates and gap ledger. */
	recordWireOffset(
		lane: TransportLane,
		streamKey: string,
		offset: number,
	): void;
	/** One replay snapshot and how many events it served. */
	recordSnapshotReplay(
		lane: TransportLane,
		streamKey: string,
		eventCount: number,
	): void;
	/** The live tail went silent while the socket stayed up. */
	recordStreamStall(lane: TransportLane, streamKey: string): void;
	/** One failed session establish attempt (pre-"open"). */
	recordConnectFailure(lane: TransportLane): void;
	recordUnknownOutcome(lane: TransportLane, idempotencyKey: string): void;
	/** Register a live stub; call the returned release exactly once on dispose. */
	trackStub(lane: TransportLane, label: string): () => void;
	/** Session ended: every still-live stub is recorded as leaked. Returns the count. */
	markSessionClosed(lane: TransportLane): number;
	liveStubCount(lane: TransportLane): number;
	samples(): TransportMetricSample[];
	summary(): TransportMetricsSummary;
};

export const DEFAULT_RING_CAPACITY = 500;

/** Bounded FIFO id set: dedupe memory can never grow past `capacity`. */
const SEEN_ID_CAPACITY = 10_000;

type LatencyAccumulator = {
	count: number;
	totalMs: number;
	maxMs: number | null;
	lastMs: number | null;
};

type OffsetLedger = {
	seen: Set<number>;
	min: number;
	max: number;
	duplicates: number;
};

type LaneState = {
	/** idempotencyKey → enqueue start (ms). */
	pendingEnqueues: Map<string, number>;
	firstTokenDone: Set<string>;
	visibleDone: Set<string>;
	disconnectedAt: number | null;
	seenEventIds: Set<string>;
	seenEventIdOrder: string[];
	ledgers: Map<string, OffsetLedger>;
	liveStubs: Map<number, string>;
	firstToken: LatencyAccumulator;
	sendToVisible: LatencyAccumulator;
	reconnectRecovery: LatencyAccumulator;
	duplicateEvents: number;
	replaySnapshots: number;
	replayEvents: number;
	streamStalls: number;
	connectFailures: number;
	unknownOutcomes: number;
	leakedStubs: number;
};

function createLatencyAccumulator(): LatencyAccumulator {
	return { count: 0, totalMs: 0, maxMs: null, lastMs: null };
}

function createLaneState(): LaneState {
	return {
		pendingEnqueues: new Map(),
		firstTokenDone: new Set(),
		visibleDone: new Set(),
		disconnectedAt: null,
		seenEventIds: new Set(),
		seenEventIdOrder: [],
		ledgers: new Map(),
		liveStubs: new Map(),
		firstToken: createLatencyAccumulator(),
		sendToVisible: createLatencyAccumulator(),
		reconnectRecovery: createLatencyAccumulator(),
		duplicateEvents: 0,
		replaySnapshots: 0,
		replayEvents: 0,
		streamStalls: 0,
		connectFailures: 0,
		unknownOutcomes: 0,
		leakedStubs: 0,
	};
}

function accumulate(accumulator: LatencyAccumulator, latencyMs: number): void {
	accumulator.count += 1;
	accumulator.totalMs += latencyMs;
	accumulator.maxMs =
		accumulator.maxMs === null
			? latencyMs
			: Math.max(accumulator.maxMs, latencyMs);
	accumulator.lastMs = latencyMs;
}

function latencyStat(accumulator: LatencyAccumulator): LatencyStat {
	return {
		count: accumulator.count,
		meanMs:
			accumulator.count === 0 ? null : accumulator.totalMs / accumulator.count,
		maxMs: accumulator.maxMs,
		lastMs: accumulator.lastMs,
	};
}

function missingOffsets(ledgers: Map<string, OffsetLedger>): number {
	let missing = 0;
	for (const ledger of ledgers.values()) {
		const span = ledger.max - ledger.min + 1;
		missing += Math.max(0, span - ledger.seen.size);
	}
	return missing;
}

export type TransportMetricsOptions = {
	now?: () => number;
	ringCapacity?: number;
};

export function createTransportMetrics(
	options: TransportMetricsOptions = {},
): TransportMetrics {
	const now = options.now ?? (() => Date.now());
	const ringCapacity = options.ringCapacity ?? DEFAULT_RING_CAPACITY;
	const ring: TransportMetricSample[] = [];
	const lanes: Record<TransportLane, LaneState> = {
		capn: createLaneState(),
	};
	let stubToken = 0;

	const record = (
		lane: TransportLane,
		metric: TransportMetricName,
		value: number,
		key?: string,
	): void => {
		ring.push({ at: now(), lane, metric, value, key });
		if (ring.length > ringCapacity) ring.splice(0, ring.length - ringCapacity);
	};

	const settlePending = (state: LaneState, key: string): void => {
		if (state.firstTokenDone.has(key) && state.visibleDone.has(key)) {
			state.pendingEnqueues.delete(key);
			state.firstTokenDone.delete(key);
			state.visibleDone.delete(key);
		}
	};

	return {
		markEnqueued(lane, idempotencyKey) {
			const state = lanes[lane];
			// A same-key retry re-arms the measurement: each attempt is timed.
			state.pendingEnqueues.set(idempotencyKey, now());
			state.firstTokenDone.delete(idempotencyKey);
			state.visibleDone.delete(idempotencyKey);
		},
		markVisible(lane, idempotencyKey) {
			const state = lanes[lane];
			const startedAt = state.pendingEnqueues.get(idempotencyKey);
			if (startedAt === undefined || state.visibleDone.has(idempotencyKey)) {
				return;
			}
			state.visibleDone.add(idempotencyKey);
			const latency = now() - startedAt;
			accumulate(state.sendToVisible, latency);
			record(lane, "send_to_visible_ms", latency, idempotencyKey);
			settlePending(state, idempotencyKey);
		},
		markFirstAssistantDelta(lane, runId) {
			const state = lanes[lane];
			const startedAt = state.pendingEnqueues.get(runId);
			if (startedAt === undefined || state.firstTokenDone.has(runId)) return;
			state.firstTokenDone.add(runId);
			const latency = now() - startedAt;
			accumulate(state.firstToken, latency);
			record(lane, "first_token_ms", latency, runId);
			settlePending(state, runId);
		},
		markDisconnected(lane) {
			const state = lanes[lane];
			// Keep the FIRST disconnect instant across repeated backoff cycles:
			// recovery time is outage start → next open, not last retry → open.
			if (state.disconnectedAt === null) state.disconnectedAt = now();
		},
		markReconnected(lane) {
			const state = lanes[lane];
			if (state.disconnectedAt === null) return;
			const latency = now() - state.disconnectedAt;
			state.disconnectedAt = null;
			accumulate(state.reconnectRecovery, latency);
			record(lane, "reconnect_recovery_ms", latency);
		},
		recordEventId(lane, eventId) {
			const state = lanes[lane];
			if (state.seenEventIds.has(eventId)) {
				state.duplicateEvents += 1;
				record(lane, "duplicate_event", 1, eventId);
				return;
			}
			state.seenEventIds.add(eventId);
			state.seenEventIdOrder.push(eventId);
			if (state.seenEventIdOrder.length > SEEN_ID_CAPACITY) {
				const evicted = state.seenEventIdOrder.shift();
				if (evicted !== undefined) state.seenEventIds.delete(evicted);
			}
		},
		recordWireOffset(lane, streamKey, offset) {
			if (!Number.isInteger(offset) || offset < 0) return;
			const state = lanes[lane];
			let ledger = state.ledgers.get(streamKey);
			if (ledger === undefined) {
				ledger = { seen: new Set(), min: offset, max: offset, duplicates: 0 };
				state.ledgers.set(streamKey, ledger);
			}
			if (ledger.seen.has(offset)) {
				ledger.duplicates += 1;
				record(lane, "wire_duplicate_offset", 1, String(offset));
				return;
			}
			ledger.seen.add(offset);
			ledger.min = Math.min(ledger.min, offset);
			ledger.max = Math.max(ledger.max, offset);
		},
		recordSnapshotReplay(lane, streamKey, eventCount) {
			if (!Number.isInteger(eventCount) || eventCount < 0) return;
			const state = lanes[lane];
			state.replaySnapshots += 1;
			state.replayEvents += eventCount;
			record(lane, "snapshot_replay_events", eventCount, streamKey);
		},
		recordStreamStall(lane, streamKey) {
			const state = lanes[lane];
			state.streamStalls += 1;
			record(lane, "stream_stall", 1, streamKey);
		},
		recordConnectFailure(lane) {
			const state = lanes[lane];
			state.connectFailures += 1;
			record(lane, "connect_failed", 1);
		},
		recordUnknownOutcome(lane, idempotencyKey) {
			const state = lanes[lane];
			state.unknownOutcomes += 1;
			record(lane, "unknown_outcome", 1, idempotencyKey);
		},
		trackStub(lane, label) {
			const state = lanes[lane];
			const token = stubToken;
			stubToken += 1;
			state.liveStubs.set(token, label);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				state.liveStubs.delete(token);
			};
		},
		markSessionClosed(lane) {
			const state = lanes[lane];
			const leaked = [...state.liveStubs.values()];
			state.liveStubs.clear();
			for (const label of leaked) {
				state.leakedStubs += 1;
				record(lane, "leaked_stub", 1, label);
			}
			return leaked.length;
		},
		liveStubCount(lane) {
			return lanes[lane].liveStubs.size;
		},
		samples() {
			return [...ring];
		},
		summary() {
			const laneSummary = (lane: TransportLane): TransportLaneSummary => {
				const state = lanes[lane];
				let wireDuplicates = 0;
				for (const ledger of state.ledgers.values()) {
					wireDuplicates += ledger.duplicates;
				}
				return {
					firstToken: latencyStat(state.firstToken),
					sendToVisible: latencyStat(state.sendToVisible),
					reconnectRecovery: latencyStat(state.reconnectRecovery),
					duplicateEvents: state.duplicateEvents,
					wireDuplicateOffsets: wireDuplicates,
					wireMissingOffsets: missingOffsets(state.ledgers),
					replaySnapshots: state.replaySnapshots,
					replayEvents: state.replayEvents,
					streamStalls: state.streamStalls,
					connectFailures: state.connectFailures,
					unknownOutcomes: state.unknownOutcomes,
					leakedStubs: state.leakedStubs,
					liveStubs: state.liveStubs.size,
				};
			};
			return { capn: laneSummary("capn") };
		},
	};
}

// ---------------------------------------------------------------------------
// Dev-only shared instance on window.__tedixTransportMetrics
// ---------------------------------------------------------------------------

export type TransportMetricsGlobal = {
	__tedixTransportMetrics?: TransportMetrics;
};

export function isDevBuild(): boolean {
	try {
		return import.meta.env.DEV === true;
	} catch {
		return false;
	}
}

/**
 * The single shared instance both transport hooks write to. Dev builds only —
 * production returns `null` and every metrics call site is `?.`-guarded, so
 * the harness costs nothing where it isn't being read.
 */
export function getSharedTransportMetrics(
	dev: boolean = isDevBuild(),
	target: TransportMetricsGlobal = globalThis as TransportMetricsGlobal,
): TransportMetrics | null {
	if (!dev) return null;
	if (target.__tedixTransportMetrics === undefined) {
		target.__tedixTransportMetrics = createTransportMetrics();
	}
	return target.__tedixTransportMetrics;
}
