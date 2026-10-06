import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type {
	CapnConversationSnapshot,
	CapnConversationStub,
	CapnEventFrame,
	CapnSessionStub,
	CapnStreamCursor,
	CapnSubscriber,
} from "@/capnweb/contract";
import { CAPN_LIVENESS_IDLE_MS } from "./capn-chat-machine";
import {
	acquireConversationStream,
	configureRealtimeTeardown,
	getRealtimeStatus,
	REALTIME_DEGRADED_AFTER_FAILURES,
	realtimeSubscriberCount,
	realtimeSubscriptionCount,
	resetRealtimeConnections,
	subscribeRealtimeStatus,
} from "./realtime-connection";

const CONVERSATION_ID = "home:main";
const OTHER_CONVERSATION_ID = "home:other";
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function event(
	overrides: Partial<RuntimeStreamEvent> = {},
): RuntimeStreamEvent {
	return {
		id: overrides.id ?? "evt-1",
		kind: overrides.kind ?? "message.delta",
		conversationId: CONVERSATION_ID,
		runId: RUN_ID,
		delta: "hi",
		sequence: 0,
		createdAt: "2026-08-16T00:00:00.000Z",
		...overrides,
	};
}

function wireFrame(offset: number, body: RuntimeStreamEvent): CapnEventFrame {
	return {
		conversationId: body.conversationId ?? CONVERSATION_ID,
		runId: RUN_ID,
		offset,
		nextOffset: offset + 1,
		event: body,
	};
}

/**
 * One fake `/capn` server, mirroring `use-capn-chat.test.ts`'s double: typed
 * as the SHARED contract's client projection so it cannot drift from what the
 * Worker actually returns. Subscribers are tracked PER conversation so two
 * capabilities on one socket stay distinguishable.
 */
function mockServer() {
	const subscribers = new Map<string, CapnSubscriber>();
	let openCalls = 0;

	const conversationFor = (conversationId: string): CapnConversationStub => {
		const snapshotFor = (
			cursor: CapnStreamCursor | null,
		): CapnConversationSnapshot => ({
			conversationId,
			runId: cursor?.runId ?? RUN_ID,
			events: [],
			cursor: { runId: cursor?.runId ?? RUN_ID, offset: cursor?.offset ?? 0 },
			stream: {
				streamId: "stream-1",
				offset: cursor?.offset ?? 0,
				nextOffset: cursor?.offset ?? 0,
				closed: false,
			},
		});
		return {
			snapshot: async (cursor) => snapshotFor(cursor ?? null),
			subscribe: async (callback) => {
				subscribers.set(conversationId, callback);
				return { [Symbol.dispose]: () => {} };
			},
			enqueue: async (_input: { content: string }, idempotencyKey: string) =>
				({ idempotencyKey }) as never,
			cancel: (async () => ({})) as unknown as CapnConversationStub["cancel"],
			respondApproval: async () => ({}) as never,
			[Symbol.dispose]: () => {},
		};
	};

	const brokenCallbacks: Array<(error: unknown) => void> = [];
	const root: CapnSessionStub = {
		ping: async () => {},
		openConversation: (conversationId: string) => {
			openCalls += 1;
			const conversation = conversationFor(conversationId);
			const settled = Promise.resolve(conversation);
			return new Proxy(
				(() => {}) as unknown as Promise<CapnConversationStub> &
					CapnConversationStub,
				{
					get(_target, property) {
						if (
							property === "then" ||
							property === "catch" ||
							property === "finally"
						) {
							return (settled[property] as (...args: never[]) => unknown).bind(
								settled,
							);
						}
						const inner = (conversation as Record<PropertyKey, unknown>)[
							property
						];
						return typeof inner === "function"
							? inner.bind(conversation)
							: inner;
					},
				},
			);
		},
		onRpcBroken: (callback) => {
			brokenCallbacks.push(callback);
		},
		[Symbol.dispose]: () => {},
	};

	return {
		root,
		openCallCount: () => openCalls,
		emit: (conversationId: string, frame: CapnEventFrame) =>
			subscribers.get(conversationId)?.(frame),
		breakConnection: (error: unknown = new Error("socket died")) => {
			for (const callback of brokenCallbacks) callback(error);
		},
	};
}

