/**
 * Liveness of the Cap'n Web chat machine.
 *
 * `use-capn-chat.test.ts` covers connect / resume / disposal / outcome
 * classification against a healthy-then-dead SOCKET. This suite covers the
 * failure that socket death never reports: the server's subscription pump ends
 * while the WebSocket stays perfectly up, so `onRpcBroken` and `lease.onBroken`
 * are both silent and the surface renders a transcript that stopped moving.
 * The fake server here can therefore do something the
 * other suite's cannot — accept durable writes WITHOUT pushing them.
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
import {
	CAPN_LIVENESS_IDLE_MS,
	createCapnChatMachine,
	isStreamStale,
} from "./capn-chat-machine";
import { resetConversationResumeWatermarks } from "./conversation-stream";

// A machine that settles cleanly PARKS its resume cursor in the tab-wide
// watermark store, keyed by conversation id. Every test here uses the same id,
// so without this the next test's FIRST connect resumes from the previous
// test's log instead of opening cold.
afterEach(() => {
	resetConversationResumeWatermarks();
});

const CONVERSATION_ID = "home:main";
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_ID_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function delta(offset: number, runId = RUN_ID): RuntimeStreamEvent {
	return {
		id: `${runId}:answer-delta:${offset}`,
		kind: "message.delta",
		conversationId: CONVERSATION_ID,
		runId,
		createdAt: "2026-08-25T10:00:00.000Z",
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
 * `RUN_EVENT_STREAM_PAGE` from `apps/api/.../run-reads-streams.ts`, mirrored
 * because a client test cannot import the API worker. The value matters: the
 * server SLICES to one page and reports `nextOffset = start + slicedRows`, so a
 * double that serves the whole log can never reproduce a paginated probe — the
 * gap that let a watchdog which was inert past 200 events ship green.
 */
const RUN_EVENT_STREAM_PAGE = 200;

/**
 * A `/capn` double whose DURABLE log and whose PUSH tail are separate things.
 * `writeDurable` is what a healthy kernel would push and a dead pump would not,
 * which is the whole condition under test.
 */
function fakeServer() {
	const log: CapnEventFrame[] = [];
	const snapshotCalls: Array<CapnStreamCursor | null> = [];
	const subscribeCalls: Array<CapnStreamCursor | null> = [];
	const disposed: string[] = [];
	const closedRuns = new Set<string>();
	let subscriber: CapnSubscriber | null = null;
	let snapshotError: Error | null = null;

	const snapshotFor = (
		cursor: CapnStreamCursor | null,
	): CapnConversationSnapshot => {
		// No cursor means "the current run", which `nextRunId(conv, null)`
		// resolves to the newest one.
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
		// Exactly the server's shape: one page, and a nextOffset that is the
		// PAGE's end rather than the run's.
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
				closed: closedRuns.has(runId),
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
			return {
				[Symbol.dispose]: () => {
					disposed.push("subscription");
				},
			};
		},
		enqueue: vi.fn() as unknown as CapnConversationStub["enqueue"],
		cancel: vi.fn() as unknown as CapnConversationStub["cancel"],
		respondApproval:
			vi.fn() as unknown as CapnConversationStub["respondApproval"],
		[Symbol.dispose]: () => {
			disposed.push("conversation");
		},
	};

	const root: CapnSessionStub = {
		ping: async () => {},
		// The stub is usable before it resolves, like capnweb's RpcPromise.
		openConversation: () =>
			Object.assign(Promise.resolve(conversation), conversation),
		onRpcBroken: () => {},
		[Symbol.dispose]: () => {
			disposed.push("root");
		},
	};

	return {
		log,
		snapshotCalls,
		subscribeCalls,
		disposed,
		connect: async (): Promise<CapnSessionStub> => root,
		/** A durable write the live tail also delivers — a healthy pump. */
		push: (wireFrame: CapnEventFrame) => {
			log.push(wireFrame);
			void subscriber?.(wireFrame);
		},
		/** A durable write NOTHING delivers — the pump is dead. */
		writeDurable: (wireFrame: CapnEventFrame) => {
			log.push(wireFrame);
		},
		failSnapshots: (error: Error | null) => {
			snapshotError = error;
		},
		/** A terminal event landed: this run's stream is closed. */
		closeRun: (runId: string) => {
			closedRuns.add(runId);
		},
	};
}

