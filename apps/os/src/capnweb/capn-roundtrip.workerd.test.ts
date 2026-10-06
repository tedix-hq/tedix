/**
 * THE roundtrip test: the real browser machine talking to the real `/capn`
 * mount over a real Cap'n Web session, inside a real workerd isolate.
 *
 * This exists because the pilot shipped TWO fakes. `use-capn-chat.test.ts`
 * hand-wrote a server implementing the client's imagined contract;
 * `session-root.test.ts` invoked the capability classes directly and faked only
 * the upstream. Both suites were green while the two halves disagreed about the
 * snapshot shape, the cursor's type, its polarity and its namespace — so
 * nothing in CI could observe that the lane could never connect at all.
 *
 * What is REAL here:
 * - `WebSocketPair` from workerd. `mountCapnChat` returns a genuine 101 with
 *   `response.webSocket`; the test accepts the client half and hands it to
 *   `newWebSocketRpcSession`. Every call below is serialized, sent over the
 *   socket, dispatched through capnweb's stub tables and answered — including
 *   promise pipelining and callback stubs.
 * - The production `mountCapnChat` (Origin check, authorization pre-flight,
 *   limits, redaction) and the production `CapnChatSession`.
 * - The production `createCapnChatMachine` — the same code the React hook
 *   drives. Nothing about the client's cursor handling is re-implemented here.
 *
 * What is faked, and what that means:
 * - `API_SERVICE` is a scripted oRPC-wire fetcher. This test proves the OS
 *   worker ↔ browser contract; it does NOT prove apps/api's own behavior
 *   (that is `events-stream.test.ts` and the kernel-runtime router suites).
 *   The scripts below are shaped by `RuntimeStreamReadOutputSchema` and
 *   `HomeRunSetSchema`, which the session root parses for real, so a drift in
 *   those upstream contracts still fails here.
 * - Transport DEATH is driven through a scripted `RpcTransport` in the last
 *   block rather than `ws.close()`: a graceful in-process close still delivers
 *   the already-queued reply, so an in-flight call RESOLVES instead of
 *   rejecting and the outcome-unknown path cannot be reached that way.
 */

import { newWebSocketRpcSession, RpcSession, type RpcTransport } from "capnweb";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createCapnChatMachine } from "@/lib/capn-chat-machine";
import {
	type ConversationStreamFrame,
	resetConversationResumeWatermarks,
} from "@/lib/conversation-stream";
import type { CapnSessionStub } from "./contract";
import { mountCapnChat } from "./mount";
import { CapnChatSession, MAX_MESSAGE_BYTES } from "./session-root";

// -----------------------------------------------------------------------------
// Scripted upstream (oRPC wire: POST /rpc/<path> with {json: input})
// -----------------------------------------------------------------------------

type RpcHandler = (path: string, input: unknown) => unknown | Promise<unknown>;
type RecordedCall = { path: string; input: unknown };