/**
 * A `/capn` double whose DURABLE log and whose PUSH tail are separate, so a
 * server-side pump death can be staged without touching the socket. The
 * shared `mockServer` above deliberately serves empty snapshots, which can
 * never look stale.
 */
function stallableServer() {
	/** `RUN_EVENT_STREAM_PAGE` from `run-reads-streams.ts` — see below. */
	const RUN_EVENT_STREAM_PAGE = 200;
	const log: CapnEventFrame[] = [];
	let subscriber: CapnSubscriber | null = null;
	let subscribes = 0;

	const conversation: CapnConversationStub = {
		snapshot: async (cursor) => {
			const from = cursor?.runId === RUN_ID ? cursor.offset : 0;
			const rows = log.filter((entry) => entry.offset >= from);
			// Paginated exactly like the server: one page, and a nextOffset that
			// is the PAGE's end (`start + slicedRows.length`), never the run's.
			const events = rows.slice(0, RUN_EVENT_STREAM_PAGE);
			const nextOffset = from + events.length;
			return {
				conversationId: CONVERSATION_ID,
				runId: RUN_ID,
				events,
				cursor: { runId: RUN_ID, offset: nextOffset },
				stream: {
					streamId: "stream-1",
					offset: from,
					nextOffset,
					closed: false,
				},
			};
		},
		subscribe: async (callback) => {
			subscribes += 1;
			subscriber = callback;
			return { [Symbol.dispose]: () => {} };
		},
		enqueue: async (_input: { content: string }, idempotencyKey: string) =>
			({ idempotencyKey }) as never,
		cancel: (async () => ({})) as unknown as CapnConversationStub["cancel"],
		respondApproval: async () => ({}) as never,
		[Symbol.dispose]: () => {},
	};

	const root: CapnSessionStub = {
		ping: async () => {},
		openConversation: () =>
			Object.assign(Promise.resolve(conversation), conversation),
		onRpcBroken: () => {},
		[Symbol.dispose]: () => {},
	};

	return {
		root,
		subscribeCount: () => subscribes,
		/** Durable write the live tail also delivers. */
		push: (frame: CapnEventFrame) => {
			log.push(frame);
			void subscriber?.(frame);
		},
		/** Durable write NOTHING delivers — the pump is dead. */
		writeDurable: (frame: CapnEventFrame) => {
			log.push(frame);
		},
	};
}

function fakeTimers() {
	const scheduled: Array<{ callback: () => void; ms: number }> = [];
	return {
		scheduled,
		setTimeoutFn: (callback: () => void, ms: number): unknown => {
			scheduled.push({ callback, ms });
			return scheduled.length - 1;
		},
		clearTimeoutFn: (): void => {},
		fireNext: () => {
			scheduled.shift()?.callback();
		},
	};
}

/** Drains the machine's await chain (connect → open → snapshot → subscribe). */
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Deterministic deferred teardown: tests fire the timer themselves. */
function manualTeardown() {
	const queue: Array<{ id: number; callback: () => void }> = [];
	let next = 1;
	return {
		timers: {
			schedule: (callback: () => void) => {
				const id = next;
				next += 1;
				queue.push({ id, callback });
				return id;
			},
			cancel: (handle: unknown) => {
				const index = queue.findIndex((entry) => entry.id === handle);
				if (index >= 0) queue.splice(index, 1);
			},
		},
		run() {
			const pending = queue.splice(0, queue.length);
			for (const entry of pending) entry.callback();
		},
		pending() {
			return queue.length;
		},
	};
}

