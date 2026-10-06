/**
 * Resume ACROSS MACHINE LIFETIMES.
 *
 * `capn-chat-machine.test.ts` covers one machine surviving a dead pump, and
 * `use-capn-chat.test.ts` covers one machine surviving a dead socket. Neither
 * can see the failure this suite exists for: `realtime-connection.ts` CLOSES
 * machines — deferred teardown on navigation, LRU eviction past the entry cap —
 * and the successor used to start with a null cursor, so the server honestly
 * re-served the current run from offset 0 and every one of those frames was
 * fanned out again as live.
 *
 * The three properties asserted here are the whole contract:
 *   1. a cleanly settled session's watermark resumes the next one,
 *   2. an unsettled or errored session seeds nothing and the next opens cold,
 *   3. nothing is delivered twice across that seam.
 */

import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
	CapnConversationSnapshot,
	CapnConversationStub,
	CapnEventFrame,
	CapnSessionStub,
	CapnStreamCursor,
	CapnSubscriber,
} from "@/capnweb/contract";
import { createCapnChatMachine } from "./capn-chat-machine";
import {
	type ConversationStreamFrame,
	getConversationResumeWatermarks,
	resetConversationResumeWatermarks,
} from "./conversation-stream";

const CONVERSATION_ID = "home:main";
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** `RUN_EVENT_STREAM_PAGE` in `run-reads-streams.ts`; mirrored, see below. */
const RUN_EVENT_STREAM_PAGE = 200;

function delta(offset: number, runId = RUN_ID): RuntimeStreamEvent {
	return {
		id: `${runId}:answer-delta:${offset}`,
		kind: "message.delta",
		conversationId: CONVERSATION_ID,
		runId,
		createdAt: "2026-09-17T10:00:00.000Z",
		sequence: offset,
		delta: `chunk-${offset}`,
		payload: { role: "assistant", channel: "home", content: `chunk-${offset}` },
	};
}

function frame(offset: number, runId = RUN_ID): CapnEventFrame {
	return {
		conversationId: CONVERSATION_ID,
		runId,
		offset,
		nextOffset: offset + 1,
		event: delta(offset, runId),
	};
}

/**
 * A `/capn` double that pages exactly like `SessionRoot.snapshot`: the cursor's
 * own run is honored, a missing cursor means the current run from offset 0, and
 * `nextOffset` is the PAGE's end. Paging matters here — the point of the
 * watermark is that a successor stops paying for rows it already has.
 */
function fakeServer() {
	const log: CapnEventFrame[] = [];
	const snapshotCalls: Array<CapnStreamCursor | null> = [];
	const subscribeCalls: Array<CapnStreamCursor | null> = [];
	let subscriber: CapnSubscriber | null = null;
	let snapshotError: Error | null = null;
	const brokenListeners: Array<(error: unknown) => void> = [];

	const snapshotFor = (
		cursor: CapnStreamCursor | null,
	): CapnConversationSnapshot => {
		const runId = cursor?.runId ?? log.at(-1)?.runId ?? null;
		if (runId === null) {
			return {
				conversationId: CONVERSATION_ID,
				runId: null,
				events: [],
				cursor: null,
				stream: null,
			};
		}
		const from = cursor?.runId === runId ? cursor.offset : 0;
		const rows = log.filter(
			(entry) => entry.runId === runId && entry.offset >= from,
		);
		const events = rows.slice(0, RUN_EVENT_STREAM_PAGE);
		const nextOffset = from + events.length;
		return {
			conversationId: CONVERSATION_ID,
			runId,
			events,
			cursor: { runId, offset: nextOffset },
			stream: {
				streamId: `stream:${runId}`,
				offset: from,
				nextOffset,
				closed: false,
			},
		};
	};

	const conversation: CapnConversationStub = {
		snapshot: async (cursor) => {
			snapshotCalls.push(cursor ?? null);
			if (snapshotError !== null) throw snapshotError;
			return snapshotFor(cursor ?? null);
		},
		subscribe: async (callback, cursor) => {
			subscribeCalls.push(cursor ?? null);
			subscriber = callback;
			return { [Symbol.dispose]: () => {} };
		},
		enqueue: vi.fn() as unknown as CapnConversationStub["enqueue"],
		cancel: vi.fn() as unknown as CapnConversationStub["cancel"],
		respondApproval:
			vi.fn() as unknown as CapnConversationStub["respondApproval"],
		[Symbol.dispose]: () => {},
	};

	const root: CapnSessionStub = {
		ping: async () => {},
		openConversation: () =>
			Object.assign(Promise.resolve(conversation), conversation),
		onRpcBroken: (callback) => brokenListeners.push(callback),
		[Symbol.dispose]: () => {},
	};

	return {
		log,
		snapshotCalls,
		subscribeCalls,
		connect: async (): Promise<CapnSessionStub> => root,
		/** Durable write the live tail also pushes — a healthy pump. */
		push: (wireFrame: CapnEventFrame) => {
			log.push(wireFrame);
			void subscriber?.(wireFrame);
		},
		/** Durable write nothing pushes; a later snapshot still serves it. */
		writeDurable: (wireFrame: CapnEventFrame) => {
			log.push(wireFrame);
		},
		failSnapshots: (error: Error | null) => {
			snapshotError = error;
		},
		/** Socket death, exactly as capnweb reports it. */
		breakSocket: () => {
			const listeners = [...brokenListeners];
			brokenListeners.length = 0;
			for (const listener of listeners) listener(new Error("socket closed"));
		},
	};
}

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function timerQueue() {
	const scheduled: Array<{ callback: () => void; ms: number }> = [];
	return {
		scheduled,
		set: (callback: () => void, ms: number): unknown => {
			scheduled.push({ callback, ms });
			return scheduled.length - 1;
		},
		clear: (): void => {},
	};
}

