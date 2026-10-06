import type { EnqueueHomeMessageOutput } from "@tedix/api-contract/schemas/kernel-runtime";
import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
	CapnConversationSnapshot,
	CapnConversationStub,
	CapnEventFrame,
	CapnSessionStub,
	CapnStreamCursor,
	CapnSubscriber,
} from "@/capnweb/contract";
import { createTransportMetrics } from "./capn-measurement";
import {
	CapnNotConnectedError,
	type CapnOutcomeUnknownError,
	capnSocketUrl,
	createCapnChatMachine,
	isOutcomeUnknown,
} from "./capn-chat-machine";
import { resetConversationResumeWatermarks } from "./conversation-stream";
import {
	getRealtimeStatus,
	resetRealtimeConnections,
} from "./realtime-connection";
import {
	canUseBoundConversationCapability,
	type ChatTransportResult,
	type UseCapnChatResult,
	useCapnStreamedOverlays,
	useChatTransport,
} from "./use-capn-chat";

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_ID_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONVERSATION_ID = "home:main";

const uploadApi = vi.hoisted(() => vi.fn());
/** Typed like the real lifecycle sink so `mock.calls` keeps the payload shape. */
type LifecycleEvent = {
	event: string;
	milestone: string;
	surface: string;
	runId?: string;
	conversationId: string;
};
const trackLifecycleApi = vi.hoisted(() =>
	vi.fn((_input: { events: LifecycleEvent[] }) => Promise.resolve()),
);
vi.mock("@/lib/api", () => ({
	osApi: {
		kernelRuntime: {
			uploadAttachment: uploadApi,
			cancelRun: vi.fn(),
			respondApproval: vi.fn(),
		},
		analytics: { trackWidgetLifecycle: trackLifecycleApi },
	},
	osChatMutationApi: {
		kernelRuntime: { enqueueMessage: vi.fn(), respondApproval: vi.fn() },
	},
}));

/**
 * A double for a capnweb capability return, faithful in the two ways that
 * decide whether the pipelined call site is correct:
 *
 *  1. It is usable as a stub BEFORE it resolves, so `snapshot()` can be called
 *     on it without awaiting — the behavior the machine now depends on.
 *  2. `typeof` it is `"function"`, because capnweb's `RpcPromise` is a `Proxy`
 *     over a function. An `"object"`-only stub guard skips it, which is exactly
 *     the leak this double exists to catch. Do not "simplify" it to a plain
 *     `Promise.resolve(value)`: that passes an object guard and proves nothing.
 */
function pipelinedStub<T extends object>(value: T): Promise<T> & T {
	const settled = Promise.resolve(value);
	return new Proxy((() => {}) as unknown as Promise<T> & T, {
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
			const inner = (value as Record<PropertyKey, unknown>)[property];
			return typeof inner === "function" ? inner.bind(value) : inner;
		},
	});
}

function delta(
	sequence: number,
	chunk: string,
	runId = RUN_ID,
): RuntimeStreamEvent {
	return {
		id: `${runId}:answer-delta:${sequence}`,
		kind: "message.delta",
		conversationId: CONVERSATION_ID,
		runId,
		createdAt: "2026-08-15T10:00:00.000Z",
		sequence,
		delta: chunk,
		payload: { role: "assistant", channel: "home", content: chunk },
	};
}

function phaseEvent(
	sequence: number,
	value: string,
	runId = RUN_ID,
): RuntimeStreamEvent {
	return {
		id: `${runId}:phase:${sequence}`,
		kind: "message.phase",
		conversationId: CONVERSATION_ID,
		runId,
		createdAt: "2026-08-15T10:00:00.000Z",
		sequence,
		payload: { phase: value },
		phase: value,
	} as RuntimeStreamEvent;
}

/** A wire frame in the SHARED shape — the fake cannot invent one anymore. */
function frame(runId: string, offset: number, event: unknown): CapnEventFrame {
	return {
		conversationId: CONVERSATION_ID,
		runId,
		offset,
		nextOffset: offset + 1,
		event: event as RuntimeStreamEvent,
	};
}

function enqueueOutput(idempotencyKey: string): EnqueueHomeMessageOutput {
	return {
		idempotencyKey,
		conversationId: CONVERSATION_ID,
		status: "queued",
		run: {
			id: idempotencyKey,
			organizationId: "33333333-3333-4333-8333-333333333333",
			conversationId: CONVERSATION_ID,
			status: "queued",
			createdAt: "2026-08-15T10:00:00.000Z",
		} as EnqueueHomeMessageOutput["run"],
	};
}

