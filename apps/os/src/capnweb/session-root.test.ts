// @vitest-environment node
import { RpcTarget } from "capnweb";
import { describe, expect, it } from "vite-plus/test";
import type {
	CapnEventFrame,
	CapnRespondApprovalParams,
	CapnSubscriber,
} from "./contract";
import {
	buildCredentialHeaders,
	isSameOriginUpgrade,
	mountCapnChat,
} from "./mount";
import {
	CapnChatSession,
	type CapnChatSessionInit,
	ConversationCap,
	MAX_MESSAGE_BYTES,
	RATE_LIMIT_CALLS,
	RATE_LIMIT_WINDOW_MS,
	SUBSCRIBE_MAX_CALLBACK_FAILURES,
	SUBSCRIBE_MAX_POLL_FAILURES,
	SubscriptionCap,
} from "./session-root";
import { CAPN_MAX_LIVE_SUBSCRIPTIONS } from "./contract";

// -----------------------------------------------------------------------------
// Mock API_SERVICE — an oRPC-wire-shaped fetcher (POST /rpc/<path>, {json: ...})
// -----------------------------------------------------------------------------

type RecordedCall = { path: string; input: unknown; headers: Headers };

function mockApiService(
	handler: (path: string, input: unknown) => unknown | Promise<unknown>,
) {
	const calls: RecordedCall[] = [];
	const service = {
		fetch: async (request: Request): Promise<Response> => {
			const path = new URL(request.url).pathname.replace(/^\/rpc\//, "");
			const body = (await request.json()) as { json?: unknown };
			calls.push({ path, input: body.json, headers: request.headers });
			const result = await handler(path, body.json);
			return Response.json({ json: result });
		},
	};
	return { service, calls };
}

const CREDENTIALS = { Authorization: "Bearer user-token", Cookie: "DS=abc" };

function makeSession(
	service: { fetch(request: Request): Promise<Response> },
	overrides: Partial<CapnChatSessionInit> = {},
): CapnChatSession {
	return new CapnChatSession({
		env: { API_SERVICE: service },
		hostTenantId: "T-host-org",
		credentialHeaders: { ...CREDENTIALS },
		sleep: async () => {},
		...overrides,
	});
}

// Contract-valid fixtures ------------------------------------------------------

function runSetOutput(activeRunIds: string[], runIds: string[] = activeRunIds) {
	return {
		runSet: {
			organizationId: "org-1",
			conversationId: "conv-1",
			activeRunIds,
			runs: runIds.map((id) => ({
				id,
				organizationId: "org-1",
				conversationId: "conv-1",
				status: "running",
				createdAt: "2026-08-15T00:00:00.000Z",
			})),
		},
	};
}

function streamEvent(id: string, kind = "message.delta") {
	return { id, kind, createdAt: "2026-08-15T00:00:01.000Z" };
}

function eventsPage(
	events: ReturnType<typeof streamEvent>[],
	offset: number,
	closed = false,
) {
	return {
		events,
		stream: {
			streamId: "run-stream",
			offset,
			nextOffset: offset + events.length,
			closed,
		},
	};
}

/** Handler answering the two read verbs a snapshot/subscription touches. */
function readOnlyHandler(runId: string | null, pages: Map<number, unknown>) {
	return (path: string, input: unknown) => {
		if (path === "kernelRuntime/readRunSet") {
			return runSetOutput(
				runId === null ? [] : [runId],
				runId === null ? [] : [runId],
			);
		}
		if (path === "kernelRuntime/readRunEvents") {
			const offset = (input as { offset: number }).offset;
			const page = pages.get(offset);
			if (page === undefined) return new Promise(() => {}); // hang: no more pages
			return page;
		}
		throw new Error(`unexpected path ${path}`);
	};
}

function subscriberStub() {
	const frames: CapnEventFrame[] = [];
	const counters = { dup: 0, disposed: 0 };
	const stub: CapnSubscriber = Object.assign(
		(frame: CapnEventFrame) => {
			frames.push(frame);
		},
		{
			dup(): CapnSubscriber {
				counters.dup += 1;
				return stub;
			},
			[Symbol.dispose](): void {
				counters.disposed += 1;
			},
		},
	);
	return { stub, frames, counters };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// -----------------------------------------------------------------------------
// Capability shape
// -----------------------------------------------------------------------------

describe("CapnChatSession capability shape", () => {
	it("exposes exactly the pilot capability surface", () => {
		const { service } = mockApiService(() => ({}));
		const session = makeSession(service);
		expect(session).toBeInstanceOf(RpcTarget);
		expect(typeof session.ping).toBe("function");
		const conversation = session.openConversation("conv-1");
		expect(conversation).toBeInstanceOf(ConversationCap);
		expect(conversation).toBeInstanceOf(RpcTarget);
		expect(typeof conversation.snapshot).toBe("function");
		expect(typeof conversation.subscribe).toBe("function");
		expect(typeof conversation.enqueue).toBe("function");
		expect(typeof conversation.cancel).toBe("function");
		expect(typeof conversation.respondApproval).toBe("function");
	});

	it("keeps internals off the RPC-visible prototype", () => {
		const prototypeMethods = Object.getOwnPropertyNames(
			CapnChatSession.prototype,
		).filter((name) => name !== "constructor");
		expect(prototypeMethods).toEqual(["ping", "openConversation"]);
	});
});

// -----------------------------------------------------------------------------
// Forwarding: credentials + host-asserted org header on EVERY call
// -----------------------------------------------------------------------------

describe("forwarded call headers", () => {
	it("asserts the host tenant and forwards the caller's credentials on every upstream call", async () => {
		const { service, calls } = mockApiService(
			readOnlyHandler(
				"run-1",
				new Map([[0, eventsPage([streamEvent("e-0")], 0)]]),
			),
		);
		const session = makeSession(service);
		const snapshot = await session.openConversation("conv-1").snapshot();

		expect(snapshot.runId).toBe("run-1");
		// Event-only snapshot: no readMessages round trip (the transcript is
		// the oRPC path's job, and nothing ever read the field).
		expect(calls.map((call) => call.path).sort()).toEqual([
			"kernelRuntime/readRunEvents",
			"kernelRuntime/readRunSet",
		]);
		for (const call of calls) {
			expect(call.headers.get("X-Tedix-Tenant-Id")).toBe("T-host-org");
			expect(call.headers.get("Authorization")).toBe("Bearer user-token");
			expect(call.headers.get("Cookie")).toBe("DS=abc");
		}
	});

	it("discards a caller-supplied tenant override in favor of the host assertion", async () => {
		const { service, calls } = mockApiService(readOnlyHandler(null, new Map()));
		const session = makeSession(service, {
			credentialHeaders: { ...CREDENTIALS, "X-Tedix-Tenant-Id": "T-attacker" },
		});
		await session.openConversation("conv-1").snapshot();
		for (const call of calls) {
			expect(call.headers.get("X-Tedix-Tenant-Id")).toBe("T-host-org");
		}
	});

	it("sends no tenant header at all when the host resolved none", async () => {
		const { service, calls } = mockApiService(readOnlyHandler(null, new Map()));
		const session = makeSession(service, {
			hostTenantId: null,
			credentialHeaders: { ...CREDENTIALS, "X-Tedix-Tenant-Id": "T-attacker" },
		});
		await session.openConversation("conv-1").snapshot();
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call.headers.get("X-Tedix-Tenant-Id")).toBeNull();
		}
	});
});

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

