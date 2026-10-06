/**
 * The global browser connection manager.
 *
 * One owner of every realtime subscription in the tab. Before this module each
 * mount opened its own stream, so two surfaces reading the same conversation
 * meant two connections, two replay backfills and two upstream long-poll pumps
 * against `apps/api` — while the server's limits
 * (`CAPN_MAX_LIVE_SUBSCRIPTIONS`, 30 calls / 10s) are counted PER SESSION, not
 * per component.
 *
 * What this owns, and what it deliberately does not:
 *
 * - IT OWNS ref-counting and fan-out. N logical subscribers on one capability
 *   share exactly ONE stream; the last release tears it down.
 * - IT OWNS generations. Every frame is stamped with the generation of the
 *   connection that produced it, and a reconnect bumps it, so a projection can
 *   drop a callback that outlived its connection instead of folding stale state
 *   on top of the authoritative post-reconnect replay.
 * - IT OWNS the DEGRADED signal. Cap'n Web is the ONLY event transport (there
 *   is no SSE fallback lane), so when the
 *   socket cannot establish — a WS-blocking middlebox, a server regression, a
 *   dev origin with no `/capn` — OR when it established and then went SILENT
 *   (`capn-chat-machine.ts`'s watchdog catching a dead server pump behind a
 *   healthy socket), the manager says so out loud instead of
 *   demoting to a second pipeline: `RealtimeStatusSnapshot.degraded` flips
 *   true, the shell chip renders it, and ChatThread arms its run-set /
 *   transcript polling off it. Established-conversation mutations remain on
 *   their Cap'n capability and surface unavailable until it reconnects.
 * - IT DOES NOT own retry. Backoff, resume cursors and capability
 *   re-acquisition stay in `capn-chat-machine.ts`. A second reconnect
 *   implementation would drift from it invisibly.
 * - IT DOES NOT own the `/collab` socket. Canvas documents ride a
 *   different (OT) protocol against a hibernating Durable Object with its own
 *   backoff (`lib/use-collab-doc.ts`); folding it in here would buy nothing and
 *   break its hibernation. That socket is explicitly out of scope.
 */

import { CAPN_MAX_LIVE_SUBSCRIPTIONS } from "@/capnweb/contract";
import {
	type CapnChatActions,
	connectCapnSocket,
	createCapnChatMachine,
} from "@/lib/capn-chat-machine";
import {
	type CapnSessionHub,
	getSharedCapnSessionHub,
	probeSharedCapnSessionHub,
	resetSharedCapnSessionHub,
} from "@/lib/capn-session-hub";
import {
	getSharedTransportMetrics,
	type TransportMetrics,
} from "@/lib/capn-measurement";
import {
	type ConversationStreamFrame,
	type ConversationStreamStatus,
	resetConversationResumeWatermarks,
} from "@/lib/conversation-stream";
import {
	createProjectionEnvelope,
	type ProjectionEnvelope,
} from "@/lib/projection-envelope";
import { createProjectionStore } from "@/lib/projection-store";
import type { CapnConnectFn } from "@/capnweb/contract";

export type RealtimeSubscriber = {
	/**
	 * One unseen frame and its local delivery metadata. The shared pump checks
	 * connection generation before replay and history cutoffs; the original
	 * frame retains the durable event payload and cursor.
	 */
	onFrame?: (
		frame: ConversationStreamFrame,
		envelope: ProjectionEnvelope,
	) => void;
	onStatus?: (status: ConversationStreamStatus) => void;
};

export type RealtimeLease = {
	/** Idempotent. The last release closes the underlying stream. */
	release(): void;
	getStatus(): ConversationStreamStatus;
	getGeneration(): number;
	/** Canonical-verb passthroughs; null while connecting. */
	getActions(): CapnChatActions | null;
};

