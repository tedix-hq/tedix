import {
	EMBEDDED_STREAM_CURSOR_REJECTED,
	EMBEDDED_STREAM_NOT_STARTED_EXPIRED,
} from "./embedded-contract";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	createEmbeddedClient,
	embeddedResumeWatermarkKey,
} from "./embedded-client";
import { createResumeWatermarkStore } from "./resume-watermark";
import type {
	EmbeddedSessionStub,
	EmbeddedTurnInput,
} from "./embedded-contract";
import type { RuntimeFrame } from "./runtime-frames";

function stub(stream: EmbeddedSessionStub["stream"]): EmbeddedSessionStub {
	return {
		ping: async () => undefined,
		readTranscript: async () => ({ messages: [] }),
		readCompletedTurn: async () => null,
		stream,
		cancel: async () => ({}),
		listApprovals: async () => ({}),
		requestApproval: async () => ({}),
		resolveApproval: async () => ({}),
		pin: async () => ({}),
		metrics: async () => undefined,
		callPortableTool: async () => ({}),
		rankPortableTools: async () => ({ rankedIds: null, receipt: null }),
		listConversationCapabilities: async () => ({
			attached: [],
			available: [],
			authority: "context_only",
		}),
		attachConversationCapability: async () => ({
			capability: {
				id: "11111111-1111-4111-8111-111111111111",
				capabilityId: "22222222-2222-4222-8222-222222222222",
				replayName: "research",
				name: "Research",
				slug: "research",
				whyPresent: { type: "user", actorId: "user-1", attachedAt: "now" },
				authority: "context_only",
			},
		}),
		detachConversationCapability: async (referenceId) => ({
			detached: true,
			referenceId,
		}),
		listConversationArtifactPins: async () => ({ pins: [] }),
		attachConversationArtifactPin: async () => ({
			pin: {
				id: "33333333-3333-4333-8333-333333333333",
				artifactId: "artifact-1",
				replayName: "approved_report",
				revision: { algorithm: "sha256", digest: "a".repeat(64) },
				artifact: {
					name: "Report",
					kind: "file",
					mimeType: "text/plain",
					uri: "r2://bucket/report",
				},
				state: "active",
				whyPresent: { type: "user", actorId: "user-1", attachedAt: "now" },
				authority: "context_only",
			},
		}),
		detachConversationArtifactPin: async (pinId) => ({ detached: true, pinId }),
	};
}