describe("payload validation", () => {
	it("rejects invalid payloads before any upstream call", async () => {
		const { service, calls } = mockApiService(() => ({}));
		const session = makeSession(service);

		expect(() => session.openConversation("")).toThrow(
			/Invalid conversationId/,
		);

		const conversation = session.openConversation("conv-1");
		await expect(
			conversation.snapshot({ runId: "", offset: 0 }),
		).rejects.toThrow(/Invalid cursor.runId/);
		await expect(
			conversation.snapshot({ runId: "run-1", offset: -1 }),
		).rejects.toThrow(/Invalid cursor.offset/);
		await expect(
			conversation.snapshot(-1 as unknown as { runId: string; offset: number }),
		).rejects.toThrow(/Invalid cursor/);
		await expect(conversation.enqueue(42, "key-1")).rejects.toThrow(
			/Invalid enqueue input/,
		);
		await expect(conversation.enqueue({ content: "hi" }, "")).rejects.toThrow(
			/Invalid idempotencyKey/,
		);
		await expect(conversation.cancel("")).rejects.toThrow(/Invalid runId/);
		await expect(
			conversation.respondApproval({
				runId: "run-1",
				decision: "maybe",
			} as unknown as CapnRespondApprovalParams),
		).rejects.toThrow(/Invalid respondApproval params/);
		expect(() =>
			conversation.subscribe("not-a-function" as unknown as CapnSubscriber),
		).toThrow(/Invalid subscribe callback/);

		expect(calls).toHaveLength(0);
	});

	it("enforces the 64KiB message-size cap without an upstream call", async () => {
		const { service, calls } = mockApiService(() => ({}));
		const conversation = makeSession(service).openConversation("conv-1");
		await expect(
			conversation.enqueue(
				{ content: "x".repeat(MAX_MESSAGE_BYTES + 1) },
				"key-1",
			),
		).rejects.toThrow(/Message too large/);
		expect(calls).toHaveLength(0);
	});
});