/** One machine, with every timer under the test's control. */
function mountMachine(
	server: ReturnType<typeof fakeServer>,
	overrides: { onFrame?: (frame: ConversationStreamFrame) => void } = {},
) {
	const backoff = timerQueue();
	const liveness = timerQueue();
	const delivered: string[] = [];
	const statuses: string[] = [];
	const cursorResets: number[] = [];
	const machine = createCapnChatMachine({
		conversationId: CONVERSATION_ID,
		connect: server.connect,
		onFrame: (streamFrame) => {
			delivered.push(streamFrame.eventId);
			overrides.onFrame?.(streamFrame);
		},
		onStatus: (status) => statuses.push(status),
		recordCursorReset: () => cursorResets.push(1),
		setTimeoutFn: backoff.set,
		clearTimeoutFn: backoff.clear,
		setLivenessTimerFn: liveness.set,
		clearLivenessTimerFn: liveness.clear,
		nowFn: () => 0,
		randomFn: () => 0.5,
	});
	return { machine, delivered, statuses, cursorResets, backoff };
}

afterEach(() => {
	resetConversationResumeWatermarks();
});

describe("conversation resume watermark", () => {
	it("resumes from the parked watermark after a cleanly settled session", async () => {
		const server = fakeServer();
		server.writeDurable(frame(0));
		server.writeDurable(frame(1));

		const first = mountMachine(server);
		await flushAsync();
		expect(first.statuses).toContain("open");
		expect(server.snapshotCalls).toEqual([null]);
		expect(first.delivered).toEqual([
			`${CONVERSATION_ID}:${RUN_ID}:0`,
			`${CONVERSATION_ID}:${RUN_ID}:1`,
		]);
		// Navigation teardown / LRU eviction: the machine and its cursor go.
		first.machine.close();
		expect(getConversationResumeWatermarks().peek(CONVERSATION_ID)).toEqual({
			runId: RUN_ID,
			offset: 2,
		});

		// The conversation kept moving while nothing was connected.
		server.writeDurable(frame(2));

		const second = mountMachine(server);
		await flushAsync();
		// The successor asked for the GAP, not the run.
		expect(server.snapshotCalls).toEqual([null, { runId: RUN_ID, offset: 2 }]);
		expect(server.subscribeCalls.at(-1)).toEqual({ runId: RUN_ID, offset: 3 });
		expect(second.delivered).toEqual([`${CONVERSATION_ID}:${RUN_ID}:2`]);
		second.machine.close();
	});

	it("delivers nothing twice across the resume seam", async () => {
		const server = fakeServer();
		const first = mountMachine(server);
		await flushAsync();
		server.push(frame(0));
		server.push(frame(1));
		server.push(frame(2));
		await flushAsync();
		first.machine.close();

		server.writeDurable(frame(3));
		const second = mountMachine(server);
		await flushAsync();
		server.push(frame(4));
		await flushAsync();
		second.machine.close();

		// The successor's frame map starts EMPTY, so it cannot dedupe against its
		// predecessor's deliveries — the only thing preventing a re-delivery is
		// that the server was asked to replay from the watermark.
		expect([...first.delivered, ...second.delivered]).toEqual([
			`${CONVERSATION_ID}:${RUN_ID}:0`,
			`${CONVERSATION_ID}:${RUN_ID}:1`,
			`${CONVERSATION_ID}:${RUN_ID}:2`,
			`${CONVERSATION_ID}:${RUN_ID}:3`,
			`${CONVERSATION_ID}:${RUN_ID}:4`,
		]);
	});

	it("opens cold after a session that never established", async () => {
		const server = fakeServer();
		server.writeDurable(frame(0));
		server.failSnapshots(new Error("upstream unavailable"));

		const first = mountMachine(server);
		await flushAsync();
		expect(first.statuses).toContain("reconnecting");
		expect(first.delivered).toEqual([]);
		first.machine.close();
		expect(getConversationResumeWatermarks().peek(CONVERSATION_ID)).toBeNull();

		server.failSnapshots(null);
		const second = mountMachine(server);
		await flushAsync();
		expect(server.snapshotCalls.at(-1)).toBeNull();
		expect(second.delivered).toEqual([`${CONVERSATION_ID}:${RUN_ID}:0`]);
		second.machine.close();
	});

	it("opens cold after a session that settled and then went unclean", async () => {
		const server = fakeServer();
		const first = mountMachine(server);
		await flushAsync();
		server.push(frame(0));
		await flushAsync();
		expect(first.statuses).toContain("open");
		expect(first.machine.getCursor()).toEqual({ runId: RUN_ID, offset: 1 });

		// The socket dies and the entry is torn down before the ladder recovers.
		// The position it reached is real; the session that reached it is not a
		// clean one any more, so it must seed nothing.
		server.breakSocket();
		expect(first.statuses.at(-1)).toBe("reconnecting");
		first.machine.close();
		expect(getConversationResumeWatermarks().peek(CONVERSATION_ID)).toBeNull();

		const second = mountMachine(server);
		await flushAsync();
		expect(server.snapshotCalls.at(-1)).toBeNull();
		second.machine.close();
	});

	it("parks nothing when a frame listener throws", async () => {
		const server = fakeServer();
		server.writeDurable(frame(0));
		const first = mountMachine(server, {
			onFrame: () => {
				throw new Error("projection fold failed");
			},
		});
		await flushAsync();
		// The throw travels out of the snapshot replay loop, so the establish
		// never reaches "open" — and nothing may be parked past a frame no
		// consumer folded.
		expect(first.statuses).not.toContain("open");
		first.machine.close();
		expect(getConversationResumeWatermarks().peek(CONVERSATION_ID)).toBeNull();
	});

	it("drops the parked watermark when the cursor stops resolving", async () => {
		const server = fakeServer();
		server.writeDurable(frame(0));
		const first = mountMachine(server);
		await flushAsync();
		first.machine.close();
		expect(getConversationResumeWatermarks().peek(CONVERSATION_ID)).toEqual({
			runId: RUN_ID,
			offset: 1,
		});

		// The parked run is gone server-side: every resume from it now rejects.
		server.failSnapshots(new Error("run not found"));
		const second = mountMachine(server);
		await flushAsync();
		expect(server.snapshotCalls.at(-1)).toEqual({ runId: RUN_ID, offset: 1 });
		// First failure keeps the cursor (the common cause is transport), the
		// second abandons it — and the store must forget it too, or the next
		// machine reseeds the same dead position.
		second.backoff.scheduled.shift()?.callback();
		await flushAsync();
		expect(second.cursorResets.length).toBeGreaterThan(0);
		expect(getConversationResumeWatermarks().peek(CONVERSATION_ID)).toBeNull();
		second.machine.close();
		expect(getConversationResumeWatermarks().peek(CONVERSATION_ID)).toBeNull();
	});

	it("honours an explicitly disabled store (cold open every time)", async () => {
		const server = fakeServer();
		server.writeDurable(frame(0));
		const machine = createCapnChatMachine({
			conversationId: CONVERSATION_ID,
			connect: server.connect,
			resumeWatermarks: null,
			onFrame: () => {},
			setTimeoutFn: () => 0,
			clearTimeoutFn: () => {},
			setLivenessTimerFn: () => 0,
			clearLivenessTimerFn: () => {},
		});
		await flushAsync();
		machine.close();
		expect(getConversationResumeWatermarks().peek(CONVERSATION_ID)).toBeNull();
	});
});