describe("embedded client replay", () => {
	it("forwards advisory portable discovery through the signed session", async () => {
		const rank = vi.fn(async () => ({
			rankedIds: ["acme.get_order", "acme.list_orders"],
			receipt: {
				executionId: "11111111-1111-4111-8111-111111111111",
				usagePersistence: "persisted" as const,
			},
		}));
		const client = createEmbeddedClient(
			async () => ({ streamUrl: "https://runtime.example", token: "signed" }),
			async () => ({ ...stub(async () => {}), rankPortableTools: rank }),
		);
		const input = {
			query: "find an order",
			callables: ["acme.list_orders", "acme.get_order"],
		};
		expect(await client.rankPortableTools(input)).toEqual({
			rankedIds: ["acme.get_order", "acme.list_orders"],
			receipt: {
				executionId: "11111111-1111-4111-8111-111111111111",
				usagePersistence: "persisted",
			},
		});
		expect(rank).toHaveBeenCalledExactlyOnceWith(input);
		client.dispose();
	});
	it("reauthenticates an expired transcript capability and reads without caller IDs", async () => {
		const read = vi.fn(async () => ({
			messages: [{ role: "assistant" as const, content: "Restored" }],
		}));
		let connections = 0;
		const credentials = vi.fn(async () => ({
			streamUrl: "https://runtime.example",
			token: "signed",
		}));
		const client = createEmbeddedClient(credentials, async () => ({
			...stub(async () => {}),
			readTranscript:
				++connections === 1
					? async () => {
							throw new Error("Session expired");
						}
					: read,
		}));
		expect(await client.readTranscript()).toEqual({
			messages: [{ role: "assistant", content: "Restored" }],
		});
		expect(credentials).toHaveBeenCalledTimes(2);
		expect(read).toHaveBeenCalledWith();
		client.dispose();
	});
	it("watches canonical approvals through the shared projection watcher", async () => {
		const session = {
			...stub(async () => {}),
			listApprovals: async () => ({ data: [{ id: "pending" }] }),
		};
		const client = createEmbeddedClient(
			async () => ({ streamUrl: "https://runtime.example", token: "signed" }),
			async () => session,
		);
		const delivered: unknown[] = [];
		const watcher = client.watchApprovals(
			(value) => {
				delivered.push(value);
			},
			{ idleMs: false },
		);
		await vi.waitFor(() => expect(delivered).toHaveLength(1));
		expect(delivered[0]).toEqual({ data: [{ id: "pending" }] });
		watcher.dispose();
		client.dispose();
	});

	it("commits complete frames only and resumes without resubmitting the turn", async () => {
		const inputs: EmbeddedTurnInput[] = [];
		const retries: Array<{ attempt: number; delayMs: number }> = [];
		const sessions = [
			stub(async (input, subscriber) => {
				inputs.push(input);
				await subscriber({ id: "run:1", event: { kind: "delta", text: "A" } });
				throw new Error("socket lost after a partial next frame");
			}),
			stub(async (input, subscriber) => {
				inputs.push(input);
				// A replay may include the last committed event. The client must not
				// duplicate it and must commit B before advancing its cursor.
				await subscriber({ id: "run:1", event: { kind: "delta", text: "A" } });
				await subscriber({ id: "run:2", event: { kind: "delta", text: "B" } });
				await subscriber({ id: "run:3", event: { kind: "done", text: "AB" } });
			}),
		];
		let connections = 0;
		const client = createEmbeddedClient(
			async () => ({
				streamUrl: "https://runtime.example/chat/stream",
				token: "signed",
			}),
			async () => sessions[connections++]!,
			{
				onRetry: ({ attempt, delayMs }) => retries.push({ attempt, delayMs }),
			},
		);
		let text = "";
		await client.stream(
			{ clientRequestId: "request_123", text: "hello" },
			async ({ event }) => {
				if (event.kind === "delta") text += String(event.text ?? "");
			},
		);
		expect(text).toBe("AB");
		expect(inputs).toEqual([
			{
				clientRequestId: "request_123",
				text: "hello",
				resume: false,
				lastEventId: undefined,
			},
			{
				clientRequestId: "request_123",
				text: "hello",
				resume: true,
				lastEventId: "run:1",
			},
		]);
		expect(retries).toEqual([{ attempt: 1, delayMs: 1000 }]);
		client.dispose();
	});
	it("reacquires after socket death and token expiry across rich operations", async () => {
		const broken: Array<(error: unknown) => void> = [];
		const operations: string[] = [];
		let expired = false;
		const first = {
			...stub(async () => {}),
			listApprovals: async () => ({ data: [{ id: "pending" }] }),
			onRpcBroken: (callback: (error: unknown) => void) =>
				broken.push(callback),
		};
		const second = {
			...stub(async (_input, subscriber) => {
				await subscriber({
					id: "run:1",
					event: {
						kind: "tool.completed",
						output: {
							resourceUri: "ui://widgets/mcp-app/acme/r/statuses.html",
						},
					},
				});
				await subscriber({ id: "run:2", event: { kind: "done" } });
			}),
			cancel: async () => {
				operations.push("cancel");
			},
			resolveApproval: async () => {
				operations.push("approval");
			},
			pin: async () => {
				operations.push("pin");
			},
			listApprovals: async () => {
				if (!expired) {
					expired = true;
					throw new Error("Session expired");
				}
				return { data: [] };
			},
		};
		const third = {
			...stub(async () => {}),
			listApprovals: async () => ({ data: [{ id: "refreshed" }] }),
		};
		const sessions = [first, second, third];
		const tokens: string[] = [];
		let connections = 0;
		const client = createEmbeddedClient(
			async () => {
				const token = `signed-${connections + 1}`;
				tokens.push(token);
				return { streamUrl: "https://runtime.example/chat/stream", token };
			},
			async () => sessions[connections++]!,
		);

		expect(await client.listApprovals()).toEqual({ data: [{ id: "pending" }] });
		broken[0]!(new Error("socket lost"));
		const projections: unknown[] = [];
		await client.stream(
			{ clientRequestId: "request_rich", text: "show statuses" },
			(frame) => {
				projections.push(frame.event);
			},
		);
		await client.cancel("request_rich");
		await client.resolveApproval("5eed0044-0000-4000-8000-000000000044", false);
		await client.pin("validated output");
		expect(await client.listApprovals()).toEqual({
			data: [{ id: "refreshed" }],
		});
		expect(operations).toEqual(["cancel", "approval", "pin"]);
		expect(projections).toContainEqual({
			kind: "tool.completed",
			output: { resourceUri: "ui://widgets/mcp-app/acme/r/statuses.html" },
		});
		expect(tokens).toEqual(["signed-1", "signed-2", "signed-3"]);
		client.dispose();
	});

	it("starts a fresh turn after explicit pre-dispatch expiry without resuming a nonexistent run", async () => {
		const inputs: EmbeddedTurnInput[] = [];
		let connections = 0;
		const sessions = [
			stub(async (input) => {
				inputs.push(input);
				throw new Error(EMBEDDED_STREAM_NOT_STARTED_EXPIRED);
			}),
			stub(async (input, deliver) => {
				inputs.push(input);
				await deliver({ id: "run:1", event: { kind: "done", text: "OK" } });
			}),
		];
		const credentials = vi.fn(async () => ({
			streamUrl: "https://runtime.example/chat/stream",
			token: "fresh",
		}));
		const client = createEmbeddedClient(
			credentials,
			async () => sessions[connections++]!,
		);
		await client.stream(
			{ clientRequestId: "idle-expiry", text: "read" },
			async () => {},
		);
		expect(
			inputs.map((input) => [input.resume, input.clientRequestId]),
		).toEqual([
			[false, "idle-expiry"],
			[false, "idle-expiry"],
		]);
		expect(credentials).toHaveBeenCalledTimes(2);
		client.dispose();
	});
	it("refreshes credentials and resumes by cursor when the capability expires mid-stream", async () => {
		const inputs: EmbeddedTurnInput[] = [];
		const retries: Array<{ attempt: number; delayMs: number }> = [];
		const sessions = [
			stub(async (input, subscriber) => {
				inputs.push(input);
				await subscriber({ id: "run:1", event: { kind: "delta", text: "A" } });
				await subscriber({ id: "run:2", event: { kind: "delta", text: "B" } });
				// The 10-minute credential ran out while the model was still writing.
				throw new Error("Session expired");
			}),
			stub(async (input, subscriber) => {
				inputs.push(input);
				// The runtime replays from the cursor; the last committed frame may
				// repeat and must be deduplicated by id.
				await subscriber({ id: "run:2", event: { kind: "delta", text: "B" } });
				await subscriber({ id: "run:3", event: { kind: "delta", text: "C" } });
				await subscriber({ id: "run:4", event: { kind: "done", text: "ABC" } });
			}),
		];
		const tokens: string[] = [];
		let connections = 0;
		const client = createEmbeddedClient(
			async () => {
				const token = `signed-${connections + 1}`;
				tokens.push(token);
				return { streamUrl: "https://runtime.example/chat/stream", token };
			},
			async () => sessions[connections++]!,
			{
				onRetry: ({ attempt, delayMs }) => retries.push({ attempt, delayMs }),
			},
		);
		let text = "";
		let done = false;
		const started = Date.now();
		await client.stream(
			{ clientRequestId: "request_exp", text: "long question" },
			async ({ event }) => {
				if (event.kind === "delta") text += String(event.text ?? "");
				if (event.kind === "done") done = true;
			},
		);
		expect(done).toBe(true);
		expect(text).toBe("ABC");
		expect(tokens).toEqual(["signed-1", "signed-2"]);
		expect(inputs.map((i) => [i.resume, i.lastEventId])).toEqual([
			[false, undefined],
			[true, "run:2"],
		]);
		// An expiry refresh is immediate and does not consume a retry slot.
		expect(retries).toEqual([{ attempt: 1, delayMs: 0 }]);
		expect(Date.now() - started).toBeLessThan(500);
		client.dispose();
	});
	it("only the first expiry is free; a second one falls back to the bounded retry ladder", async () => {
		const retries: Array<{ attempt: number; delayMs: number }> = [];
		const sessions = [
			stub(async (_input, subscriber) => {
				await subscriber({ id: "run:1", event: { kind: "delta", text: "A" } });
				throw new Error("Session expired");
			}),
			stub(async () => {
				throw new Error("Session expired");
			}),
			stub(async (_input, subscriber) => {
				await subscriber({ id: "run:2", event: { kind: "done", text: "A" } });
			}),
		];
		let connections = 0;
		const client = createEmbeddedClient(
			async () => ({ streamUrl: "https://runtime.example", token: "t" }),
			async () => sessions[connections++]!,
			{
				onRetry: ({ attempt, delayMs }) => retries.push({ attempt, delayMs }),
			},
		);
		const kinds: string[] = [];
		await client.stream(
			{ clientRequestId: "request_exp2", text: "q" },
			({ event }) => {
				kinds.push(String(event.kind));
			},
		);
		expect(kinds).toEqual(["delta", "done"]);
		expect(retries).toEqual([
			{ attempt: 1, delayMs: 0 },
			{ attempt: 1, delayMs: 1000 },
		]);
		client.dispose();
	});

	it("retries a recoverable terminal frame with the same idempotency key", async () => {
		const inputs: EmbeddedTurnInput[] = [];
		const delivered: string[] = [];
		const retries: Array<{ attempt: number; delayMs: number }> = [];
		const sessions = [
			stub(async (input, subscriber) => {
				inputs.push(input);
				await subscriber({
					id: null,
					event: {
						kind: "error",
						message: "stream_unavailable",
						recoverable: true,
					},
				});
			}),
			stub(async (input, subscriber) => {
				inputs.push(input);
				await subscriber({ id: "run:1", event: { kind: "delta", text: "A" } });
				await subscriber({ id: "run:2", event: { kind: "done", text: "A" } });
			}),
		];
		let connections = 0;
		const client = createEmbeddedClient(
			async () => ({ streamUrl: "https://runtime.example", token: "t" }),
			async () => sessions[connections++]!,
			{
				onRetry: ({ attempt, delayMs }) => retries.push({ attempt, delayMs }),
			},
		);
		await client.stream(
			{ clientRequestId: "request_recoverable", text: "q" },
			({ event }) => {
				delivered.push(String(event.kind));
			},
		);
		expect(delivered).toEqual(["delta", "done"]);
		expect(
			inputs.map(({ clientRequestId, resume }) => ({
				clientRequestId,
				resume,
			})),
		).toEqual([
			{ clientRequestId: "request_recoverable", resume: false },
			{ clientRequestId: "request_recoverable", resume: true },
		]);
		expect(retries).toEqual([{ attempt: 1, delayMs: 1000 }]);
		client.dispose();
	});

	it("does not retry a non-recoverable terminal frame", async () => {
		let connections = 0;
		const client = createEmbeddedClient(
			async () => ({ streamUrl: "https://runtime.example", token: "t" }),
			async () => {
				connections += 1;
				return stub(async (_input, subscriber) => {
					await subscriber({
						id: "run:error",
						event: { kind: "error", message: "policy_denied" },
					});
				});
			},
		);
		await expect(
			client.stream(
				{ clientRequestId: "request_terminal", text: "q" },
				() => undefined,
			),
		).rejects.toThrow("policy_denied");
		expect(connections).toBe(1);
		client.dispose();
	});
});