// -----------------------------------------------------------------------------
// Rate cap
// -----------------------------------------------------------------------------

describe("per-session call rate cap", () => {
	it("allows a burst of RATE_LIMIT_CALLS, refuses the next, and refills with time", () => {
		const { service } = mockApiService(() => ({}));
		let nowMs = 0;
		const session = makeSession(service, { now: () => nowMs });

		for (let i = 0; i < RATE_LIMIT_CALLS; i++) {
			session.openConversation(`conv-${i}`);
		}
		expect(() => session.openConversation("conv-over")).toThrow(
			/Rate limit exceeded/,
		);

		nowMs += RATE_LIMIT_WINDOW_MS;
		expect(() => session.openConversation("conv-refilled")).not.toThrow();
	});
});

// -----------------------------------------------------------------------------
// Mutations
// -----------------------------------------------------------------------------

describe("enqueue", () => {
	it("forwards the pinned conversation and idempotency key to enqueueMessage", async () => {
		const { service, calls } = mockApiService((path) => {
			expect(path).toBe("kernelRuntime/enqueueMessage");
			return {
				idempotencyKey: "key-1",
				conversationId: "conv-1",
				status: "queued",
				run: {
					id: "run-1",
					organizationId: "org-1",
					conversationId: "conv-1",
					status: "queued",
					createdAt: "2026-08-15T00:00:00.000Z",
				},
			};
		});
		const conversation = makeSession(service).openConversation("conv-1");
		const output = await conversation.enqueue({ content: "hello" }, "key-1");
		expect(output.status).toBe("queued");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toEqual({
			content: "hello",
			conversationId: "conv-1",
			executionPolicy: "normal",
			idempotencyKey: "key-1",
		});
	});

	it("never retries: an outcome-unknown transport failure surfaces after exactly one attempt", async () => {
		let attempts = 0;
		const service = {
			fetch: async (): Promise<Response> => {
				attempts += 1;
				throw new Error("socket hang up mid-write");
			},
		};
		const conversation = makeSession(service).openConversation("conv-1");
		await expect(
			conversation.enqueue({ content: "hello" }, "key-1"),
		).rejects.toThrow(/socket hang up/);
		expect(attempts).toBe(1);
	});
});