/**
 * Per-capability transport configuration. Applied by the FIRST acquirer only —
 * a shared stream cannot have two configurations, and silently re-dialing on a
 * second acquirer's options would defeat the ref-count. Everything here is a
 * test seam.
 */
export type RealtimeStreamConfig = {
	connect?: CapnConnectFn;
	metrics?: TransportMetrics | null;
	setTimeoutFn?: (callback: () => void, ms: number) => unknown;
	clearTimeoutFn?: (handle: unknown) => void;
	setLivenessTimerFn?: (callback: () => void, ms: number) => unknown;
	clearLivenessTimerFn?: (handle: unknown) => void;
	nowFn?: () => number;
	randomFn?: () => number;
};

type StreamHandle = {
	close(): void;
	getFrames(): ConversationStreamFrame[];
};

type Entry = {
	key: string;
	conversationId: string;
	handle: StreamHandle;
	actions: CapnChatActions | null;
	status: ConversationStreamStatus;
	/** Bumped on every reconnect and on teardown. */
	generation: number;
	subscribers: Map<number, RealtimeSubscriber>;
	/** Pending deferred teardown (route change), cancelled if a subscriber returns. */
	closeTimer: unknown;
	metrics: TransportMetrics | null;
	/** Monotonic stamp of the most recent acquire; drives LRU eviction. */
	lastAcquiredAt: number;
	/** Consecutive failed establish attempts since the last successful open. */
	connectFailures: number;
	/** Proven pump stalls over this entry's life. */
	stalls: number;
	/** Live-updates-paused signal; set by the failure ladder, cleared on open. */
	degraded: boolean;
	/**
	 * A pump stall was proven and the degraded signal is latched until PUSH
	 * DELIVERY itself resumes. Reaching "open" is not proof here: the stall
	 * happened while this entry was already open, so clearing on the reconnect's
	 * own "open" would flash the signal for a few milliseconds and arm nothing.
	 */
	stalledUntilFrame: boolean;
};

const entries = new Map<string, Entry>();
let subscriberToken = 0;
let sharedHub: CapnSessionHub | null = null;

/**
 * Deferred-teardown delay. A route change unmounts the outgoing surface and
 * mounts the incoming one in the same commit, so a strict "refcount 0 closes
 * now" would drop and re-dial the connection on every navigation — replaying
 * the backfill and spending three rate-limit tokens each time. Deferring by a
 * macrotask makes release→acquire within one commit free while keeping the rule
 * itself exact: when the timer fires with no subscribers, the socket goes.
 */
export const REALTIME_TEARDOWN_DELAY_MS = 0;

/**
 * Consecutive failed establishes before the stream is declared DEGRADED. Two,
 * not one: a single failure is a cold Worker or a lost race, while two across
 * the machine's backoff mean the transport is not coming up in this
 * environment right now. The machine keeps retrying on its own ladder (30s
 * ceiling), so degradation is a signal, never a surrender — the next
 * successful open clears it.
 */
export const REALTIME_DEGRADED_AFTER_FAILURES = 2;

/**
 * Proven pump stalls before the stream is declared DEGRADED. ONE, unlike the
 * establish ladder: a failed connect might be a cold Worker, but a stall is a
 * verdict the client only reaches after finding durable events the live tail
 * never delivered — the UI was demonstrably stale, and no second opinion makes
 * it less so.
 */
export const REALTIME_DEGRADED_AFTER_STALLS = 1;

let scheduleTeardown: (callback: () => void, ms: number) => unknown = (
	callback,
	ms,
) => setTimeout(callback, ms);
let cancelTeardown: (handle: unknown) => void = (handle) =>
	clearTimeout(handle as ReturnType<typeof setTimeout>);

// ---------------------------------------------------------------------------
// Aggregate status — what the shell's transport indicator renders
// ---------------------------------------------------------------------------