function timerQueue() {
	const scheduled: Array<{ callback: () => void; ms: number }> = [];
	return {
		scheduled,
		set: (callback: () => void, ms: number): unknown => {
			scheduled.push({ callback, ms });
			return scheduled.length - 1;
		},
		clear: (): void => {},
		fire: () => {
			scheduled.shift()?.callback();
		},
	};
}

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Harness = ReturnType<typeof mountMachine>;

function mountMachine(server: ReturnType<typeof fakeServer>) {
	const backoff = timerQueue();
	const liveness = timerQueue();
	const statuses: string[] = [];
	const applied: string[] = [];
	const replays: Array<{ streamKey: string; events: number }> = [];
	let stalls = 0;
	let clock = 1_000;
	const machine = createCapnChatMachine({
		conversationId: CONVERSATION_ID,
		connect: server.connect,
		onFrame: (streamFrame) => applied.push(streamFrame.eventId),
		onStatus: (status) => statuses.push(status),
		recordSnapshotReplay: (streamKey, events) =>
			replays.push({ streamKey, events }),
		recordStreamStall: () => {
			stalls += 1;
		},
		setTimeoutFn: backoff.set,
		clearTimeoutFn: backoff.clear,
		setLivenessTimerFn: liveness.set,
		clearLivenessTimerFn: liveness.clear,
		nowFn: () => clock,
		randomFn: () => 0.5,
	});
	return {
		machine,
		backoff,
		liveness,
		statuses,
		applied,
		replays,
		getStalls: () => stalls,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

/** Idle past the watchdog window, then let the armed probe run. */
async function idleOut(harness: Harness): Promise<void> {
	harness.advance(CAPN_LIVENESS_IDLE_MS + 1);
	harness.liveness.fire();
	await flushAsync();
}

// ---------------------------------------------------------------------------
// isStreamStale (pure verdict)
// ---------------------------------------------------------------------------

describe("isStreamStale", () => {
	const probe = (
		runId: string | null,
		events: CapnEventFrame[],
		offset: number,
	): CapnConversationSnapshot => ({
		conversationId: CONVERSATION_ID,
		runId,
		events,
		cursor: runId === null ? null : { runId, offset },
		stream:
			runId === null
				? null
				: { streamId: "s", offset: 0, nextOffset: offset, closed: false },
	});

	it("is never stale when the conversation has no run at all", () => {
		expect(isStreamStale(null, probe(null, [], 0))).toBe(false);
	});

	it("is stale when our own run has advanced past the cursor", () => {
		expect(
			isStreamStale({ runId: RUN_ID, offset: 2 }, probe(RUN_ID, [frame(2)], 3)),
		).toBe(true);
	});

	it("is HEALTHY when our own run has not advanced, however many events it holds", () => {
		// The idle case an emptiness test gets backwards: a finished run replays
		// its whole history to a cursor-less probe and is still fully read.
		expect(
			isStreamStale(
				{ runId: RUN_ID, offset: 3 },
				probe(RUN_ID, [frame(0), frame(1), frame(2)], 3),
			),
		).toBe(false);
	});

	it("is stale on a different run that has already produced events", () => {
		expect(
			isStreamStale(
				{ runId: RUN_ID, offset: 3 },
				probe(RUN_ID_2, [frame(0, RUN_ID_2)], 1),
			),
		).toBe(true);
	});

	it("is HEALTHY on a different run that has produced nothing yet", () => {
		// A live pump legitimately rolls onto a fresh run before it owes anything.
		expect(
			isStreamStale({ runId: RUN_ID, offset: 3 }, probe(RUN_ID_2, [], 0)),
		).toBe(false);
	});

	it("is stale when we hold no cursor and the server already has events", () => {
		expect(isStreamStale(null, probe(RUN_ID, [frame(0)], 1))).toBe(true);
	});

	it("reads a CURSOR-ANCHORED probe past the page cap as stale", () => {
		// The anchored shape: a client at 250 on a 300-event run gets rows
		// 250..299 back and a cursor of 300 — the run's real end. Only an
		// anchored probe can say this; a probe from 0 stops at the page cap.
		expect(
			isStreamStale(
				{ runId: RUN_ID, offset: 250 },
				probe(RUN_ID, [frame(250)], 300),
			),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// A dead pump behind a healthy socket
// ---------------------------------------------------------------------------

describe("liveness watchdog", () => {
	it("reconnects when the server pump dies while the socket stays healthy", async () => {
		// THE regression. Nothing breaks the socket here: no onRpcBroken fires,
		// no establish() throws. Before the watchdog the machine sat at "open"
		// forever and the surface silently stopped updating.
		const server = fakeServer();
		server.log.push(frame(0));
		const harness = mountMachine(server);
		await flushAsync();

		expect(harness.statuses).toEqual(["connecting", "open"]);
		expect(server.subscribeCalls).toHaveLength(1);
		expect(harness.applied).toEqual([`${CONVERSATION_ID}:${RUN_ID}:0`]);

		// The kernel keeps writing; the pump is gone, so nothing is pushed.
		server.writeDurable(frame(1));
		server.writeDurable(frame(2));

		await idleOut(harness);

		expect(harness.getStalls()).toBe(1);
		expect(harness.statuses).toEqual([
			"connecting",
			"open",
			"reconnecting",
			"open",
		]);
		// A REAL reconnect: a second subscription, resumed from the cursor the
		// probe's frames advanced to — not a duplicate of the first.
		expect(server.subscribeCalls).toHaveLength(2);
		expect(server.subscribeCalls[1]).toEqual({ runId: RUN_ID, offset: 3 });
		expect(server.disposed).toContain("subscription");
		// The frames the dead pump owed us were delivered exactly once.
		expect(harness.applied).toEqual([
			`${CONVERSATION_ID}:${RUN_ID}:0`,
			`${CONVERSATION_ID}:${RUN_ID}:1`,
			`${CONVERSATION_ID}:${RUN_ID}:2`,
		]);
		harness.machine.close();
	});

	it("reconnects on a run PAST the snapshot page cap", async () => {
		// The defect this suite could not see while its double served the whole
		// log: `snapshot(null)` is paginated, so on any run past
		// RUN_EVENT_STREAM_PAGE it reports offset 200 forever. A client at 250
		// then reads 200 > 250 as "healthy" and the watchdog is INERT for
		// exactly the long streaming runs a dead pump ruins most visibly.
		const server = fakeServer();
		for (let offset = 0; offset < RUN_EVENT_STREAM_PAGE; offset += 1) {
			server.log.push(frame(offset));
		}
		const harness = mountMachine(server);
		await flushAsync();
		// The first page is all the connect snapshot can serve.
		expect(harness.applied).toHaveLength(RUN_EVENT_STREAM_PAGE);

		// A healthy pump carries the client to 250 …
		for (let offset = RUN_EVENT_STREAM_PAGE; offset < 250; offset += 1) {
			server.push(frame(offset));
		}
		expect(harness.machine.getCursor()).toEqual({ runId: RUN_ID, offset: 250 });
		// … and then dies: the kernel writes 250..299 and pushes nothing.
		for (let offset = 250; offset < 300; offset += 1) {
			server.writeDurable(frame(offset));
		}

		await idleOut(harness);

		expect(harness.getStalls()).toBe(1);
		expect(server.subscribeCalls).toHaveLength(2);
		expect(server.subscribeCalls[1]).toEqual({ runId: RUN_ID, offset: 300 });
		expect(harness.applied).toHaveLength(300);
		// The probe asked from the client's own position, so it cost the 50
		// events actually owed rather than re-serving a 200-row page.
		expect(server.snapshotCalls.at(-2)).toEqual({ runId: RUN_ID, offset: 250 });
		harness.machine.close();
	});

	it("reconnects when the pump silently rolled onto a NEW run", async () => {
		// The blind spot of an anchored probe: `snapshot(cursor)` honors the
		// cursor's run even when a newer one exists, so a drained CLOSED run
		// costs one `snapshot(null)` to learn which run is current.
		const server = fakeServer();
		server.log.push(frame(0));
		const harness = mountMachine(server);
		await flushAsync();

		server.closeRun(RUN_ID);
		server.writeDurable(frame(0, RUN_ID_2));

		await idleOut(harness);

		expect(harness.getStalls()).toBe(1);
		expect(server.subscribeCalls).toHaveLength(2);
		expect(server.subscribeCalls[1]).toEqual({ runId: RUN_ID_2, offset: 1 });
		expect(harness.applied).toEqual([
			`${CONVERSATION_ID}:${RUN_ID}:0`,
			`${CONVERSATION_ID}:${RUN_ID_2}:0`,
		]);
		harness.machine.close();
	});

	it("leaves a CLOSED, fully-read long run alone", async () => {
		// The rollover probe is unanchored, so it stops at the page cap. It must
		// still not read a finished 250-event run as stale just because its page
		// ends at 200.
		const server = fakeServer();
		for (let offset = 0; offset < RUN_EVENT_STREAM_PAGE; offset += 1) {
			server.log.push(frame(offset));
		}
		const harness = mountMachine(server);
		await flushAsync();
		for (let offset = RUN_EVENT_STREAM_PAGE; offset < 250; offset += 1) {
			server.push(frame(offset));
		}
		server.closeRun(RUN_ID);

		await idleOut(harness);

		expect(harness.getStalls()).toBe(0);
		expect(server.subscribeCalls).toHaveLength(1);
		harness.machine.close();
	});

	it("reconnects with no backoff delay: the server is answering, not refusing", async () => {
		const server = fakeServer();
		server.log.push(frame(0));
		const harness = mountMachine(server);
		await flushAsync();
		server.writeDurable(frame(1));
		await idleOut(harness);

		// Backoff protects a server that will not talk to us. This one just
		// served a snapshot, so nothing is scheduled on the backoff ladder.
		expect(harness.backoff.scheduled).toEqual([]);
		harness.machine.close();
	});

	it("leaves an idle-but-alive conversation alone", async () => {
		// The false positive that would make the watchdog worse than the bug:
		// every quiet conversation re-dialing once a minute forever.
		const server = fakeServer();
		server.log.push(frame(0));
		const harness = mountMachine(server);
		await flushAsync();

		await idleOut(harness);
		await idleOut(harness);

		expect(harness.getStalls()).toBe(0);
		expect(server.subscribeCalls).toHaveLength(1);
		expect(harness.statuses).toEqual(["connecting", "open"]);
		// It probed from its OWN cursor — the only anchor that can prove a run
		// drained — and re-armed after each clean verdict.
		expect(server.snapshotCalls).toEqual([
			null,
			{ runId: RUN_ID, offset: 1 },
			{ runId: RUN_ID, offset: 1 },
		]);
		expect(harness.liveness.scheduled).toHaveLength(1);
		harness.machine.close();
	});

	it("re-arms without probing while frames are still arriving", async () => {
		const server = fakeServer();
		server.log.push(frame(0));
		const harness = mountMachine(server);
		await flushAsync();
		const snapshotsAfterConnect = server.snapshotCalls.length;

		harness.advance(CAPN_LIVENESS_IDLE_MS - 5);
		server.push(frame(1));
		harness.advance(6);
		harness.liveness.fire();
		await flushAsync();

		// The silence window restarted on the delivered frame, so the timer
		// rearmed for the remainder instead of spending a probe.
		expect(server.snapshotCalls).toHaveLength(snapshotsAfterConnect);
		expect(harness.liveness.scheduled).toHaveLength(1);
		expect(harness.liveness.scheduled[0]?.ms).toBe(CAPN_LIVENESS_IDLE_MS - 6);
		harness.machine.close();
	});

	it("treats an unreachable capability as a broken connection, on the backoff ladder", async () => {
		const server = fakeServer();
		server.log.push(frame(0));
		const harness = mountMachine(server);
		await flushAsync();

		server.failSnapshots(new Error("capability gone"));
		await idleOut(harness);

		// Not a stall: the peer is not answering, which is exactly what backoff
		// is for. Jitter band midpoint of the first step.
		expect(harness.getStalls()).toBe(0);
		expect(harness.statuses.at(-1)).toBe("reconnecting");
		expect(harness.backoff.scheduled).toHaveLength(1);
		expect(harness.backoff.scheduled[0]?.ms).toBe(1000);
		harness.machine.close();
	});

	it("stops watching once the machine closes", async () => {
		const server = fakeServer();
		server.log.push(frame(0));
		const harness = mountMachine(server);
		await flushAsync();
		harness.machine.close();

		server.writeDurable(frame(1));
		await idleOut(harness);

		expect(harness.getStalls()).toBe(0);
		expect(server.subscribeCalls).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Replay instrumentation
// ---------------------------------------------------------------------------

describe("replay instrumentation", () => {
	it("counts every snapshot's served size, so a reconnect storm is legible", async () => {
		const server = fakeServer();
		server.log.push(frame(0), frame(1));
		const harness = mountMachine(server);
		await flushAsync();

		// The establish resume: two events replayed on first connect.
		expect(harness.replays).toEqual([
			{ streamKey: `${CONVERSATION_ID}:${RUN_ID}`, events: 2 },
		]);

		server.writeDurable(frame(2));
		await idleOut(harness);

		// The probe serves only what the dead pump owed (one event, from the
		// client's cursor), and the reconnect's own resume adds a third sample.
		expect(harness.replays).toHaveLength(3);
		expect(harness.replays[1]).toEqual({
			streamKey: `${CONVERSATION_ID}:${RUN_ID}`,
			events: 1,
		});
		expect(harness.replays[2]?.events).toBe(0);
		harness.machine.close();
	});
});