describe("cancel and respondApproval", () => {
	it("forwards to the canonical cancelRun and respondApproval verbs", async () => {
		const { service, calls } = mockApiService((path) => {
			if (
				path === "kernelRuntime/cancelRun" ||
				path === "kernelRuntime/respondApproval"
			) {
				return { run: { id: "run-1" } };
			}
			throw new Error(`unexpected path ${path}`);
		});
		const conversation = makeSession(service).openConversation("conv-1");
		await conversation.cancel("run-1", "operator stop");
		await conversation.respondApproval({ runId: "run-1", decision: "approve" });
		expect(calls.map((call) => call.path)).toEqual([
			"kernelRuntime/cancelRun",
			"kernelRuntime/respondApproval",
		]);
		expect(calls[0]?.input).toEqual({
			runId: "run-1",
			reason: "operator stop",
		});
		expect(calls[1]?.input).toEqual({ runId: "run-1", decision: "approve" });
	});
});

// -----------------------------------------------------------------------------
// Subscriptions
// -----------------------------------------------------------------------------

describe("subscribe", () => {
	it("ignores repeated start() calls instead of spawning a pump each time", async () => {
		// `start()` is a PUBLIC member of an RpcTarget, so the peer can call it.
		// Each call used to launch an independent concurrent pump on the same
		// cap, and neither server limit caught it: CAPN_MAX_LIVE_SUBSCRIPTIONS
		// counts caps (still one) and pumps never take a rate-limit token — so
		// one authorized socket could fan out arbitrarily many long-polls into
		// apps/api.
		const { service, calls } = mockApiService(
			readOnlyHandler(
				"run-1",
				new Map<number, unknown>([[0, eventsPage([streamEvent("e-0")], 0)]]),
			),
		);
		const session = makeSession(service);
		const { stub } = subscriberStub();
		const subscription = session
			.openConversation("conv-1")
			.subscribe(stub, { runId: "run-1", offset: 0 });
		await tick();
		const afterFirstStart = calls.length;

		for (let i = 0; i < 10; i += 1) subscription.start();
		await tick();
		await tick();

		// A second pump would issue its own readRunEvents immediately.
		const reads = calls.filter(
			(call) => call.path === "kernelRuntime/readRunEvents",
		).length;
		expect(calls.length).toBeLessThanOrEqual(afterFirstStart + 1);
		expect(reads).toBeLessThanOrEqual(2);
		subscription.dispose();
	});

	it("delivers scripted readRunEvents pages with exact durable offsets and stops on dispose", async () => {
		let releaseHang: ((value: unknown) => void) | null = null;
		const pages = new Map<number, unknown>([
			[0, eventsPage([streamEvent("e-0"), streamEvent("e-1")], 0)],
			[2, eventsPage([streamEvent("e-2")], 2)],
		]);
		const { service, calls } = mockApiService((path, input) => {
			const scripted = readOnlyHandler("run-1", pages)(path, input);
			if (
				path === "kernelRuntime/readRunEvents" &&
				(input as { offset: number }).offset === 3
			) {
				return new Promise((resolve) => {
					releaseHang = resolve;
				});
			}
			return scripted;
		});
		const session = makeSession(service);
		const { stub, frames, counters } = subscriberStub();

		const subscription = session
			.openConversation("conv-1")
			.subscribe(stub, { runId: "run-1", offset: 0 });
		expect(subscription).toBeInstanceOf(SubscriptionCap);
		expect(counters.dup).toBe(1);

		// Drain the pump: run resolution + two pages + arrival at the hang.
		while (releaseHang === null) await tick();
		expect(frames).toEqual([
			expect.objectContaining({
				conversationId: "conv-1",
				runId: "run-1",
				offset: 0,
				nextOffset: 1,
				event: expect.objectContaining({ id: "e-0" }),
			}),
			expect.objectContaining({
				offset: 1,
				nextOffset: 2,
				event: expect.objectContaining({ id: "e-1" }),
			}),
			expect.objectContaining({
				offset: 2,
				nextOffset: 3,
				event: expect.objectContaining({ id: "e-2" }),
			}),
		]);

		subscription.dispose();
		expect(subscription.isDisposed()).toBe(true);
		expect(counters.disposed).toBe(1);

		// A late page landing after dispose is dropped, not delivered.
		const callsBefore = calls.length;
		(releaseHang as unknown as (value: unknown) => void)(
			eventsPage([streamEvent("e-3")], 3),
		);
		await tick();
		await tick();
		expect(frames).toHaveLength(3);
		expect(calls.length).toBe(callsBefore);
	});

	it("follows the run created after the closed one, from its own offset 0", async () => {
		let runSetReads = 0;
		const { service } = mockApiService((path, input) => {
			if (path === "kernelRuntime/readRunSet") {
				runSetReads += 1;
				// Newest-first, exactly as readRunSet returns them.
				return runSetOutput([], ["run-2", "run-1"]);
			}
			if (path === "kernelRuntime/readRunEvents") {
				const { runId, offset } = input as { runId: string; offset: number };
				if (runId === "run-1" && offset === 5) {
					return eventsPage([streamEvent("e-a")], 5, true);
				}
				if (runId === "run-2" && offset === 0) {
					return eventsPage([streamEvent("e-b")], 0);
				}
				return new Promise(() => {});
			}
			throw new Error(`unexpected path ${path}`);
		});
		const session = makeSession(service);
		const { stub, frames } = subscriberStub();

		session
			.openConversation("conv-1")
			.subscribe(stub, { runId: "run-1", offset: 5 });
		while (frames.length < 2) await tick();

		expect(frames[0]).toMatchObject({
			runId: "run-1",
			offset: 5,
			nextOffset: 6,
		});
		expect(frames[1]).toMatchObject({
			runId: "run-2",
			offset: 0,
			nextOffset: 1,
		});
		// Exactly one run-set read: the cursor named run-1 directly, and the
		// rollover resolved run-2 by following the run set's ordering.
		expect(runSetReads).toBe(1);
	});

	it("never re-reads a closed run when no newer run exists", async () => {
		const readOffsets: number[] = [];
		const { service } = mockApiService((path, input) => {
			if (path === "kernelRuntime/readRunSet") {
				return runSetOutput([], ["run-1"]);
			}
			if (path === "kernelRuntime/readRunEvents") {
				const { offset } = input as { offset: number };
				readOffsets.push(offset);
				if (offset === 0) return eventsPage([streamEvent("e-a")], 0, true);
				return new Promise(() => {});
			}
			throw new Error(`unexpected path ${path}`);
		});
		// A 1ms sleep paces the idle poll; the assertion is about which reads
		// happen, not how often the run set is re-checked.
		const session = makeSession(service, {
			sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
		});
		const { stub, frames } = subscriberStub();

		const subscription = session
			.openConversation("conv-1")
			.subscribe(stub, { runId: "run-1", offset: 0 });
		while (frames.length < 1) await tick();
		for (let i = 0; i < 20; i++) await tick();
		subscription.dispose();

		// The pilot re-resolved "the current run", got the just-closed run-1
		// back, and re-read it from 0 forever. Exactly one read is correct.
		expect(readOffsets).toEqual([0]);
		expect(frames).toHaveLength(1);
	});

	it("snapshots the cursor's own run even when a newer run exists", async () => {
		const { service, calls } = mockApiService((path, input) => {
			if (path === "kernelRuntime/readRunSet") {
				return runSetOutput(["run-2"], ["run-2", "run-1"]);
			}
			if (path === "kernelRuntime/readRunEvents") {
				const { runId, offset } = input as { runId: string; offset: number };
				if (runId === "run-1" && offset === 5) {
					return eventsPage([streamEvent("e-tail")], 5, true);
				}
				return new Promise(() => {});
			}
			throw new Error(`unexpected path ${path}`);
		});
		// Finishing the cursor's run is what makes the following subscribe
		// gap-free; the pump rolls to run-2 from there.
		const snapshot = await makeSession(service)
			.openConversation("conv-1")
			.snapshot({ runId: "run-1", offset: 5 });
		expect(snapshot.runId).toBe("run-1");
		expect(snapshot.cursor).toEqual({ runId: "run-1", offset: 6 });
		expect(snapshot.events).toEqual([
			expect.objectContaining({ runId: "run-1", offset: 5, nextOffset: 6 }),
		]);
		// A named cursor resolves no run set at all.
		expect(calls.map((call) => call.path)).toEqual([
			"kernelRuntime/readRunEvents",
		]);
	});

	it("snapshots the current run from 0 when the client has no cursor", async () => {
		const { service } = mockApiService(
			readOnlyHandler(
				"run-1",
				new Map([[0, eventsPage([streamEvent("e")], 0)]]),
			),
		);
		const snapshot = await makeSession(service)
			.openConversation("conv-1")
			.snapshot();
		expect(snapshot.runId).toBe("run-1");
		expect(snapshot.cursor).toEqual({ runId: "run-1", offset: 1 });
	});

	it("skips a rejected delivery instead of ending the whole subscription", async () => {
		// A rejecting callback can leave the socket healthy. A single refusal is
		// not proof of a dead peer, and the browser has no subscription-end signal.
		let releaseHang: ((value: unknown) => void) | null = null;
		const pages = new Map<number, unknown>([
			[0, eventsPage([streamEvent("e-0")], 0)],
			[1, eventsPage([streamEvent("e-1")], 1)],
		]);
		const { service } = mockApiService((path, input) => {
			if (
				path === "kernelRuntime/readRunEvents" &&
				(input as { offset: number }).offset === 2
			) {
				return new Promise((resolve) => {
					releaseHang = resolve;
				});
			}
			return readOnlyHandler("run-1", pages)(path, input);
		});
		const session = makeSession(service);
		const delivered: string[] = [];
		let refusals = 0;
		const stub: CapnSubscriber = Object.assign(
			(frame: CapnEventFrame) => {
				if (refusals === 0) {
					refusals += 1;
					throw new Error("subscriber hiccup");
				}
				delivered.push((frame.event as { id: string }).id);
			},
			{ dup: (): CapnSubscriber => stub },
		);

		const subscription = session
			.openConversation("conv-1")
			.subscribe(stub, { runId: "run-1", offset: 0 });
		while (releaseHang === null) await tick();

		// e-0 was refused and skipped; the pump kept going and served e-1.
		expect(delivered).toEqual(["e-1"]);
		expect(subscription.isDisposed()).toBe(false);
		subscription.dispose();
	});

	it("presumes the subscriber gone only after repeated consecutive refusals", async () => {
		const pages = new Map<number, unknown>(
			Array.from({ length: SUBSCRIBE_MAX_CALLBACK_FAILURES }, (_, index) => [
				index,
				eventsPage([streamEvent(`e-${index}`)], index),
			]),
		);
		const { service } = mockApiService(readOnlyHandler("run-1", pages));
		const session = makeSession(service);
		let refusals = 0;
		const stub: CapnSubscriber = Object.assign(
			() => {
				refusals += 1;
				throw new Error("client gone");
			},
			{ dup: (): CapnSubscriber => stub },
		);

		const subscription = session
			.openConversation("conv-1")
			.subscribe(stub, { runId: "run-1", offset: 0 });
		while (!subscription.isDisposed()) await tick();
		expect(refusals).toBe(SUBSCRIBE_MAX_CALLBACK_FAILURES);
	});

	it("retries a failed poll turn rather than ending the subscription", async () => {
		// A malformed receipt is a validation failure INSIDE the pump, so it
		// bypasses callRpc's own retry and exercises the pump's ladder directly.
		let releaseHang: ((value: unknown) => void) | null = null;
		let reads = 0;
		const { service } = mockApiService((path, input) => {
			if (path === "kernelRuntime/readRunSet") {
				return runSetOutput(["run-1"]);
			}
			if (path !== "kernelRuntime/readRunEvents") {
				throw new Error(`unexpected path ${path}`);
			}
			const offset = (input as { offset: number }).offset;
			if (offset === 1) {
				return new Promise((resolve) => {
					releaseHang = resolve;
				});
			}
			reads += 1;
			if (reads <= 2) return { stream: { nope: true } };
			return eventsPage([streamEvent("e-0")], 0);
		});
		const session = makeSession(service);
		const { stub, frames } = subscriberStub();

		const subscription = session
			.openConversation("conv-1")
			.subscribe(stub, { runId: "run-1", offset: 0 });
		while (releaseHang === null) await tick();

		expect(reads).toBe(3); // two rejected turns, then the good one
		expect(frames).toHaveLength(1);
		expect(subscription.isDisposed()).toBe(false);
		subscription.dispose();
	});

	it("gives up after SUBSCRIBE_MAX_POLL_FAILURES consecutive failed turns", async () => {
		let reads = 0;
		const { service } = mockApiService((path) => {
			if (path === "kernelRuntime/readRunSet") return runSetOutput(["run-1"]);
			reads += 1;
			return { stream: { nope: true } };
		});
		const session = makeSession(service);
		const { stub, counters } = subscriberStub();

		const subscription = session
			.openConversation("conv-1")
			.subscribe(stub, { runId: "run-1", offset: 0 });
		while (!subscription.isDisposed()) await tick();
		expect(reads).toBe(SUBSCRIBE_MAX_POLL_FAILURES);
		expect(counters.disposed).toBe(1);
	});

	it("caps live subscriptions per session and frees a slot on dispose", () => {
		// Hang run resolution so every pump stays alive without further calls.
		const { service } = mockApiService(() => new Promise(() => {}));
		const session = makeSession(service);
		const conversation = session.openConversation("conv-1");

		const subscriptions = Array.from(
			{ length: CAPN_MAX_LIVE_SUBSCRIPTIONS },
			() => conversation.subscribe(subscriberStub().stub),
		);
		expect(() => conversation.subscribe(subscriberStub().stub)).toThrow(
			/Subscription limit exceeded/,
		);

		subscriptions[0]?.dispose();
		expect(() => conversation.subscribe(subscriberStub().stub)).not.toThrow();
	});

	it("session disposal ends every subscription and refuses further capability calls", () => {
		const { service } = mockApiService(() => new Promise(() => {}));
		const session = makeSession(service);
		const conversation = session.openConversation("conv-1");
		const first = subscriberStub();
		const second = subscriberStub();
		const subA = conversation.subscribe(first.stub);
		const subB = conversation.subscribe(second.stub);

		session[Symbol.dispose]();

		expect(subA.isDisposed()).toBe(true);
		expect(subB.isDisposed()).toBe(true);
		expect(first.counters.disposed).toBe(1);
		expect(second.counters.disposed).toBe(1);
		expect(() => session.openConversation("conv-2")).toThrow(/disposed/);
	});
});

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