function apiService(handler: RpcHandler) {
	const calls: RecordedCall[] = [];
	const service = {
		fetch: async (request: Request): Promise<Response> => {
			const path = new URL(request.url).pathname.replace(/^\/rpc\//, "");
			const body = (await request.json()) as { json?: unknown };
			calls.push({ path, input: body.json });
			return Response.json({ json: await handler(path, body.json) });
		},
	};
	return { service, calls };
}

const CONVERSATION_ID = "home:main";

// A cleanly settled machine parks its resume cursor under this id, and every
// test in this file reuses it. Without the reset the next test's FIRST connect
// resumes past events its own fixture server has never served, and it waits
// forever for frames that will not be replayed.
afterEach(() => {
	resetConversationResumeWatermarks();
});
const HOST_TENANT = "T-host-org";
const ORIGIN = "https://tedix.os.tedix.dev";

function streamEvent(id: string, runId: string) {
	return {
		id,
		kind: "message.delta",
		conversationId: CONVERSATION_ID,
		runId,
		sequence: Number(id.split("-").pop() ?? 0),
		delta: id,
		createdAt: "2026-08-16T00:00:00.000Z",
		payload: { role: "assistant", content: id },
	};
}

function eventsPage(
	events: ReturnType<typeof streamEvent>[],
	offset: number,
	closed = false,
) {
	return {
		events,
		stream: {
			streamId: "stream-1",
			offset,
			nextOffset: offset + events.length,
			closed,
		},
	};
}

function runSet(activeRunIds: string[], runIds: string[] = activeRunIds) {
	return {
		runSet: {
			organizationId: "org-1",
			conversationId: CONVERSATION_ID,
			activeRunIds,
			runs: runIds.map((id) => ({
				id,
				organizationId: "org-1",
				conversationId: CONVERSATION_ID,
				status: "running",
				createdAt: "2026-08-16T00:00:00.000Z",
			})),
		},
	};
}

/** Never-settling page read: parks the pump at the head of the log. */
const HEAD = () => new Promise<never>(() => {});

// -----------------------------------------------------------------------------
// Real socket wiring
// -----------------------------------------------------------------------------

function upgradeRequest(): Request {
	return new Request(`${ORIGIN}/capn`, {
		headers: { Upgrade: "websocket", Origin: ORIGIN, Cookie: "DS=abc" },
	});
}

/**
 * Mount `/capn` for real and return the browser-side session stub, typed from
 * the SHARED contract. There is no cast here: `newWebSocketRpcSession` is
 * instantiated at `CapnSessionStub`, which is derived from the interface
 * `CapnChatSession` implements.
 */
async function openRealSession(handler: RpcHandler) {
	const { service, calls } = apiService((path, input) => {
		// The mount's authorization pre-flight, answered for an authorized
		// caller. Its refusal path is covered in session-root.test.ts.
		if (path === "kernelRuntime/listConversations")
			return { conversations: [] };
		return handler(path, input);
	});
	const response = await mountCapnChat(
		upgradeRequest(),
		{ API_SERVICE: service },
		HOST_TENANT,
	);
	expect(response.status).toBe(101);
	// `Response.webSocket` and `WebSocket.accept()` are workerd extensions the
	// app's DOM lib does not declare; the shape is narrowed, not assumed.
	const socket = (response as Response & { webSocket?: WorkerdSocket | null })
		.webSocket;
	if (!socket) throw new Error("mountCapnChat returned no WebSocket");
	socket.accept();
	const root = newWebSocketRpcSession<CapnSessionStub>(socket);
	return { root, socket, calls };
}

/** workerd's server-side WebSocket: a DOM WebSocket plus `accept()`. */
type WorkerdSocket = WebSocket & { accept(): void };

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Real-time poll. The server pump paces run rollover with
 * SUBSCRIBE_IDLE_DELAY_MS (1s) and this test drives the PRODUCTION mount, so a
 * microtask-only drain cannot reach the next run.
 */
async function until(
	predicate: () => boolean,
	label: string,
	budgetMs = 15_000,
): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${label}`);
}

// -----------------------------------------------------------------------------

describe("/capn client↔Worker roundtrip over a real WebSocket", () => {
	it("establishes, snapshots, subscribes, and delivers live frames in order", async () => {
		const pages = new Map<string, unknown>([
			// Snapshot page (waitMs 0), then the subscription's long poll.
			["run-1:0:snapshot", eventsPage([streamEvent("e-0", "run-1")], 0)],
			["run-1:1", eventsPage([streamEvent("e-1", "run-1")], 1)],
		]);
		const { root, calls } = await openRealSession((path, input) => {
			if (path === "kernelRuntime/readRunSet") return runSet(["run-1"]);
			if (path === "kernelRuntime/readRunEvents") {
				const { runId, offset, waitMs } = input as {
					runId: string;
					offset: number;
					waitMs?: number;
				};
				const key =
					waitMs === undefined
						? `${runId}:${offset}:snapshot`
						: `${runId}:${offset}`;
				return pages.get(key) ?? HEAD();
			}
			throw new Error(`unexpected path ${path}`);
		});

		const frames: ConversationStreamFrame[] = [];
		const statuses: string[] = [];
		const machine = createCapnChatMachine({
			conversationId: CONVERSATION_ID,
			connect: async () => root,
			onFrame: (frame) => frames.push(frame),
			onStatus: (status) => statuses.push(status),
		});

		await until(() => statuses.includes("open"), "the session to open");
		await until(() => frames.length >= 2, "two frames");

		// Run-namespaced ids, exact run-local offsets, in order.
		expect(frames.map((frame) => frame.eventId)).toEqual([
			`${CONVERSATION_ID}:run-1:0`,
			`${CONVERSATION_ID}:run-1:1`,
		]);
		expect(frames.map((frame) => frame.event.id)).toEqual(["e-0", "e-1"]);
		// The cursor is the value the SERVER issued, not one the client derived.
		expect(machine.getCursor()).toEqual({ runId: "run-1", offset: 2 });
		// The snapshot costs no transcript read.
		expect(
			calls.some((call) => call.path === "kernelRuntime/readMessages"),
		).toBe(false);
		machine.close();
	});

	it("pipelines snapshot onto an un-awaited openConversation", async () => {
		const { root } = await openRealSession((path, input) => {
			if (path === "kernelRuntime/readRunSet") return runSet(["run-1"]);
			if (path === "kernelRuntime/readRunEvents") {
				const { offset } = input as { offset: number };
				return offset === 0
					? eventsPage([streamEvent("e-0", "run-1")], 0)
					: HEAD();
			}
			throw new Error(`unexpected path ${path}`);
		});

		// The production call site never awaits this. Against REAL capnweb the
		// result is an RpcPromise, so the snapshot call is written onto it and
		// both cross in one round trip. If capnweb ever stopped returning a
		// pipelinable stub, this line would throw rather than merely slow down.
		const conversation = root.openConversation(CONVERSATION_ID);
		const snapshot = await conversation.snapshot(null);

		expect(snapshot.runId).toBe("run-1");
		expect(snapshot.events.map((frame) => frame.event.id)).toEqual(["e-0"]);
		expect(snapshot.cursor).toEqual({ runId: "run-1", offset: 1 });

		// `typeof` a real stub is "function", which is why the machine's stub
		// guard must not test for "object" — see isStubLike in capn-chat-machine.
		expect(typeof conversation).toBe("function");
		// Disposal reaches the capability through the un-awaited handle.
		conversation[Symbol.dispose]?.();
	});

	it("reconnects across a run rollover with no gaps and no duplicates", async () => {
		// run-1 delivers offsets 0..2 then closes; run-2 delivers offset 0. The
		// pilot's client folded both runs into one offset space, so run-2's
		// offset 0 collided with run-1's and was dropped as a duplicate — and
		// its monotonic high-water could never resume a new run either.
		let runOneClosed = false;
		const handler: RpcHandler = (path, input) => {
			if (path === "kernelRuntime/readRunSet") {
				// Newest-first, exactly as readRunSet returns them.
				return runOneClosed
					? runSet([], ["run-2", "run-1"])
					: runSet(["run-1"], ["run-1"]);
			}
			if (path === "kernelRuntime/readRunEvents") {
				const { runId, offset } = input as { runId: string; offset: number };
				if (runId === "run-1" && offset === 0) {
					return eventsPage(
						[streamEvent("e-0", "run-1"), streamEvent("e-1", "run-1")],
						0,
					);
				}
				if (runId === "run-1" && offset === 2) {
					runOneClosed = true;
					return eventsPage([streamEvent("e-2", "run-1")], 2, true);
				}
				if (runId === "run-1" && offset === 3) {
					return eventsPage([], 3, true);
				}
				if (runId === "run-2" && offset === 0) {
					return eventsPage([streamEvent("f-0", "run-2")], 0);
				}
				return HEAD();
			}
			throw new Error(`unexpected path ${path}`);
		};

		const first = await openRealSession(handler);
		const second = await openRealSession(handler);
		const sessions = [first.root, second.root];
		let connects = 0;
		const frames: ConversationStreamFrame[] = [];
		const machine = createCapnChatMachine({
			conversationId: CONVERSATION_ID,
			connect: async () => {
				const root = sessions[connects];
				connects += 1;
				if (!root) throw new Error("no session left");
				return root;
			},
			onFrame: (frame) => frames.push(frame),
			// Immediate retry so the test does not sit through the 1s backoff.
			setTimeoutFn: (callback) => setTimeout(callback, 0),
		});

		await until(() => frames.length >= 3, "the first run's events");
		expect(machine.getCursor()).toEqual({ runId: "run-1", offset: 3 });

		// Kill the socket the way a real drop does.
		first.socket.close(1011, "gone");
		await until(() => connects === 2, "a reconnect");
		await until(
			() => frames.some((frame) => frame.event.id === "f-0"),
			"the next run's first event",
		);

		// Exactly once each, in durable order, across the reconnect AND the run
		// boundary. run-2's offset 0 is NOT a duplicate of run-1's offset 0.
		expect(frames.map((frame) => frame.event.id)).toEqual([
			"e-0",
			"e-1",
			"e-2",
			"f-0",
		]);
		expect(frames.map((frame) => frame.eventId)).toEqual([
			`${CONVERSATION_ID}:run-1:0`,
			`${CONVERSATION_ID}:run-1:1`,
			`${CONVERSATION_ID}:run-1:2`,
			`${CONVERSATION_ID}:run-2:0`,
		]);
		expect(machine.getCursor()).toEqual({ runId: "run-2", offset: 1 });
		machine.close();
	}, 30_000);

	it("carries enqueue with its idempotency key and the host-asserted tenant", async () => {
		const { root, calls } = await openRealSession((path) => {
			if (path === "kernelRuntime/readRunSet") return runSet([], []);
			if (path === "kernelRuntime/enqueueMessage") {
				return {
					idempotencyKey: "key-1",
					conversationId: CONVERSATION_ID,
					status: "queued",
					run: {
						id: "key-1",
						organizationId: "org-1",
						conversationId: CONVERSATION_ID,
						status: "queued",
						createdAt: "2026-08-16T00:00:00.000Z",
					},
				};
			}
			throw new Error(`unexpected path ${path}`);
		});
		const statuses: string[] = [];
		const machine = createCapnChatMachine({
			conversationId: CONVERSATION_ID,
			connect: async () => root,
			onFrame: () => {},
			onStatus: (status) => statuses.push(status),
		});
		// The lane opens even with no run at all: an empty snapshot cursor is a
		// legitimate "nothing to resume from", not a failure.
		await until(() => statuses.includes("open"), "the session to open");
		const output = await machine.actions.enqueue({ content: "hi" }, "key-1");
		expect(output.status).toBe("queued");
		const enqueue = calls.find(
			(call) => call.path === "kernelRuntime/enqueueMessage",
		);
		expect(enqueue?.input).toEqual({
			content: "hi",
			conversationId: CONVERSATION_ID,
			executionPolicy: "normal",
			idempotencyKey: "key-1",
		});
		machine.close();
	});

	it("surfaces contract refusals verbatim and redacts everything else", async () => {
		const { root } = await openRealSession((path) => {
			if (path === "kernelRuntime/readRunSet") return runSet(["run-1"]);
			if (path === "kernelRuntime/enqueueMessage") {
				throw new Error("upstream detail: internal-token-abc");
			}
			return HEAD();
		});
		const conversation = await root.openConversation(CONVERSATION_ID);

		// A contract refusal is the peer's business and crosses intact.
		await expect(
			conversation.enqueue({ content: "x".repeat(MAX_MESSAGE_BYTES + 1) }, "k"),
		).rejects.toThrow(/Message too large/);
		await expect(
			conversation.snapshot({
				runId: "run-1",
				offset: -1,
			}),
		).rejects.toThrow(/Invalid cursor.offset/);

		// An upstream failure does NOT: onSendError collapses it.
		await expect(conversation.enqueue({ content: "hi" }, "k")).rejects.toThrow(
			/The Cap'n Web call failed/,
		);
		await expect(
			conversation.enqueue({ content: "hi" }, "k"),
		).rejects.not.toThrow(/internal-token-abc/);
	});

	it("stops the server-side pump when the client closes", async () => {
		let reads = 0;
		const { root } = await openRealSession((path, input) => {
			if (path === "kernelRuntime/readRunSet") return runSet(["run-1"]);
			if (path === "kernelRuntime/readRunEvents") {
				const { offset } = input as { offset: number };
				reads += 1;
				if (offset === 0) return eventsPage([streamEvent("e-0", "run-1")], 0);
				return HEAD();
			}
			throw new Error(`unexpected path ${path}`);
		});
		const frames: ConversationStreamFrame[] = [];
		const machine = createCapnChatMachine({
			conversationId: CONVERSATION_ID,
			connect: async () => root,
			onFrame: (frame) => frames.push(frame),
		});
		await until(() => frames.length >= 1, "the first frame");
		machine.close();
		await until(() => true, "close to settle");
		const readsAtClose = reads;
		for (let i = 0; i < 20; i += 1) await tick();
		// Disposing the subscription stub runs SubscriptionCap[Symbol.dispose]
		// on the server, which ends the poll loop: no further upstream reads.
		expect(reads).toBe(readsAtClose);
	});
});

// -----------------------------------------------------------------------------
// Deterministic transport death (scripted RpcTransport, not a socket close)
// -----------------------------------------------------------------------------

/** One direction of an in-memory capnweb link, with an explicit kill switch. */
class Pipe {
	#queue: string[] = [];
	#waiting: Array<{
		resolve: (value: string) => void;
		reject: (error: unknown) => void;
	}> = [];
	#failure: unknown = null;

	push(message: string): void {
		const waiter = this.#waiting.shift();
		if (waiter) {
			waiter.resolve(message);
			return;
		}
		this.#queue.push(message);
	}

	pull(): Promise<string> {
		if (this.#failure !== null) return Promise.reject(this.#failure);
		const queued = this.#queue.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise<string>((resolve, reject) => {
			this.#waiting.push({ resolve, reject });
		});
	}

	/** Hard death: everything queued is lost and every reader rejects. */
	fail(error: unknown): void {
		this.#failure = error;
		this.#queue = [];
		const waiting = this.#waiting;
		this.#waiting = [];
		for (const waiter of waiting) waiter.reject(error);
	}
}

function scriptedLink() {
	const toServer = new Pipe();
	const toClient = new Pipe();
	const clientTransport: RpcTransport = {
		send: (message) => toServer.push(message),
		receive: () => toClient.pull(),
		abort: () => {},
	};
	const serverTransport: RpcTransport = {
		send: (message) => toClient.push(message),
		receive: () => toServer.pull(),
		abort: () => {},
	};
	return {
		clientTransport,
		serverTransport,
		kill: (error: unknown) => {
			toClient.fail(error);
			toServer.fail(error);
		},
	};
}

describe("/capn outcome-unknown", () => {
	it("classifies an enqueue whose link dies in flight as UNKNOWN, not failure", async () => {
		let releaseEnqueue: (() => void) | null = null;
		const { service } = apiService(async (path) => {
			if (path === "kernelRuntime/readRunSet") return runSet([], []);
			if (path === "kernelRuntime/enqueueMessage") {
				await new Promise<void>((resolve) => {
					releaseEnqueue = resolve;
				});
				return {};
			}
			return HEAD();
		});
		const link = scriptedLink();
		// Same root class, same options; only the transport is scripted.
		new RpcSession(
			link.serverTransport,
			new CapnChatSession({
				env: { API_SERVICE: service },
				hostTenantId: HOST_TENANT,
				credentialHeaders: { Cookie: "DS=abc" },
			}),
		);
		const clientSession = new RpcSession<CapnSessionStub>(link.clientTransport);
		const root = clientSession.getRemoteMain();

		const statuses: string[] = [];
		const machine = createCapnChatMachine({
			conversationId: CONVERSATION_ID,
			connect: async () => root,
			onFrame: () => {},
			onStatus: (status) => statuses.push(status),
			setTimeoutFn: () => 0, // never reconnect inside this test
		});
		await until(() => statuses.includes("open"), "the session to open");

		const pending = machine.actions.enqueue({ content: "hi" }, "key-1");
		const settled = pending.then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		await until(() => releaseEnqueue !== null, "the upstream call to start");

		link.kill(new Error("link died mid-write"));
		const result = await settled;

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		// An honest UNKNOWN: the kernel may or may not have accepted the turn,
		// and the same idempotency key is the only safe recovery.
		expect((result.error as Error).name).toBe("CapnOutcomeUnknownError");
		expect((result.error as { idempotencyKey: string }).idempotencyKey).toBe(
			"key-1",
		);
		machine.close();
	});
});