export type RealtimeStatusSnapshot = {
	/**
	 * Worst status across live capabilities, so a single degraded stream is
	 * never hidden behind a healthy one.
	 */
	status: ConversationStreamStatus;
	/**
	 * True when any live stream has crossed the establish-failure ladder and
	 * live updates are paused. The consumer contract: render it visibly and arm
	 * polling; reads stay correct, only push delivery is degraded.
	 */
	degraded: boolean;
	/** Live server-side subscriptions (streams), not components. */
	subscriptions: number;
	/** Logical subscribers multiplexed onto those subscriptions. */
	subscribers: number;
	/** Live shared Cap'n Web sockets: 0 or 1, never one per surface. */
	sockets: number;
};

const EMPTY_STATUS: RealtimeStatusSnapshot = {
	status: "idle",
	degraded: false,
	subscriptions: 0,
	subscribers: 0,
	sockets: 0,
};

function sameStatus(
	a: RealtimeStatusSnapshot,
	b: RealtimeStatusSnapshot,
): boolean {
	return (
		a.status === b.status &&
		a.degraded === b.degraded &&
		a.subscriptions === b.subscriptions &&
		a.subscribers === b.subscribers &&
		a.sockets === b.sockets
	);
}

/**
 * Aggregate status store. `reduce` returns the SAME reference when nothing
 * moved, so the shell indicator re-renders on real transitions only.
 */
const statusStore = createProjectionStore<
	RealtimeStatusSnapshot,
	RealtimeStatusSnapshot
>({
	initial: () => EMPTY_STATUS,
	reduce: (state, next) => (sameStatus(state, next) ? state : next),
});

/** Worst-first: trouble in any capability must reach the indicator. */
const STATUS_SEVERITY: Record<ConversationStreamStatus, number> = {
	idle: 0,
	open: 1,
	connecting: 2,
	reconnecting: 3,
};

function publishStatus(): void {
	if (entries.size === 0) {
		statusStore.apply(EMPTY_STATUS);
		return;
	}
	let worst: ConversationStreamStatus = "idle";
	let subscribers = 0;
	let degraded = false;
	for (const entry of entries.values()) {
		subscribers += entry.subscribers.size;
		degraded = degraded || entry.degraded;
		if (STATUS_SEVERITY[entry.status] > STATUS_SEVERITY[worst]) {
			worst = entry.status;
		}
	}
	statusStore.apply({
		status: worst,
		degraded,
		subscriptions: entries.size,
		subscribers,
		sockets: sharedHub?.isConnected() === true ? 1 : 0,
	});
}

export function subscribeRealtimeStatus(listener: () => void): () => void {
	return statusStore.subscribe(listener);
}

export function getRealtimeStatus(): RealtimeStatusSnapshot {
	return statusStore.getSnapshot();
}

/** Prove the one shared socket on browser wake; failure enters its existing retry lane. */
export function probeRealtimeConnection(): Promise<boolean> {
	return probeSharedCapnSessionHub();
}

// ---------------------------------------------------------------------------
// The active conversation — what non-chat surfaces subscribe to
// ---------------------------------------------------------------------------

/**
 * There is exactly ONE forward-cursor push feed in the product: the
 * per-conversation durable event stream. There is no org- or workspace-scoped
 * tail, so a surface that is not Home has no capability of its own to open.
 *
 * Rather than invent a server capability, non-chat surfaces subscribe to the
 * conversation Home is (or was last) working in. Because the manager
 * ref-counts, Activity joining the stream Chat already holds costs ZERO extra
 * subscriptions, and navigating Home → Activity keeps the same one alive. The
 * honest limit: work that never touched this conversation is not on this feed,
 * and those surfaces still converge through their existing reads.
 */
let activeConversationId: string | null = null;
const activeConversationListeners = new Set<() => void>();

export function setActiveRealtimeConversation(
	conversationId: string | null,
): void {
	if (activeConversationId === conversationId) return;
	activeConversationId = conversationId;
	// Snapshot: a listener may unsubscribe itself during notification.
	const listeners = Array.from(activeConversationListeners);
	for (const listener of listeners) listener();
}