/**
 * Teardown is DEFERRED by one macrotask (see `REALTIME_TEARDOWN_DELAY_MS`), so
 * every test drives that timer itself rather than racing a real one.
 */
let teardown = manualTeardown();

beforeEach(() => {
	teardown = manualTeardown();
	configureRealtimeTeardown(teardown.timers);
});

afterEach(() => {
	resetRealtimeConnections();
});

describe("acquireConversationStream ref-counting", () => {
	it("multiplexes N subscribers onto ONE stream and tears down on the last release", async () => {
		const server = mockServer();
		let dials = 0;
		const connect = async () => {
			dials += 1;
			return server.root;
		};
		const first: RuntimeStreamEvent[] = [];
		const second: RuntimeStreamEvent[] = [];

		const a = acquireConversationStream(
			CONVERSATION_ID,
			{ onFrame: (frame) => first.push(frame.event) },
			{ connect, metrics: null },
		);
		const b = acquireConversationStream(CONVERSATION_ID, {
			onFrame: (frame) => second.push(frame.event),
		});
		await flushAsync();

		// One socket, one server-side subscription, two logical subscribers.
		// This is the whole claim.
		expect(dials).toBe(1);
		expect(server.openCallCount()).toBe(1);
		expect(realtimeSubscriptionCount()).toBe(1);
		expect(realtimeSubscriberCount()).toBe(2);

		server.emit(CONVERSATION_ID, wireFrame(0, event({ id: "evt-1" })));
		expect(first.map((entry) => entry.id)).toEqual(["evt-1"]);
		expect(second.map((entry) => entry.id)).toEqual(["evt-1"]);

		// Releasing one subscriber must not close the shared stream.
		a.release();
		server.emit(CONVERSATION_ID, wireFrame(1, event({ id: "evt-2" })));
		expect(first).toHaveLength(1);
		expect(second).toHaveLength(2);

		b.release();
		teardown.run();
		expect(realtimeSubscriptionCount()).toBe(0);
	});

	it("backfills a late subscriber from the stream buffer instead of re-dialing", async () => {
		const server = mockServer();
		let dials = 0;
		const connect = async () => {
			dials += 1;
			return server.root;
		};
		acquireConversationStream(CONVERSATION_ID, {}, { connect, metrics: null });
		await flushAsync();
		server.emit(CONVERSATION_ID, wireFrame(0, event({ id: "evt-1" })));
		server.emit(CONVERSATION_ID, wireFrame(1, event({ id: "evt-2" })));

		const late: Array<{ id: string; replay: boolean }> = [];
		acquireConversationStream(CONVERSATION_ID, {
			onFrame: (frame, envelope) =>
				late.push({ id: frame.event.id, replay: envelope.replay }),
		});

		// No second dial, and the late joiner sees the same history — flagged as
		// replay so a consumer can tell a historical fold from a live one.
		expect(dials).toBe(1);
		expect(late).toEqual([
			{ id: "evt-1", replay: true },
			{ id: "evt-2", replay: true },
		]);
	});

	it("opens separate subscriptions for separate conversations on ONE socket", async () => {
		const server = mockServer();
		let dials = 0;
		const connect = async () => {
			dials += 1;
			return server.root;
		};
		acquireConversationStream(CONVERSATION_ID, {}, { connect, metrics: null });
		acquireConversationStream(
			OTHER_CONVERSATION_ID,
			{},
			{ connect, metrics: null },
		);
		await flushAsync();
		expect(realtimeSubscriptionCount()).toBe(2);
		expect(server.openCallCount()).toBe(2);
		// The hub shares one socket across capabilities — that is its point.
		expect(dials).toBe(1);
	});

	it("release is idempotent and never double-decrements the ref-count", async () => {
		const server = mockServer();
		const connect = async () => server.root;
		const a = acquireConversationStream(
			CONVERSATION_ID,
			{},
			{ connect, metrics: null },
		);
		const b = acquireConversationStream(CONVERSATION_ID, {});
		await flushAsync();
		a.release();
		a.release();
		a.release();
		expect(realtimeSubscriberCount()).toBe(1);
		b.release();
		teardown.run();
		expect(realtimeSubscriptionCount()).toBe(0);
	});
});