const ORIGIN = "https://tedix.os.tedix.dev";

function upgradeRequest(headers: Record<string, string> = {}): Request {
	return new Request(`${ORIGIN}/capn`, {
		headers: {
			Upgrade: "websocket",
			Origin: ORIGIN,
			Cookie: "DS=abc",
			...headers,
		},
	});
}

describe("mountCapnChat refusals", () => {
	it("refuses a non-WebSocket request with 426 before any RPC wiring", async () => {
		const { service, calls } = mockApiService(() => ({}));
		const response = await mountCapnChat(
			new Request(`${ORIGIN}/capn`, { headers: { Origin: ORIGIN } }),
			{ API_SERVICE: service },
			"T-host-org",
		);
		expect(response.status).toBe(426);
		expect(calls).toHaveLength(0);
	});

	it("refuses a cross-origin upgrade with 403 before any RPC wiring", async () => {
		const { service, calls } = mockApiService(() => ({}));
		const response = await mountCapnChat(
			upgradeRequest({ Origin: "https://evil.tedix.dev" }),
			{ API_SERVICE: service },
			"T-host-org",
		);
		expect(response.status).toBe(403);
		expect(calls).toHaveLength(0);
	});

	it("refuses an upgrade carrying no Origin at all", async () => {
		const { service } = mockApiService(() => ({}));
		const request = new Request(`${ORIGIN}/capn`, {
			headers: { Upgrade: "websocket", Cookie: "DS=abc" },
		});
		const response = await mountCapnChat(
			request,
			{ API_SERVICE: service },
			"T-host-org",
		);
		expect(response.status).toBe(403);
	});

	it("refuses an upgrade whose host resolves to no tenant, before any RPC", async () => {
		// The HOSTNAME decides the organization on this lane. A host that
		// resolves to no Descope tenant used to fall through with the header
		// simply omitted, and apps/api then bound the session to the CALLER's
		// own default org — a session running in your organization from
		// someone else's hostname.
		const { service, calls } = mockApiService(() => ({}));
		const response = await mountCapnChat(
			upgradeRequest(),
			{ API_SERVICE: service },
			null,
		);
		expect(response.status).toBe(403);
		expect(calls).toHaveLength(0);
	});

	it("refuses 403 when the caller's own credentials cannot read in the host tenant", async () => {
		const { service, calls } = mockApiService((path) => {
			expect(path).toBe("kernelRuntime/listConversations");
			throw new Error("UNAUTHORIZED");
		});
		const response = await mountCapnChat(
			upgradeRequest(),
			{ API_SERVICE: service },
			"T-host-org",
		);
		expect(response.status).toBe(403);
		expect(await response.text()).toMatch(/do not have access/);
		// One authorization attempt, and no socket.
		expect(calls).toHaveLength(1);
	});

	it("refuses 503 without an API authority rather than opening an unauthorized socket", async () => {
		const response = await mountCapnChat(upgradeRequest(), {}, "T-host-org");
		expect(response.status).toBe(503);
	});

	// The SUCCESS path (authorize → 101 → a live session) needs a real
	// WebSocketPair and is asserted in capn-roundtrip.workerd.test.ts.
});