/**
 * One fake `/capn` server. It is typed as `CapnConversationStub` /
 * `CapnSessionStub` — the SHARED contract's client projection — so it cannot
 * drift from what the Worker actually returns. The real-socket proof lives in
 * `src/capnweb/capn-roundtrip.workerd.test.ts`; this suite exists for the
 * client-side state machine (backoff, disposal order, outcome classification)
 * that a real socket cannot drive deterministically.
 */
function mockServer(log: CapnEventFrame[] = []) {
	const disposed: string[] = [];
	const snapshotCalls: Array<CapnStreamCursor | null> = [];
	const subscribeCalls: Array<CapnStreamCursor | null> = [];
	const brokenCallbacks: Array<(error: unknown) => void> = [];
	let subscriber: CapnSubscriber | null = null;

	const snapshotFor = (
		cursor: CapnStreamCursor | null,
	): CapnConversationSnapshot => {
		const runId = cursor?.runId ?? log[0]?.runId ?? null;
		const from = cursor?.offset ?? 0;
		const events =
			runId === null
				? []
				: log.filter((entry) => entry.runId === runId && entry.offset >= from);
		const nextOffset = events.at(-1)?.nextOffset ?? from;
		return {
			conversationId: CONVERSATION_ID,
			runId,
			events,
			cursor: runId === null ? null : { runId, offset: nextOffset },
			stream:
				runId === null
					? null
					: {
							streamId: "stream-1",
							offset: from,
							nextOffset,
							closed: false,
						},
		};
	};

	const conversation: CapnConversationStub = {
		snapshot: async (cursor) => {
			snapshotCalls.push(cursor ?? null);
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
		enqueue: vi.fn(
			async (_input: { content: string }, idempotencyKey: string) =>
				enqueueOutput(idempotencyKey),
		),
		cancel: vi.fn(async (runId: string) => ({
			run: { id: runId },
		})) as unknown as CapnConversationStub["cancel"],
		respondApproval: vi.fn(async (params: { runId: string }) => ({
			runId: params.runId,
			resolved: true,
		})),
		[Symbol.dispose]: () => {
			disposed.push("conversation");
		},
	};

	const root: CapnSessionStub = {
		ping: async () => {},
		openConversation: () => pipelinedStub(conversation),
		onRpcBroken: (callback) => {
			brokenCallbacks.push(callback);
		},
		[Symbol.dispose]: () => {
			disposed.push("root");
		},
	};

	return {
		root,
		conversation,
		disposed,
		snapshotCalls,
		subscribeCalls,
		emit: (wireFrame: CapnEventFrame) => subscriber?.(wireFrame),
		breakConnection: (error: unknown = new Error("socket died")) => {
			for (const callback of brokenCallbacks) callback(error);
		},
	};
}

/** Sequential connect factory: each (re)connect consumes the next server. */
function connectSequence(...servers: Array<ReturnType<typeof mockServer>>) {
	let index = 0;
	return async (): Promise<CapnSessionStub> => {
		const server = servers[index];
		index += 1;
		if (server === undefined) throw new Error("no more servers");
		return server.root;
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

// ---------------------------------------------------------------------------
// capnSocketUrl (pure)
// ---------------------------------------------------------------------------

describe("capnSocketUrl", () => {
	it("maps the page origin onto the same-origin /capn WebSocket", () => {
		expect(capnSocketUrl("https://acme.os.tedix.dev")).toBe(
			"wss://acme.os.tedix.dev/capn",
		);
		expect(capnSocketUrl("http://localhost:3010/")).toBe(
			"ws://localhost:3010/capn",
		);
	});
});

// ---------------------------------------------------------------------------
// createCapnChatMachine — connect / snapshot / subscribe
// ---------------------------------------------------------------------------

describe("createCapnChatMachine connection", () => {
	it("connects, snapshots with NO cursor, delivers in order, subscribes at the cursor the server issued", async () => {
		const server = mockServer([
			frame(RUN_ID, 0, delta(0, "Hel")),
			frame(RUN_ID, 1, delta(1, "lo")),
		]);
		const statuses: string[] = [];
		const applied: Array<{ offset: number; eventId: string }> = [];
		const machine = createCapnChatMachine({
			conversationId: CONVERSATION_ID,
			connect: connectSequence(server),
			onFrame: (streamFrame) =>
				applied.push({
					offset: streamFrame.offset,
					eventId: streamFrame.eventId,
				}),
			onStatus: (status) => statuses.push(status),
		});
		await flushAsync();
		expect(statuses).toEqual(["connecting", "open"]);
		// A first connection sends NO cursor. The pilot sent -1, which the
		// server's nonnegative() offset shape rejected on every attempt.
		expect(server.snapshotCalls).toEqual([null]);
		expect(server.subscribeCalls).toEqual([{ runId: RUN_ID, offset: 2 }]);
		expect(applied).toEqual([
			{ offset: 0, eventId: `home:main:${RUN_ID}:0` },
			{ offset: 1, eventId: `home:main:${RUN_ID}:1` },
		]);
		expect(machine.getCursor()).toEqual({ runId: RUN_ID, offset: 2 });
		machine.close();
	});

	it("delivers live subscriber frames once and drops duplicate offsets", async () => {
		const server = mockServer([frame(RUN_ID, 0, delta(0, "a"))]);
		const applied: number[] = [];
		const machine = createCapnChatMachine({
			conversationId: CONVERSATION_ID,
			connect: connectSequence(server),
			onFrame: (streamFrame) => applied.push(streamFrame.offset),
		});
		await flushAsync();
		server.emit(frame(RUN_ID, 1, delta(1, "b")));
		server.emit(frame(RUN_ID, 1, delta(1, "b"))); // wire duplicate
		server.emit(frame(RUN_ID, 0, delta(0, "a"))); // replay of a delivered offset
		expect(applied).toEqual([0, 1]);
		machine.close();
	});

	it("keeps a new run's low offsets from colliding with the previous run's", async () => {
		// Run-local offsets restart at 0. The pilot keyed the frame store by the
		// bare offset, so run 2's offset 0 was dropped as a duplicate of run 1's
		// and its monotonic high-water could never resume the new run either.
		const server = mockServer([frame(RUN_ID, 0, delta(0, "a"))]);
		const applied: string[] = [];
		const machine = createCapnChatMachine({
			conversationId: CONVERSATION_ID,
			connect: connectSequence(server),
			onFrame: (streamFrame) => applied.push(streamFrame.eventId),
		});
		await flushAsync();
		server.emit(frame(RUN_ID_2, 0, delta(0, "b", RUN_ID_2)));
		server.emit(frame(RUN_ID_2, 1, delta(1, "c", RUN_ID_2)));
		expect(applied).toEqual([
			`home:main:${RUN_ID}:0`,
			`home:main:${RUN_ID_2}:0`,
			`home:main:${RUN_ID_2}:1`,
		]);
		// The cursor follows the NEW run, not the highest number ever seen.
		expect(machine.getCursor()).toEqual({ runId: RUN_ID_2, offset: 2 });
		machine.close();
	});

	it("skips schema-invalid frames but still advances the resume cursor", async () => {
		const server = mockServer([frame(RUN_ID, 0, { bogus: true })]);
		const applied: number[] = [];
		const machine = createCapnChatMachine({
			conversationId: CONVERSATION_ID,
			connect: connectSequence(server),
			onFrame: (streamFrame) => applied.push(streamFrame.offset),
		});
		await flushAsync();
		expect(applied).toEqual([]);
		// the undecodable row is never re-fetched on a later resume
		expect(machine.getCursor()).toEqual({ runId: RUN_ID, offset: 1 });
		machine.close();
	});
});

// ---------------------------------------------------------------------------
// Reconnect / resume
// ---------------------------------------------------------------------------

describe("createCapnChatMachine reconnect", () => {
	it("reacquires capabilities, resumes the exact offset, and never re-delivers", async () => {
		const first = mockServer([
			frame(RUN_ID, 0, delta(0, "a")),
			frame(RUN_ID, 1, delta(1, "b")),
			frame(RUN_ID, 2, delta(2, "c")),
		]);
		// The second server's log overlaps (1..2) and extends (3..4).
		const second = mockServer([
			frame(RUN_ID, 1, delta(1, "b")),
			frame(RUN_ID, 2, delta(2, "c")),
			frame(RUN_ID, 3, delta(3, "d")),
			frame(RUN_ID, 4, delta(4, "e")),
		]);
		const timers = fakeTimers();
		const statuses: string[] = [];
		const applied: number[] = [];
		const metrics = createTransportMetrics();
		const machine = createCapnChatMachine({
			conversationId: CONVERSATION_ID,
			connect: connectSequence(first, second),
			onFrame: (streamFrame) => applied.push(streamFrame.offset),
			onStatus: (status) => statuses.push(status),
			recordWireOffset: (streamKey, offset) =>
				metrics.recordWireOffset("capn", streamKey, offset),
			setTimeoutFn: timers.setTimeoutFn,
			clearTimeoutFn: timers.clearTimeoutFn,
			// Mid-band roll: jitter is seeded, so the step stays an EXACT
			// assertion instead of a band that would pass on a broken ladder.
			randomFn: () => 0.5,
		});
		await flushAsync();
		expect(applied).toEqual([0, 1, 2]);

		first.breakConnection();
		expect(statuses.at(-1)).toBe("reconnecting");
		// the dead session's stubs were disposed immediately
		expect(first.disposed).toEqual(["subscription", "conversation", "root"]);
		// First backoff step at the middle of its jitter band
		// (`nextBackoffDelayMs`): the nominal 1s is rolled across 0.85–1.15 so a
		// fleet of tabs that lost the socket to one deploy cannot re-dial in
		// lockstep. The band's arithmetic is asserted in
		// `conversation-stream.test.ts`.
		expect(timers.scheduled[0]?.ms).toBe(1000);

		timers.fireNext();
		await flushAsync();
		// EXACT resume: the cursor the server issued, not one the client invented
		expect(second.snapshotCalls).toEqual([{ runId: RUN_ID, offset: 3 }]);
		expect(second.subscribeCalls).toEqual([{ runId: RUN_ID, offset: 5 }]);
		expect(statuses.at(-1)).toBe("open");
		// overlap replay never re-delivered; the tail continued
		expect(applied).toEqual([0, 1, 2, 3, 4]);
		// live overlap after resume also dedupes
		second.emit(frame(RUN_ID, 4, delta(4, "e")));
		second.emit(frame(RUN_ID, 5, delta(5, "f")));
		expect(applied).toEqual([0, 1, 2, 3, 4, 5]);
		// the wire ledger saw the post-reconnect duplicate, and no gaps
		expect(metrics.summary().capn.wireDuplicateOffsets).toBe(1);
		expect(metrics.summary().capn.wireMissingOffsets).toBe(0);
		machine.close();
	});

	it("close() disposes subscription → conversation → root and stops delivery", async () => {
		const server = mockServer([frame(RUN_ID, 0, delta(0, "a"))]);
		const statuses: string[] = [];
		const applied: number[] = [];
		const releases: string[] = [];
		const machine = createCapnChatMachine({
			conversationId: CONVERSATION_ID,
			connect: connectSequence(server),
			onFrame: (streamFrame) => applied.push(streamFrame.offset),
			onStatus: (status) => statuses.push(status),
			trackStub: (label) => () => releases.push(label),
		});
		await flushAsync();
		machine.close();
		machine.close(); // idempotent
		expect(server.disposed).toEqual(["subscription", "conversation", "root"]);
		expect(releases.sort()).toEqual(["conversation", "root", "subscription"]);
		expect(statuses.at(-1)).toBe("idle");
		server.emit(frame(RUN_ID, 1, delta(1, "b")));
		expect(applied).toEqual([0]);
	});
});

// ---------------------------------------------------------------------------
// Actions — passthrough, known-not-sent, unknown outcome
// ---------------------------------------------------------------------------

describe("createCapnChatMachine actions", () => {
	it("enqueue/cancel/respondApproval pass through to the capability", async () => {
		const server = mockServer();
		const machine = createCapnChatMachine({
			conversationId: CONVERSATION_ID,
			connect: connectSequence(server),
			onFrame: () => {},
		});
		await flushAsync();
		const output = await machine.actions.enqueue({ content: "hi" }, "key-1");
		expect(output.idempotencyKey).toBe("key-1");
		expect(server.conversation.enqueue).toHaveBeenCalledWith(
			{ content: "hi" },
			"key-1",
		);
		await machine.actions.cancel(RUN_ID);
		expect(server.conversation.cancel).toHaveBeenCalledWith(RUN_ID);
		await machine.actions.respondApproval({
			runId: RUN_ID,
			decision: "approve",
		});
		expect(server.conversation.respondApproval).toHaveBeenCalledWith({
			runId: RUN_ID,
			decision: "approve",
		});
		machine.close();
	});

	it("throws a typed KNOWN-not-sent error before the session opens", async () => {
		const machine = createCapnChatMachine({
			conversationId: CONVERSATION_ID,
			connect: () => new Promise(() => {}), // never connects
			onFrame: () => {},
		});
		await expect(
			machine.actions.enqueue({ content: "hi" }, "key-1"),
		).rejects.toBeInstanceOf(CapnNotConnectedError);
		machine.close();
	});

	it("surfaces an enqueue whose connection died mid-call as an explicit UNKNOWN outcome", async () => {
		const server = mockServer();
		let rejectEnqueue: (error: unknown) => void = () => {};
		server.conversation.enqueue = vi.fn(
			() =>
				new Promise<EnqueueHomeMessageOutput>((_resolve, reject) => {
					rejectEnqueue = reject;
				}),
		);
		const timers = fakeTimers();
		const machine = createCapnChatMachine({
			conversationId: CONVERSATION_ID,
			connect: connectSequence(server, mockServer()),
			onFrame: () => {},
			setTimeoutFn: timers.setTimeoutFn,
			clearTimeoutFn: timers.clearTimeoutFn,
		});
		await flushAsync();
		const pending = machine.actions.enqueue({ content: "hi" }, "key-7");
		const settled = pending.catch((error: unknown) => error);
		server.breakConnection(); // the call is in flight when the socket dies
		rejectEnqueue(new Error("RPC session aborted"));
		const error = await settled;
		expect(isOutcomeUnknown(error)).toBe(true);
		expect((error as CapnOutcomeUnknownError).idempotencyKey).toBe("key-7");
		expect((error as CapnOutcomeUnknownError).message).toContain(
			"same idempotency key",
		);
		machine.close();
	});

	it("keeps an app-level rejection on a healthy session a plain error (never unknown)", async () => {
		const server = mockServer();
		server.conversation.enqueue = vi.fn(async () => {
			throw new Error("content rejected by the kernel");
		});
		const machine = createCapnChatMachine({
			conversationId: CONVERSATION_ID,
			connect: connectSequence(server),
			onFrame: () => {},
		});
		await flushAsync();
		const error = await machine.actions
			.enqueue({ content: "hi" }, "key-2")
			.catch((caught: unknown) => caught);
		expect(isOutcomeUnknown(error)).toBe(false);
		expect((error as Error).message).toBe("content rejected by the kernel");
		machine.close();
	});
});

// ---------------------------------------------------------------------------
// React hooks
// ---------------------------------------------------------------------------

/** Minimal hook harness (this app carries no @testing-library dependency). */
function renderHook<Result>(useHook: () => Result) {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	const container = document.createElement("div");
	const root: Root = createRoot(container);
	const result = { current: null as Result | null };
	function Harness() {
		result.current = useHook();
		return null;
	}
	act(() => {
		root.render(createElement(Harness));
	});
	return {
		result,
		/** Re-render the same hook closure, so a test can vary what it reads. */
		rerender: () =>
			act(() => {
				root.render(createElement(Harness));
			}),
		unmount: () => act(() => root.unmount()),
	};
}

const syncScheduler = (callback: () => void) => callback();

afterEach(() => {
	// The connection manager is process-wide by design (that is what makes N
	// surfaces share ONE stream). A suite that skips this inherits the previous
	// test's live stream and its fake socket.
	resetRealtimeConnections();
	// So are the resume watermarks, and for the same reason: a machine that
	// settled cleanly PARKS its cursor for the next machine on the same
	// conversation id. Every test here reuses one id, so skipping this makes
	// the next test's "first connection" resume from the previous test's log.
	resetConversationResumeWatermarks();
});

describe("useCapnStreamedOverlays", () => {
	it("folds snapshot + live frames into overlays and disposes stubs on unmount", async () => {
		const server = mockServer([frame(RUN_ID, 0, delta(0, "Hel"))]);
		const metrics = createTransportMetrics();
		const rendered = renderHook<UseCapnChatResult>(() =>
			useCapnStreamedOverlays(CONVERSATION_ID, {
				connect: connectSequence(server),
				metrics,
				frameScheduler: syncScheduler,
			}),
		);
		await act(async () => {
			await flushAsync();
		});
		expect(rendered.result.current?.status).toBe("open");
		expect(rendered.result.current?.actions).not.toBeNull();
		expect(metrics.liveStubCount("capn")).toBe(3); // root + conversation + subscription
		act(() => {
			server.emit(frame(RUN_ID, 1, delta(1, "lo")));
		});
		expect(rendered.result.current?.overlays[0]?.text).toBe("Hello");
		rendered.unmount();
		// Teardown is DEFERRED by one macrotask so a route change (unmount then
		// mount in the same commit) rejoins the live stream instead of re-dialing.
		// The stream is still up at this instant — that is the contract, not a
		// leak — and the deferral is bounded, not indefinite.
		expect(server.disposed).toEqual([]);
		await act(async () => {
			await flushAsync();
		});
		expect(server.disposed).toEqual(["subscription", "conversation", "root"]);
		// deterministic disposal: nothing outlived the session
		expect(metrics.liveStubCount("capn")).toBe(0);
		expect(metrics.summary().capn.leakedStubs).toBe(0);
	});

	it("honors the since storm-guard with the activeRunIds exemption (replay storm guard)", async () => {
		const otherRun = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		const server = mockServer();
		const seen: string[] = [];
		const rendered = renderHook<UseCapnChatResult>(() =>
			useCapnStreamedOverlays(CONVERSATION_ID, {
				connect: connectSequence(server),
				metrics: null,
				frameScheduler: syncScheduler,
				since: Date.parse("2026-08-15T12:00:00.000Z"), // after the events
				activeRunIds: [RUN_ID],
				onFrame: (event) => seen.push(event.runId ?? ""),
			}),
		);
		await act(async () => {
			await flushAsync();
		});
		act(() => {
			server.emit(frame(RUN_ID, 0, delta(0, "mid-run remainder"))); // exempt active run
			server.emit(frame(RUN_ID, 1, delta(0, "stale history", otherRun))); // cut off
		});
		expect(seen).toEqual([RUN_ID]);
		expect(rendered.result.current?.overlays).toHaveLength(1);
		rendered.unmount();
	});
});

describe("overlay coalescer survives StrictMode", () => {
	/**
	 * `apps/os/src/main.tsx` wraps the app in StrictMode, so every dev mount is
	 * setup → cleanup → setup with NO render in between. The coalescer ref
	 * outlives that cycle, so a cleanup that only disposed left the second setup
	 * holding an instance whose `disposed` flag was already latched — and
	 * `schedule()` early-returns on it forever. The symptom was subtle: durable
	 * rows still arrived over the transcript, so chat looked alive while every
	 * streamed token and phase row silently stopped rendering
	 * for the whole session.
	 */
	it("still flushes overlays after the double-invoked mount", async () => {
		const server = mockServer([frame(RUN_ID, 0, delta(0, "streamed"))]);
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		const root = createRoot(container);
		const seen = { current: null as UseCapnChatResult | null };
		function Harness() {
			seen.current = useCapnStreamedOverlays(CONVERSATION_ID, {
				connect: connectSequence(server),
				metrics: null,
				frameScheduler: syncScheduler,
			});
			return null;
		}
		act(() => {
			root.render(createElement(StrictMode, null, createElement(Harness)));
		});
		await act(async () => {
			await flushAsync();
		});
		expect(seen.current?.overlays[0]?.text).toBe("streamed");

		// A live frame after the double invocation is the real assertion: the
		// snapshot above could ride an initial flush, this cannot.
		act(() => {
			server.emit(frame(RUN_ID, 1, delta(1, " more")));
		});
		expect(seen.current?.overlays[0]?.text).toBe("streamed more");
		act(() => root.unmount());
		await act(async () => {
			await flushAsync();
		});
	});
});

describe("hydration is scoped to its own conversation", () => {
	/**
	 * The caller clears its hydrate batch with a setState, which does not change
	 * the prop within the SAME commit that first carries the new conversation
	 * id. So the first render after a switch arrives holding the PREVIOUS
	 * conversation's events. `applyOverlayEvent` keys only on runId and cannot
	 * tell they are foreign, so they used to fold into the new thread — and
	 * `visibleOverlays` never retires them, because it only drops an overlay
	 * whose run appears in the CURRENT transcript.
	 */
	it("ignores a stale batch and leaves the slot for the real one", async () => {
		const OTHER_CONVERSATION = "home:other";
		const server = mockServer();
		let conversationId = OTHER_CONVERSATION;
		let hydrate: RuntimeStreamEvent[] = [
			{
				...delta(0, "from the old thread"),
				conversationId: OTHER_CONVERSATION,
			},
		];
		const rendered = renderHook<UseCapnChatResult>(() =>
			useCapnStreamedOverlays(conversationId, {
				connect: connectSequence(server),
				metrics: null,
				frameScheduler: syncScheduler,
				hydrate,
			}),
		);
		await act(async () => {
			await flushAsync();
		});
		expect(rendered.result.current?.overlays[0]?.text).toBe(
			"from the old thread",
		);

		// The switch: new id, batch not yet cleared — the exact commit that bled.
		conversationId = CONVERSATION_ID;
		rendered.rerender();
		await act(async () => {
			await flushAsync();
		});
		expect(rendered.result.current?.overlays).toEqual([]);

		// The slot must still be free, or this conversation's own hydration —
		// which is what restores an in-flight turn after a reload — is skipped.
		hydrate = [
			{ ...delta(0, "my own in-flight turn"), conversationId: CONVERSATION_ID },
		];
		rendered.rerender();
		await act(async () => {
			await flushAsync();
		});
		expect(rendered.result.current?.overlays[0]?.text).toBe(
			"my own in-flight turn",
		);
		rendered.unmount();
		await act(async () => {
			await flushAsync();
		});
	});
});

describe("useChatTransport (the seam)", () => {
	it("uploads screenshot bytes before enqueue and preserves the retry key on the small chat frame", async () => {
		const server = mockServer();
		const rendered = renderHook<ChatTransportResult>(() =>
			useChatTransport(CONVERSATION_ID, {
				connect: connectSequence(server),
				metrics: null,
				frameScheduler: syncScheduler,
			}),
		);
		await act(async () => {
			await flushAsync();
		});
		const attachment = {
			type: "image" as const,
			fileName: "screenshot.png",
			mimeType: "image/png",
			size: 400000,
			content: `data:image/png;base64,${"A".repeat(533336)}`,
		};
		const handle = {
			...attachment,
			content: `tedix-attachment:${"a".repeat(64)}`,
		};
		uploadApi.mockResolvedValue(handle);
		await rendered.result.current?.actions.enqueueMessage({
			conversationId: CONVERSATION_ID,
			content: "Read this screenshot",
			attachments: [attachment],
			idempotencyKey: "screenshot-key",
		});
		expect(uploadApi).toHaveBeenCalledWith(attachment);
		expect(server.conversation.enqueue).toHaveBeenCalledWith(
			{ content: "Read this screenshot", attachments: [handle] },
			"screenshot-key",
		);
		expect(
			JSON.stringify(vi.mocked(server.conversation.enqueue).mock.calls[0])
				.length,
		).toBeLessThan(1024);
		uploadApi.mockRejectedValueOnce(new Error("Upload rejected"));
		await expect(
			rendered.result.current?.actions.enqueueMessage({
				conversationId: CONVERSATION_ID,
				content: "Try again",
				attachments: [attachment],
				idempotencyKey: "screenshot-key-2",
			}),
		).rejects.toThrow("Upload rejected");
		expect(server.conversation.enqueue).toHaveBeenCalledTimes(1);
		rendered.unmount();
	});

	it("emits first_phase once per run from the runtime's first progress frame", async () => {
		trackLifecycleApi.mockClear();
		const server = mockServer();
		const rendered = renderHook<ChatTransportResult>(() =>
			useChatTransport(CONVERSATION_ID, {
				connect: connectSequence(server),
				metrics: null,
				frameScheduler: syncScheduler,
			}),
		);
		await act(async () => {
			await flushAsync();
		});
		// The idempotency key IS the run id server-side, so enqueueing under
		// RUN_ID is what arms the correlation the frame path later reads.
		vi.mocked(server.conversation.enqueue).mockResolvedValue(
			enqueueOutput(RUN_ID),
		);
		await rendered.result.current?.actions.enqueueMessage({
			conversationId: CONVERSATION_ID,
			content: "Plan the migration",
			idempotencyKey: RUN_ID,
		});
		const milestonesFor = (name: string): LifecycleEvent[] =>
			trackLifecycleApi.mock.calls
				.flatMap(([input]) => input.events)
				.filter((entry) => entry.milestone === name);
		expect(milestonesFor("first_phase")).toHaveLength(0);
		act(() => {
			server.emit(frame(RUN_ID, 0, phaseEvent(0, "planning")));
		});
		expect(milestonesFor("first_phase")).toHaveLength(1);
		// Later transitions are progress, not a new first — the per-run dedupe in
		// `markNativeTurnMilestone` must swallow them.
		act(() => {
			server.emit(frame(RUN_ID, 1, phaseEvent(1, "generating")));
			server.emit(frame(RUN_ID, 2, phaseEvent(2, "finalizing")));
		});
		expect(milestonesFor("first_phase")).toHaveLength(1);
		const emitted = milestonesFor("first_phase")[0];
		expect(emitted?.surface).toBe("native_os");
		expect(emitted?.runId).toBe(RUN_ID);
		expect(emitted?.event).toBe("client_turn_milestone");
		rendered.unmount();
		await act(async () => {
			await flushAsync();
		});
	});

	it("emits rendered after the terminal frame, and ends the turn there", async () => {
		trackLifecycleApi.mockClear();
		const server = mockServer();
		const rendered = renderHook<ChatTransportResult>(() =>
			useChatTransport(CONVERSATION_ID, {
				connect: connectSequence(server),
				metrics: null,
				frameScheduler: syncScheduler,
			}),
		);
		await act(async () => {
			await flushAsync();
		});
		vi.mocked(server.conversation.enqueue).mockResolvedValue(
			enqueueOutput(RUN_ID),
		);
		await rendered.result.current?.actions.enqueueMessage({
			conversationId: CONVERSATION_ID,
			content: "Summarize the incident",
			idempotencyKey: RUN_ID,
		});
		const names = () =>
			trackLifecycleApi.mock.calls
				.flatMap(([input]) => input.events)
				.map((entry) => entry.milestone);

		// The terminal frame must NOT retire the correlation: `rendered` comes
		// after it, and the old lifecycle finished the turn here — which silently
		// dropped every `rendered` the thread reported.
		act(() => {
			server.emit(
				frame(RUN_ID, 0, {
					...delta(0, "done"),
					kind: "message.completed",
				} as RuntimeStreamEvent),
			);
		});
		expect(names()).toContain("terminal_received");
		expect(names()).not.toContain("rendered");

		rendered.result.current?.recordRendered(RUN_ID);
		expect(names().filter((name) => name === "rendered")).toHaveLength(1);

		// Deduped per run, so the thread may report on every commit.
		rendered.result.current?.recordRendered(RUN_ID);
		expect(names().filter((name) => name === "rendered")).toHaveLength(1);
		rendered.unmount();
		await act(async () => {
			await flushAsync();
		});
	});

	it("never reuses a bound conversation capability for the synthetic New state", () => {
		const actions = mockServer().conversation;
		expect(canUseBoundConversationCapability(CONVERSATION_ID, actions)).toBe(
			true,
		);
		expect(canUseBoundConversationCapability(null, actions)).toBe(false);
		expect(canUseBoundConversationCapability(CONVERSATION_ID, null)).toBe(
			false,
		);
	});

	it("dials /capn and opens — the only event transport", async () => {
		const server = mockServer();
		const rendered = renderHook<ChatTransportResult>(() =>
			useChatTransport(CONVERSATION_ID, {
				connect: connectSequence(server),
				metrics: null,
				frameScheduler: syncScheduler,
			}),
		);
		await act(async () => {
			await flushAsync();
		});
		expect(rendered.result.current?.status).toBe("open");
		rendered.unmount();
	});

	it("does not fall back to oRPC while an established thread reconnects", async () => {
		const rendered = renderHook<ChatTransportResult>(() =>
			useChatTransport(CONVERSATION_ID, {
				connect: () => new Promise(() => {}),
				metrics: null,
				frameScheduler: syncScheduler,
			}),
		);
		await expect(
			rendered.result.current?.actions.enqueueMessage({
				content: "hello",
				conversationId: CONVERSATION_ID,
				idempotencyKey: "key-no-fallback",
			}),
		).rejects.toBeInstanceOf(CapnNotConnectedError);
		rendered.unmount();
	});

	it("declares the transport DEGRADED when /capn never establishes, and measures it", async () => {
		// The safety property that replaced the retired SSE fallback: a /capn
		// that cannot come up flips the manager's degraded signal, which arms
		// ChatThread's polling and renders the shell chip. Established-thread
		// mutations remain unavailable until their capability reconnects.
		const metrics = createTransportMetrics();
		const timers = fakeTimers();
		const connect = vi.fn(async (): Promise<CapnSessionStub> => {
			throw new Error("upgrade refused");
		});
		const rendered = renderHook<ChatTransportResult>(() =>
			useChatTransport(CONVERSATION_ID, {
				connect,
				metrics,
				frameScheduler: syncScheduler,
				setTimeoutFn: timers.setTimeoutFn,
				clearTimeoutFn: timers.clearTimeoutFn,
			}),
		);

		// First establish fails: the machine goes to "reconnecting" and schedules
		// a backoff retry. One failure is NOT enough — a cold Worker deserves a
		// second chance, so nothing is declared yet.
		await act(async () => {
			await flushAsync();
		});
		expect(getRealtimeStatus().degraded).toBe(false);

		// Fire the backoff into a second failure: live updates are now declared
		// paused. The machine keeps retrying underneath.
		await act(async () => {
			timers.fireNext();
			await flushAsync();
		});
		expect(getRealtimeStatus().degraded).toBe(true);
		expect(metrics.summary().capn.connectFailures).toBe(2);
		rendered.unmount();
	});

	it("capn serves events and streaming-safe verbs travel the capability, measured", async () => {
		const server = mockServer();
		const metrics = createTransportMetrics();
		const rendered = renderHook<ChatTransportResult>(() =>
			useChatTransport(CONVERSATION_ID, {
				connect: connectSequence(server),
				metrics,
				frameScheduler: syncScheduler,
			}),
		);
		await act(async () => {
			await flushAsync();
		});
		expect(rendered.result.current?.status).toBe("open");

		const output = await rendered.result.current?.actions.enqueueMessage({
			conversationId: CONVERSATION_ID,
			content: "ship it",
			idempotencyKey: "key-42",
		});
		expect(output?.idempotencyKey).toBe("key-42");
		expect(server.conversation.enqueue).toHaveBeenCalledWith(
			{ content: "ship it" },
			"key-42",
		);
		// the harness measured the send and pairs the first assistant delta
		expect(metrics.summary().capn.sendToVisible.count).toBe(1);
		act(() => {
			server.emit(frame(RUN_ID, 0, delta(0, "On", "key-42")));
			server.emit(frame(RUN_ID, 1, delta(1, " it", "key-42")));
		});
		expect(metrics.summary().capn.firstToken.count).toBe(1);
		rendered.unmount();
		expect(metrics.summary().capn.leakedStubs).toBe(0);
	});
});