describe("deferred teardown", () => {
	it("a release followed by an acquire in the same tick keeps the stream", async () => {
		const server = mockServer();
		let dials = 0;
		const connect = async () => {
			dials += 1;
			return server.root;
		};

		const a = acquireConversationStream(
			CONVERSATION_ID,
			{},
			{ connect, metrics: null },
		);
		await flushAsync();
		// Route change: the outgoing surface releases, the incoming one acquires,
		// both inside one commit.
		a.release();
		expect(teardown.pending()).toBe(1);
		const b = acquireConversationStream(CONVERSATION_ID, {});
		expect(teardown.pending()).toBe(0);

		teardown.run();
		expect(dials).toBe(1);
		expect(realtimeSubscriptionCount()).toBe(1);

		b.release();
		teardown.run();
		expect(realtimeSubscriptionCount()).toBe(0);
	});
});

describe("generation stamping", () => {
	it("bumps the generation when the connection drops, and only then", async () => {
		const first = mockServer();
		const second = mockServer();
		const servers = [first, second];
		const connect = async () => {
			const server = servers.shift();
			if (!server) throw new Error("no more servers");
			return server.root;
		};
		const timers = fakeTimers();
		const stamps: number[] = [];
		acquireConversationStream(
			CONVERSATION_ID,
			{ onFrame: (_frame, envelope) => stamps.push(envelope.generation) },
			{
				connect,
				metrics: null,
				setTimeoutFn: timers.setTimeoutFn,
				clearTimeoutFn: timers.clearTimeoutFn,
			},
		);
		await flushAsync();
		first.emit(CONVERSATION_ID, wireFrame(0, event({ id: "evt-1" })));
		first.emit(CONVERSATION_ID, wireFrame(1, event({ id: "evt-2" })));
		expect(stamps).toEqual([1, 1]);

		// The connection dies; the machine reconnects on its own ladder.
		first.breakConnection();
		timers.fireNext();
		await flushAsync();
		second.emit(CONVERSATION_ID, wireFrame(2, event({ id: "evt-3" })));
		// A NEW generation: everything folded from the dead connection is now
		// invalidatable, and the post-reconnect replay is authoritative.
		expect(stamps).toEqual([1, 1, 2]);
	});
});