describe("session refresh is identity-checked", () => {
	/**
	 * `lease` is ONE mutable slot shared by `operation()` and `stream()`, and
	 * both refresh by releasing it and taking a new one. Releasing the LAST
	 * lease drops the hub refcount to zero and tears the socket down — which is
	 * how the next `session()` dials fresh, and is deliberate. Doing it to
	 * somebody else's lease is not: two concurrent expiries each released the
	 * lease the other had just acquired, so the hub was torn down twice and a
	 * freshly dialled socket was destroyed before anyone used it.
	 */
	it("a second concurrent expiry adopts the fresh session instead of destroying it", async () => {
		let connections = 0;
		const expired = new Set<number>();
		const client = createEmbeddedClient(
			async () => ({ streamUrl: "https://runtime.example", token: "t" }),
			async () => {
				const index = connections++;
				return {
					...stub(async () => {}),
					// Both callers hit expiry on the FIRST session; the second must
					// serve them both rather than being torn down by the loser.
					listApprovals: async () => {
						if (index === 0) {
							expired.add(index);
							throw new Error("Session expired");
						}
						return { data: [index] };
					},
				};
			},
		);
		const [a, b] = await Promise.all([
			client.listApprovals(),
			client.listApprovals(),
		]);
		expect(a).toEqual({ data: [1] });
		expect(b).toEqual({ data: [1] });
		// One refresh, not one per caller: without the identity check the second
		// release tore down the session the first had just dialled, forcing a third.
		expect(connections).toBe(2);
		client.dispose();
	});

	/**
	 * The `disposed` guard in `operation()` is only REACHABLE when a call is in
	 * flight across dispose and then fails with the server's exact expiry signal:
	 * an operation started after dispose rejects at `used.session()` with the
	 * lease-released error, which is not "Session expired" and returns before the
	 * guard. That reachability is why a test written the naive way (dispose, then
	 * call) passes with and without the guard — it never exercises the line.
	 *
	 * Driving the call to park mid-flight, disposing, and only THEN expiring
	 * distinguishes it: with the guard the expiry is re-thrown and no socket is
	 * dialled; without it `refreshLease()` re-leases the hub and dials a second
	 * session nobody will read or close.
	 */
	it("an expiry that lands after dispose does not re-lease the hub or redial", async () => {
		let connections = 0;
		let expireFirstCall: ((error: unknown) => void) | undefined;
		const client = createEmbeddedClient(
			async () => ({ streamUrl: "https://runtime.example", token: "t" }),
			async () => {
				const index = connections++;
				return {
					...stub(async () => {}),
					// The first session's call is held open until the client is
					// disposed, then fails with the exact expiry signal. A redial after
					// dispose would dial this second session — the socket nobody reads.
					listApprovals: () =>
						index === 0
							? new Promise((_resolve, reject) => {
									expireFirstCall = reject;
								})
							: Promise.resolve({ data: [index] }),
				};
			},
		);
		// Start the call: it dials session #0, enters listApprovals, and parks on
		// the deferred while still holding the live lease.
		const pending = client.listApprovals();
		await vi.waitFor(() => expect(typeof expireFirstCall).toBe("function"));
		// The consumer goes away while the call is still in flight...
		client.dispose();
		// ...and only then does the capability expire.
		expireFirstCall!(new Error("Session expired"));
		// The post-dispose expiry surfaces as the expiry error and must NOT trigger
		// a re-lease: without the guard, refreshLease() re-dials, connections climbs
		// to 2, and the call resolves with the second session instead.
		await expect(pending).rejects.toThrow("Session expired");
		expect(connections).toBe(1);
		client.dispose();
	});
});