export function getActiveRealtimeConversation(): string | null {
	return activeConversationId;
}

export function subscribeActiveRealtimeConversation(
	listener: () => void,
): () => void {
	activeConversationListeners.add(listener);
	return () => {
		activeConversationListeners.delete(listener);
	};
}

// ---------------------------------------------------------------------------
// Capability acquisition
// ---------------------------------------------------------------------------

function conversationKey(conversationId: string): string {
	return `conversation:${conversationId}`;
}

function fanOutStatus(entry: Entry, status: ConversationStreamStatus): void {
	// A connection that has died and is retrying invalidates everything a
	// projection folded from it: the post-reconnect backfill is authoritative,
	// so in-flight callbacks from the dead generation must be dropped.
	if (status === "reconnecting" && entry.status !== "reconnecting") {
		entry.generation += 1;
	}
	if (status === "open") {
		// A successful open clears the failure ladder AND the degraded signal:
		// degradation is "the transport is not coming up", and it just did.
		// A stall latch survives it — see `stalledUntilFrame`.
		entry.connectFailures = 0;
		if (!entry.stalledUntilFrame) entry.degraded = false;
	}
	entry.status = status;
	// Snapshot: a subscriber may release itself inside its own callback.
	const listeners = Array.from(entry.subscribers.values());
	for (const subscriber of listeners) subscriber.onStatus?.(status);
	publishStatus();
}

function envelopeFor(
	entry: Entry,
	frame: ConversationStreamFrame,
	replay: boolean,
): ProjectionEnvelope {
	return createProjectionEnvelope({
		generation: entry.generation,
		replay,
		frame,
	});
}

function fanOutFrame(entry: Entry, frame: ConversationStreamFrame): void {
	if (entry.stalledUntilFrame) {
		// Push delivery is working again — the only evidence that actually
		// answers the question a stall raised.
		entry.stalledUntilFrame = false;
		entry.degraded = false;
		publishStatus();
	}
	// ONE envelope per frame, shared by every subscriber: the derivation is pure,
	// and building it per-subscriber would let N consumers disagree about the
	// generation if one of them released mid-fan-out.
	const envelope = envelopeFor(entry, frame, false);
	// Snapshot: a subscriber may release itself inside its own callback.
	const listeners = Array.from(entry.subscribers.values());
	for (const subscriber of listeners) subscriber.onFrame?.(frame, envelope);
}

/**
 * Client-side ceiling on concurrent conversation entries.
 *
 * One below the server's per-session subscription cap, leaving one slot for the
 * chat lane's own transient re-subscribe during a reconnect.
 */
const MAX_CONCURRENT_ENTRIES = CAPN_MAX_LIVE_SUBSCRIPTIONS - 1;

let acquireClock = 0;

function evictableEntryCount(): number {
	return entries.size;
}

function leastRecentlyAcquiredEntry(): Entry | null {
	let oldest: Entry | null = null;
	for (const candidate of entries.values()) {
		if (oldest === null || candidate.lastAcquiredAt < oldest.lastAcquiredAt) {
			oldest = candidate;
		}
	}
	return oldest;
}