describe("mountCapnChat credential handling", () => {
	it("builds credential headers from the caller allowlist only", () => {
		const headers = buildCredentialHeaders(
			new Request(`${ORIGIN}/capn`, {
				headers: {
					Authorization: "Bearer user-token",
					Cookie: "DS=abc",
					"CF-Connecting-IP": "203.0.113.7",
					"X-Tedix-Tenant-Id": "T-attacker",
					"X-Anything-Else": "nope",
				},
			}),
		);
		// CF-Connecting-IP rides along so apps/api's byCredentialOrIp limiter
		// has a key: a service-binding subrequest carries no client IP, and
		// without it every capn-forwarded RPC shares one "unknown" bucket.
		//
		// Authorization is NOT forwarded. apps/api resolves an API key or tedi
		// JWT to that credential's own organization and never reads
		// X-Tedix-Tenant-Id, so forwarding one would let a caller open a
		// session on any tenant's hostname and run it in their own org —
		// inverting the host-binding invariant this lane depends on.
		expect(headers).toEqual({
			Cookie: "DS=abc",
			"CF-Connecting-IP": "203.0.113.7",
		});
		expect(headers.Authorization).toBeUndefined();
	});

	it("treats only the exact same origin as same-origin", () => {
		const cases: Array<[string | null, boolean]> = [
			[ORIGIN, true],
			["https://tedix.os.tedix.dev:443", true],
			["https://other.os.tedix.dev", false],
			["http://tedix.os.tedix.dev", false],
			["null", false],
			["", false],
			[null, false],
		];
		for (const [origin, expected] of cases) {
			const headers: Record<string, string> = { Upgrade: "websocket" };
			if (origin !== null) headers.Origin = origin;
			expect(
				isSameOriginUpgrade(new Request(`${ORIGIN}/capn`, { headers })),
			).toBe(expected);
		}
	});
});