it("settles an in-flight consumer before reconnecting after socket failure", async () => {
	let attempts = 0;
	let release!: () => void;
	let started!: () => void;
	const consuming = new Promise<void>((resolve) => {
		started = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const inputs: Array<{ resume?: boolean; lastEventId?: string }> = [];
	const client = createEmbeddedClient(
		async () => ({ streamUrl: "https://runtime.example", token: "signed" }),
		async () =>
			stub(async (input, deliver) => {
				inputs.push(input);
				if (++attempts === 1) {
					void Promise.resolve(
						deliver({ id: "run:0", event: { kind: "delta", text: "A" } }),
					).catch(() => {});
					await consuming;
					throw new Error("Socket disconnected");
				}
				await deliver({ id: "run:0", event: { kind: "delta", text: "A" } });
				await deliver({ id: "run:1", event: { kind: "done", text: "A" } });
			}),
	);
	const seen: string[] = [];
	try {
		const run = client.stream(
			{ clientRequestId: "drain-before-retry", text: "hello" },
			async (frame) => {
				if (frame.event.kind === "delta") {
					started();
					await gate;
				}
				seen.push(frame.id!);
			},
		);
		await consuming;
		await new Promise((resolve) => setTimeout(resolve, 1100));
		expect(attempts).toBe(1);
		release();
		await run;
		expect(seen).toEqual(["run:0", "run:1"]);
		expect(inputs[1]).toMatchObject({ resume: true, lastEventId: "run:0" });
	} finally {
		client.dispose();
	}
});

describe("embedded stream cancellation during reconnect", () => {
	it("settles immediately during backoff without redialing or redispatching", async () => {
		vi.useFakeTimers();
		let notifyRetry!: () => void;
		const retryStarted = new Promise<void>((resolve) => {
			notifyRetry = resolve;
		});
		const connect = vi.fn(async () =>
			stub(async () => {
				throw new Error("connection closed");
			}),
		);
		const client = createEmbeddedClient(
			async () => ({ streamUrl: "https://runtime.example", token: "signed" }),
			connect,
			{ onRetry: () => notifyRetry() },
		);
		const controller = new AbortController();
		try {
			const turn = client.stream(
				{ clientRequestId: "cancel-backoff", text: "hello" },
				async () => {},
				controller.signal,
			);
			const rejected = expect(turn).rejects.toMatchObject({
				name: "AbortError",
			});
			await retryStarted;
			controller.abort();
			await rejected;
			await vi.advanceTimersByTimeAsync(10_000);
			expect(connect).toHaveBeenCalledTimes(1);
		} finally {
			client.dispose();
			vi.useRealTimers();
		}
	});

	it("keeps cancellation classification when the in-flight socket reports a network error", async () => {
		const controller = new AbortController();
		let rejectStream!: (error: Error) => void;
		let notifyStream!: () => void;
		const started = new Promise<void>((resolve) => {
			notifyStream = resolve;
		});
		const connect = vi.fn(async () =>
			stub(async () => {
				notifyStream();
				return new Promise<void>((_, reject) => {
					rejectStream = reject;
				});
			}),
		);
		const client = createEmbeddedClient(
			async () => ({ streamUrl: "https://runtime.example", token: "signed" }),
			connect,
		);
		try {
			const turn = client.stream(
				{ clientRequestId: "cancel-inflight", text: "hello" },
				async () => {},
				controller.signal,
			);
			const rejected = expect(turn).rejects.toMatchObject({
				name: "AbortError",
			});
			await started;
			controller.abort();
			rejectStream(new Error("connection closed"));
			await rejected;
			expect(connect).toHaveBeenCalledTimes(1);
		} finally {
			client.dispose();
		}
	});
});

// ---------------------------------------------------------------------------
// Resume watermarks ACROSS stream() invocations
// ---------------------------------------------------------------------------

const credentials = async () => ({
	streamUrl: "https://runtime.example",
	token: "signed",
});

/**
 * Drive one `stream()` invocation to its rejection.
 *
 * The retry loop only leaves through `done` or an exhausted budget, and the
 * budget costs 1+2+4+8s of backoff, so the clock is faked rather than waited.
 */
async function exhaust(turn: Promise<void>, message: string | RegExp) {
	const rejected = expect(turn).rejects.toThrow(message);
	await vi.advanceTimersByTimeAsync(30_000);
	await rejected;
}

describe("exact completed-turn recovery", () => {
	it("delivers the current request's durable answer after reconnects exhaust", async () => {
		vi.useFakeTimers();
		const inputs: EmbeddedTurnInput[] = [];
		const readCompletedTurn = vi.fn(async (id: string) =>
			id === "request-current" ? { text: "Current answer" } : null,
		);
		const client = createEmbeddedClient(credentials, async () => ({
			...stub(async (input) => {
				inputs.push(input);
				throw new Error("Socket disconnected");
			}),
			readCompletedTurn,
		}));
		const events: RuntimeFrame["event"][] = [];
		try {
			const turn = client.stream(
				{ clientRequestId: "request-current", text: "same question" },
				(frame) => {
					events.push(frame.event);
				},
			);
			const resolved = expect(turn).resolves.toBeUndefined();
			await vi.advanceTimersByTimeAsync(30_000);
			await resolved;
			expect(inputs).toHaveLength(5);
			expect(
				inputs.map((input) => [input.clientRequestId, input.resume]),
			).toEqual([
				["request-current", false],
				...[1, 2, 3, 4].map(() => ["request-current", true]),
			]);
			expect(readCompletedTurn).toHaveBeenCalledExactlyOnceWith(
				"request-current",
			);
			expect(events).toEqual([{ kind: "done", text: "Current answer" }]);
		} finally {
			client.dispose();
			vi.useRealTimers();
		}
	});

	it("keeps a genuine failure explicit instead of borrowing an older identical answer", async () => {
		vi.useFakeTimers();
		const readTranscript = vi.fn(async () => ({
			messages: [{ role: "assistant" as const, content: "Older answer" }],
		}));
		const readCompletedTurn = vi.fn(async () => null);
		const client = createEmbeddedClient(credentials, async () => ({
			...stub(async () => {
				throw new Error("Socket disconnected");
			}),
			readTranscript,
			readCompletedTurn,
		}));
		const events: RuntimeFrame["event"][] = [];
		try {
			await exhaust(
				client.stream(
					{ clientRequestId: "request-new", text: "same question" },
					(frame) => {
						events.push(frame.event);
					},
				),
				"Socket disconnected",
			);
			expect(readCompletedTurn).toHaveBeenCalledExactlyOnceWith("request-new");
			expect(readTranscript).not.toHaveBeenCalled();
			expect(events).toEqual([]);
		} finally {
			client.dispose();
			vi.useRealTimers();
		}
	});

	it("does not turn a cancellation during the receipt read into success", async () => {
		vi.useFakeTimers();
		let receiptStarted!: () => void;
		let finishReceipt!: (value: { text: string }) => void;
		const started = new Promise<void>((resolve) => {
			receiptStarted = resolve;
		});
		const readCompletedTurn = vi.fn(
			() =>
				new Promise<{ text: string }>((resolve) => {
					finishReceipt = resolve;
					receiptStarted();
				}),
		);
		const client = createEmbeddedClient(credentials, async () => ({
			...stub(async () => {
				throw new Error("Socket disconnected");
			}),
			readCompletedTurn,
		}));
		const controller = new AbortController();
		const events: RuntimeFrame["event"][] = [];
		try {
			const turn = client.stream(
				{ clientRequestId: "request-cancel", text: "question" },
				(frame) => {
					events.push(frame.event);
				},
				controller.signal,
			);
			const rejected = expect(turn).rejects.toMatchObject({
				name: "AbortError",
			});
			await vi.advanceTimersByTimeAsync(30_000);
			await started;
			controller.abort();
			finishReceipt({ text: "Answer after cancellation" });
			await rejected;
			expect(events).toEqual([]);
		} finally {
			client.dispose();
			vi.useRealTimers();
		}
	});
});

describe("embedded resume watermark across stream() invocations", () => {
	it("resumes the second invocation from the cursor the first parked", async () => {
		vi.useFakeTimers();
		const inputs: EmbeddedTurnInput[] = [];
		let live = true;
		const client = createEmbeddedClient(credentials, async () =>
			stub(async (input, deliver) => {
				inputs.push(input);
				if (live) {
					// The subscription ends EARLY with the run still in flight: pages
					// drained, subscribe resolved, nothing threw. That is the store's
					// clean settle, and the position it reached is trustworthy.
					if (!input.lastEventId) {
						await deliver({
							id: "run:1",
							event: { kind: "delta", text: "A" },
						});
						await deliver({
							id: "run:2",
							event: { kind: "delta", text: "B" },
						});
					}
					return;
				}
				await deliver({ id: "run:3", event: { kind: "done", text: "AB" } });
			}),
		);
		const seen: string[] = [];
		const record = async (frame: RuntimeFrame) => {
			seen.push(frame.id!);
		};
		try {
			await exhaust(
				client.stream({ clientRequestId: "turn-a", text: "hi" }, record),
				"Subscription ended before completion",
			);
			expect(seen).toEqual(["run:1", "run:2"]);
			// Every within-turn re-dial resumed from the live cursor, unchanged.
			expect(inputs.slice(1)).toEqual(
				Array.from({ length: 4 }, () => ({
					clientRequestId: "turn-a",
					text: "hi",
					resume: true,
					lastEventId: "run:2",
				})),
			);
			live = false;
			await client.stream({ clientRequestId: "turn-a", text: "hi" }, record);
			// The successor did NOT re-open cold: it offered the parked cursor.
			expect(inputs.at(-1)).toMatchObject({
				resume: true,
				lastEventId: "run:2",
			});
			expect(seen).toEqual(["run:1", "run:2", "run:3"]);
		} finally {
			client.dispose();
			vi.useRealTimers();
		}
	});

	it("opens cold after an unclean session rather than parking its position", async () => {
		vi.useFakeTimers();
		const inputs: EmbeddedTurnInput[] = [];
		let live = true;
		const client = createEmbeddedClient(credentials, async () =>
			stub(async (input, deliver) => {
				inputs.push(input);
				if (live) {
					if (!input.lastEventId)
						await deliver({
							id: "run:1",
							event: { kind: "delta", text: "A" },
						});
					// A dead socket: the subscribe never resolved. "We reached run:1"
					// is not a claim the next invocation may resume on.
					throw new Error("Socket disconnected");
				}
				await deliver({ id: "run:1", event: { kind: "done", text: "A" } });
			}),
		);
		try {
			await exhaust(
				client.stream(
					{ clientRequestId: "turn-b", text: "hi" },
					async () => {},
				),
				"Socket disconnected",
			);
			live = false;
			await client.stream(
				{ clientRequestId: "turn-b", text: "hi" },
				async () => {},
			);
			expect(inputs.at(-1)).toEqual({
				clientRequestId: "turn-b",
				text: "hi",
				resume: false,
				lastEventId: undefined,
			});
		} finally {
			client.dispose();
			vi.useRealTimers();
		}
	});

	it("never delivers a frame twice across the invocation seam", async () => {
		vi.useFakeTimers();
		let live = true;
		const client = createEmbeddedClient(credentials, async () =>
			stub(async (input, deliver) => {
				if (live) {
					if (!input.lastEventId) {
						await deliver({
							id: "run:1",
							event: { kind: "delta", text: "A" },
						});
						await deliver({
							id: "run:2",
							event: { kind: "delta", text: "B" },
						});
					}
					return;
				}
				// A replay may re-send the frame the cursor names. The successor
				// must swallow it exactly as a within-turn re-dial does.
				await deliver({ id: "run:2", event: { kind: "delta", text: "B" } });
				await deliver({ id: "run:3", event: { kind: "done", text: "AB" } });
			}),
		);
		const seen: string[] = [];
		const record = async (frame: RuntimeFrame) => {
			seen.push(frame.id!);
		};
		try {
			await exhaust(
				client.stream({ clientRequestId: "turn-c", text: "hi" }, record),
				"Subscription ended before completion",
			);
			live = false;
			await client.stream({ clientRequestId: "turn-c", text: "hi" }, record);
			expect(seen).toEqual(["run:1", "run:2", "run:3"]);
		} finally {
			client.dispose();
			vi.useRealTimers();
		}
	});

	it("drops a parked cursor the server refuses and re-opens cold for free", async () => {
		vi.useFakeTimers();
		const inputs: EmbeddedTurnInput[] = [];
		const retries: number[] = [];
		let live = true;
		const client = createEmbeddedClient(
			credentials,
			async () =>
				stub(async (input, deliver) => {
					inputs.push(input);
					if (live) {
						if (!input.lastEventId)
							await deliver({
								id: "run:1",
								event: { kind: "delta", text: "A" },
							});
						return;
					}
					// The parked run stopped resolving: the capability refuses the
					// cursor because it does not belong to the run it derived.
					if (input.lastEventId)
						throw new Error(EMBEDDED_STREAM_CURSOR_REJECTED);
					await deliver({ id: "new:1", event: { kind: "done", text: "A" } });
				}),
			{ onRetry: ({ delayMs }) => retries.push(delayMs) },
		);
		try {
			await exhaust(
				client.stream(
					{ clientRequestId: "turn-d", text: "hi" },
					async () => {},
				),
				"Subscription ended before completion",
			);
			live = false;
			retries.length = 0;
			await client.stream(
				{ clientRequestId: "turn-d", text: "hi" },
				async () => {},
			);
			// One free re-dial (no backoff), then a cold open.
			expect(retries).toEqual([0]);
			expect(inputs.at(-2)).toMatchObject({
				resume: true,
				lastEventId: "run:1",
			});
			expect(inputs.at(-1)).toEqual({
				clientRequestId: "turn-d",
				text: "hi",
				resume: false,
				lastEventId: undefined,
			});
		} finally {
			client.dispose();
			vi.useRealTimers();
		}
	});

	it("keys watermarks per conversation so one scope cannot seed another", async () => {
		vi.useFakeTimers();
		// The dangerous shape: ONE store shared by two tenants' clients, whose
		// turns happen to carry the same client request id.
		const watermarks = createResumeWatermarkStore<string>();
		const inputs: { a: EmbeddedTurnInput[]; b: EmbeddedTurnInput[] } = {
			a: [],
			b: [],
		};
		const build = (scope: "a" | "b", live: () => boolean) =>
			createEmbeddedClient(
				credentials,
				async () =>
					stub(async (input, deliver) => {
						inputs[scope].push(input);
						if (live()) {
							if (!input.lastEventId)
								await deliver({
									id: `${scope}:1`,
									event: { kind: "delta", text: "A" },
								});
							return;
						}
						await deliver({
							id: `${scope}:9`,
							event: { kind: "done", text: "A" },
						});
					}),
				{},
				{ resumeWatermarks: watermarks, resumeScope: `tenant-${scope}` },
			);
		let liveA = true;
		const clientA = build("a", () => liveA);
		const clientB = build("b", () => false);
		try {
			await exhaust(
				clientA.stream(
					{ clientRequestId: "shared-id", text: "hi" },
					async () => {},
				),
				"Subscription ended before completion",
			);
			expect(
				watermarks.peek(embeddedResumeWatermarkKey("tenant-a", "shared-id")),
			).toBe("a:1");
			// The other tenant's client, same request id: it must open COLD.
			await clientB.stream(
				{ clientRequestId: "shared-id", text: "hi" },
				async () => {},
			);
			expect(inputs.b).toEqual([
				{
					clientRequestId: "shared-id",
					text: "hi",
					resume: false,
					lastEventId: undefined,
				},
			]);
			// And A's watermark is still its own.
			liveA = false;
			await clientA.stream(
				{ clientRequestId: "shared-id", text: "hi" },
				async () => {},
			);
			expect(inputs.a.at(-1)).toMatchObject({
				resume: true,
				lastEventId: "a:1",
			});
		} finally {
			clientA.dispose();
			clientB.dispose();
			vi.useRealTimers();
		}
	});

	it("keeps a default store private to one client, with no cross-client seeding", async () => {
		vi.useFakeTimers();
		const inputs: EmbeddedTurnInput[] = [];
		const connect = async () =>
			stub(async (input, deliver) => {
				inputs.push(input);
				if (!input.lastEventId)
					await deliver({ id: "run:1", event: { kind: "delta", text: "A" } });
			});
		const first = createEmbeddedClient(credentials, connect);
		const second = createEmbeddedClient(credentials, connect);
		try {
			await exhaust(
				first.stream(
					{ clientRequestId: "same-id", text: "hi" },
					async () => {},
				),
				"Subscription ended before completion",
			);
			inputs.length = 0;
			await exhaust(
				second.stream(
					{ clientRequestId: "same-id", text: "hi" },
					async () => {},
				),
				"Subscription ended before completion",
			);
			expect(inputs[0]).toEqual({
				clientRequestId: "same-id",
				text: "hi",
				resume: false,
				lastEventId: undefined,
			});
		} finally {
			first.dispose();
			second.dispose();
			vi.useRealTimers();
		}
	});
});