function createEntry(
	conversationId: string,
	config: RealtimeStreamConfig,
): Entry {
	const metrics =
		config.metrics === undefined ? getSharedTransportMetrics() : config.metrics;
	const entry: Entry = {
		key: conversationKey(conversationId),
		conversationId,
		handle: { close: () => {}, getFrames: () => [] },
		actions: null,
		status: "connecting",
		generation: 1,
		subscribers: new Map(),
		closeTimer: null,
		metrics,
		lastAcquiredAt: acquireClock,
		connectFailures: 0,
		stalls: 0,
		degraded: false,
		stalledUntilFrame: false,
	};

	// ONE socket for the tab. The hub is created on first use with this
	// entry's connect seam; later entries share it, which is the point.
	if (sharedHub === null) {
		sharedHub = getSharedCapnSessionHub({
			connect: config.connect ?? connectCapnSocket,
			trackStub: metrics
				? (label) => metrics.trackStub("capn", label)
				: undefined,
		});
	}
	const machine = createCapnChatMachine({
		conversationId,
		connect: config.connect ?? connectCapnSocket,
		lease: sharedHub.lease(),
		onFrame: (frame) => fanOutFrame(entry, frame),
		onStatus: (status) => fanOutStatus(entry, status),
		// Run-namespaced ledger key: offsets are run-local, so a
		// conversation-keyed ledger reports phantom gaps and duplicates.
		recordWireOffset: metrics
			? (streamKey, offset) =>
					metrics.recordWireOffset("capn", streamKey, offset)
			: undefined,
		// Unconditional: the degraded signal depends on this, so it cannot be
		// gated on measurement being enabled.
		recordConnectFailure: () => {
			metrics?.recordConnectFailure("capn");
			entry.connectFailures += 1;
			if (
				!entry.degraded &&
				entry.connectFailures >= REALTIME_DEGRADED_AFTER_FAILURES
			) {
				entry.degraded = true;
				publishStatus();
			}
		},
		recordSnapshotReplay: metrics
			? (streamKey, eventCount) =>
					metrics.recordSnapshotReplay("capn", streamKey, eventCount)
			: undefined,
		// Unconditional for the same reason as recordConnectFailure: the degraded
		// signal is a product behavior, not a measurement.
		recordStreamStall: () => {
			metrics?.recordStreamStall("capn", entry.key);
			entry.stalls += 1;
			if (!entry.degraded && entry.stalls >= REALTIME_DEGRADED_AFTER_STALLS) {
				entry.degraded = true;
			}
			entry.stalledUntilFrame = true;
			publishStatus();
		},
		trackStub: metrics
			? (label) => metrics.trackStub("capn", label)
			: undefined,
		setTimeoutFn: config.setTimeoutFn,
		clearTimeoutFn: config.clearTimeoutFn,
		setLivenessTimerFn: config.setLivenessTimerFn,
		clearLivenessTimerFn: config.clearLivenessTimerFn,
		nowFn: config.nowFn,
		randomFn: config.randomFn,
	});
	entry.handle = machine;
	entry.actions = machine.actions;
	return entry;
}

function destroyEntry(entry: Entry): void {
	entries.delete(entry.key);
	entry.generation += 1;
	entry.subscribers.clear();
	entry.handle.close();
	entry.metrics?.markSessionClosed("capn");
	if (sharedHub !== null && sharedHub.leaseCount() === 0) {
		// Reset the MODULE singleton too, not just this reference: leaving it
		// alive retains the first entry's connect seam and metrics closure for
		// the process lifetime, so a later acquire with a different seam
		// silently dials the old one.
		resetSharedCapnSessionHub();
		sharedHub = null;
	}
	publishStatus();
}

/**
 * Joins (or opens) the durable event stream for one conversation.
 *
 * The first acquirer opens the stream and fixes its configuration; every later
 * acquirer is a pure fan-out with no wire cost, and is immediately backfilled
 * from the stream's own frame buffer so a late joiner sees the same history as
 * an early one. Release is idempotent and the last one tears the stream down.
 */