describe("aggregate status", () => {
	it("reports the worst status across capabilities and clears when nothing is live", async () => {
		const server = mockServer();
		const timers = fakeTimers();
		const connect = async () => server.root;
		const a = acquireConversationStream(
			CONVERSATION_ID,
			{},
			{ connect, metrics: null },
		);
		expect(getRealtimeStatus().status).toBe("connecting");
		await flushAsync();
		expect(getRealtimeStatus().status).toBe("open");
		expect(getRealtimeStatus().subscriptions).toBe(1);

		const b = acquireConversationStream(
			OTHER_CONVERSATION_ID,
			{},
			{
				connect,
				metrics: null,
				setTimeoutFn: timers.setTimeoutFn,
				clearTimeoutFn: timers.clearTimeoutFn,
			},
		);
		await flushAsync();
		server.breakConnection();
		await flushAsync();
		// One healthy capability must never mask a degraded one.
		expect(getRealtimeStatus().status).toBe("reconnecting");

		a.release();
		b.release();
		teardown.run();
		expect(getRealtimeStatus()).toEqual({
			status: "idle",
			degraded: false,
			subscriptions: 0,
			subscribers: 0,
			sockets: 0,
		});
	});

	it("flips DEGRADED after consecutive failed establishes and clears it on open", async () => {
		const failures = REALTIME_DEGRADED_AFTER_FAILURES;
		const server = mockServer();
		let attempts = 0;
		const connect = async (): Promise<CapnSessionStub> => {
			attempts += 1;
			if (attempts <= failures) throw new Error("upgrade refused");
			return server.root;
		};
		const timers = fakeTimers();
		const lease = acquireConversationStream(
			CONVERSATION_ID,
			{},
			{
				connect,
				metrics: null,
				setTimeoutFn: timers.setTimeoutFn,
				clearTimeoutFn: timers.clearTimeoutFn,
			},
		);
		await flushAsync();
		expect(getRealtimeStatus().degraded).toBe(false);
		// Walk the retry ladder to the threshold.
		for (let attempt = 1; attempt < failures; attempt += 1) {
			timers.fireNext();
			await flushAsync();
		}
		// Live updates are now declared paused — the consumer contract arms
		// polling and renders the chip. The machine keeps retrying underneath.
		expect(getRealtimeStatus().degraded).toBe(true);

		timers.fireNext();
		await flushAsync();
		// The next successful open clears the signal.
		expect(getRealtimeStatus().status).toBe("open");
		expect(getRealtimeStatus().degraded).toBe(false);
		lease.release();
		teardown.run();
	});

	it("flips DEGRADED on a stalled pump and holds it until push delivery resumes", async () => {
		// The failure the establish ladder cannot see: the socket is healthy, so
		// nothing ever fails to connect. Only the machine's liveness watchdog
		// knows the live tail died, and the manager has to turn that into the
		// same signal ChatThread already polls on.
		const server = stallableServer();
		const timers = fakeTimers();
		const liveness = fakeTimers();
		let clock = 1_000;
		const lease = acquireConversationStream(
			CONVERSATION_ID,
			{},
			{
				connect: async () => server.root,
				metrics: null,
				setTimeoutFn: timers.setTimeoutFn,
				clearTimeoutFn: timers.clearTimeoutFn,
				setLivenessTimerFn: liveness.setTimeoutFn,
				clearLivenessTimerFn: liveness.clearTimeoutFn,
				nowFn: () => clock,
			},
		);
		await flushAsync();
		expect(getRealtimeStatus().status).toBe("open");
		expect(getRealtimeStatus().degraded).toBe(false);

		// A durable write the dead pump never pushes.
		server.writeDurable(wireFrame(0, event({ id: "evt-missed" })));
		clock += CAPN_LIVENESS_IDLE_MS + 1;
		liveness.fireNext();
		await flushAsync();

		expect(getRealtimeStatus().degraded).toBe(true);
		expect(server.subscribeCount()).toBe(2); // an actual reconnect happened
		// Reaching "open" again is NOT proof: the stall happened while this entry
		// was already open, so the signal outlives the reconnect.
		expect(getRealtimeStatus().status).toBe("open");
		expect(getRealtimeStatus().degraded).toBe(true);

		// A pushed frame is the evidence that answers the question.
		server.push(wireFrame(1, event({ id: "evt-live" })));
		expect(getRealtimeStatus().degraded).toBe(false);

		lease.release();
		teardown.run();
	});

	it("exposes a useSyncExternalStore-shaped subscribe for the shell indicator", async () => {
		const server = mockServer();
		const connect = async () => server.root;
		let notified = false;
		const unsubscribe = subscribeRealtimeStatus(() => {
			notified = true;
		});
		const lease = acquireConversationStream(
			CONVERSATION_ID,
			{},
			{ connect, metrics: null },
		);
		// The snapshot is readable immediately; notification is rAF-batched, so
		// this asserts the contract (subscribe returns an unsubscribe, snapshot
		// moves) and never the frame timing.
		expect(getRealtimeStatus().status).toBe("connecting");
		unsubscribe();
		expect(notified).toBe(false);
		lease.release();
		teardown.run();
		await flushAsync();
	});
});