export function acquireConversationStream(
	conversationId: string,
	subscriber: RealtimeSubscriber,
	config: RealtimeStreamConfig = {},
): RealtimeLease {
	const key = conversationKey(conversationId);
	let entry = entries.get(key);
	const fresh = entry === undefined;
	if (entry === undefined) {
		// Entries share ONE socket, and the server caps live subscriptions per
		// session. Past that cap the server refuses `subscribe`, and the refusal
		// feeds the machine's retry ladder — so an uncapped manager degrades into
		// a permanent storm that also spends the shared 30/10s call budget and
		// starves the HEALTHY entries. Evicting the least-recently-acquired entry
		// keeps the newest surface live and bounds the damage instead.
		if (evictableEntryCount() >= MAX_CONCURRENT_ENTRIES) {
			const victim = leastRecentlyAcquiredEntry();
			if (victim) destroyEntry(victim);
		}
		entry = createEntry(conversationId, config);
		entries.set(key, entry);
	} else if (entry.closeTimer !== null) {
		// A deferred teardown was pending — this acquire cancels it, which is what
		// makes a route change free instead of a reconnect.
		cancelTeardown(entry.closeTimer);
		entry.closeTimer = null;
	}
	acquireClock += 1;
	entry.lastAcquiredAt = acquireClock;
	const owner = entry;
	const token = subscriberToken;
	subscriberToken += 1;
	owner.subscribers.set(token, subscriber);

	if (!fresh) {
		// LOCAL BACKFILL: the wire backfill already happened for this stream, so
		// replay its buffer rather than re-dialing. Frames are marked `replay` so
		// a subscriber can tell a historical fold from a live one.
		for (const frame of owner.handle.getFrames()) {
			subscriber.onFrame?.(frame, envelopeFor(owner, frame, true));
		}
		subscriber.onStatus?.(owner.status);
	}
	publishStatus();

	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			owner.subscribers.delete(token);
			publishStatus();
			if (owner.subscribers.size > 0) return;
			if (owner.closeTimer !== null) return;
			owner.closeTimer = scheduleTeardown(() => {
				owner.closeTimer = null;
				// Re-check: an acquire may have landed after the timer was armed.
				if (owner.subscribers.size > 0) return;
				if (entries.get(owner.key) !== owner) return;
				destroyEntry(owner);
			}, REALTIME_TEARDOWN_DELAY_MS);
		},
		getStatus() {
			return owner.status;
		},
		getGeneration() {
			return owner.generation;
		},
		getActions() {
			return owner.actions;
		},
	};
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/**
 * Replaces the deferred-teardown timer. Tests drive teardown deterministically
 * instead of racing a real macrotask.
 * @internal
 */
export function configureRealtimeTeardown(timers: {
	schedule: (callback: () => void, ms: number) => unknown;
	cancel: (handle: unknown) => void;
}): void {
	scheduleTeardown = timers.schedule;
	cancelTeardown = timers.cancel;
}

/**
 * Hard reset: closes every stream and drops the shared socket. Module state is
 * process-wide by design, so every suite that touches the manager must call
 * this between tests or it inherits the previous one's connections.
 */
export function resetRealtimeConnections(): void {
	// Snapshot: `destroyEntry` removes the entry from the map it iterates.
	const live = Array.from(entries.values());
	for (const entry of live) {
		if (entry.closeTimer !== null) cancelTeardown(entry.closeTimer);
		entry.closeTimer = null;
		destroyEntry(entry);
	}
	entries.clear();
	sharedHub = null;
	resetSharedCapnSessionHub();
	// Resume watermarks are lane state too: destroying the entries above parks
	// the cursors of every cleanly settled machine, and leaving them behind
	// would make the next "first connection" resume from this suite's log.
	resetConversationResumeWatermarks();
	activeConversationId = null;
	activeConversationListeners.clear();
	scheduleTeardown = (callback, ms) => setTimeout(callback, ms);
	cancelTeardown = (handle) =>
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	statusStore.apply(EMPTY_STATUS);
	statusStore.flush();
}

/** Live server-side subscriptions. The ref-count's observable claim. */
/** @internal */
export function realtimeSubscriptionCount(): number {
	return entries.size;
}

/** Logical subscribers multiplexed onto those subscriptions. */
/** @internal */
export function realtimeSubscriberCount(): number {
	let total = 0;
	for (const entry of entries.values()) total += entry.subscribers.size;
	return total;
}
