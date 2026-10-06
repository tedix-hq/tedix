import { describe, expect, it, vi } from "vite-plus/test";
import {
	isMcpTaskNotFoundError,
	McpTaskResponseError,
	type McpTaskMethod,
	pollMcpTask,
} from "./task-polling";
import { McpTaskError } from "./tasks";

type Call = { method: McpTaskMethod; params: Record<string, unknown> };

const ISO = "2026-09-29T00:00:00.000Z";

function state(
	status: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		resultType: "complete",
		taskId: "t1",
		status,
		createdAt: ISO,
		lastUpdatedAt: ISO,
		ttlMs: null,
		...extra,
	};
}

/**
 * Scripted server: `tasks/get` answers come from `gets` in order (a function
 * entry may throw); update/cancel acknowledge. A virtual clock advances only
 * through `sleep`, so waits are observable and tests run instantly.
 */
function harness(
	gets: Array<Record<string, unknown> | (() => never)>,
	opts: { onGet?: (index: number) => void } = {},
) {
	const calls: Call[] = [];
	const sleeps: number[] = [];
	let clock = 0;
	let getIndex = 0;
	const request = vi.fn(
		async (method: McpTaskMethod, params: Record<string, unknown>) => {
			calls.push({ method, params });
			if (method === "tasks/get") {
				const index = getIndex++;
				opts.onGet?.(index);
				const next = gets[Math.min(index, gets.length - 1)];
				if (typeof next === "function") return next();
				return next;
			}
			return { resultType: "complete" };
		},
	);
	return {
		calls,
		sleeps,
		request,
		now: () => clock,
		sleep: async (ms: number) => {
			sleeps.push(ms);
			clock += ms;
		},
	};
}

describe("pollMcpTask backoff", () => {
	it("honours the server hint clamped to [min, max] and the default without one", async () => {
		const h = harness([
			state("working", { pollIntervalMs: 10 }),
			state("working", { pollIntervalMs: 60_000 }),
			state("working"),
			state("completed", { result: { content: [] } }),
		]);
		const outcome = await pollMcpTask({
			taskId: "t1",
			request: h.request,
			sleep: h.sleep,
			now: h.now,
			minIntervalMs: 100,
			maxIntervalMs: 3_000,
			defaultIntervalMs: 700,
		});
		expect(outcome.status).toBe("completed");
		expect(h.sleeps).toEqual([100, 3_000, 700]);
	});

	it("uses the shared defaults (500 ms default, 2 s cap)", async () => {
		const h = harness([
			state("working"),
			state("working", { pollIntervalMs: 9_000 }),
			state("completed", { result: {} }),
		]);
		await pollMcpTask({
			taskId: "t1",
			request: h.request,
			sleep: h.sleep,
			now: h.now,
		});
		expect(h.sleeps).toEqual([500, 2_000]);
	});

	it("returns timeout with the last state when the wall-clock budget runs out", async () => {
		const h = harness([state("working", { pollIntervalMs: 1_000 })]);
		const outcome = await pollMcpTask({
			taskId: "t1",
			request: h.request,
			sleep: h.sleep,
			now: h.now,
			timeoutMs: 3_000,
		});
		expect(outcome).toMatchObject({
			status: "timeout",
			state: { status: "working" },
		});
		expect(h.calls.filter((c) => c.method === "tasks/get")).toHaveLength(3);
	});

	it("returns timeout when maxAttempts is exhausted", async () => {
		const h = harness([state("working")]);
		const outcome = await pollMcpTask({
			taskId: "t1",
			request: h.request,
			sleep: h.sleep,
			now: h.now,
			maxAttempts: 2,
		});
		expect(outcome.status).toBe("timeout");
		expect(h.calls).toHaveLength(2);
	});

	it("treats an unknown status as non-terminal", async () => {
		const h = harness([state("queued"), state("completed", { result: {} })]);
		const outcome = await pollMcpTask({
			taskId: "t1",
			request: h.request,
			sleep: h.sleep,
			now: h.now,
		});
		expect(outcome.status).toBe("completed");
		expect(h.sleeps).toEqual([500]);
	});
});

describe("pollMcpTask terminal states", () => {
	it("returns the completed result record", async () => {
		const h = harness([state("completed", { result: { answer: 42 } })]);
		const outcome = await pollMcpTask({ taskId: "t1", request: h.request });
		expect(outcome).toMatchObject({
			status: "completed",
			result: { answer: 42 },
		});
	});

	it("falls back to the state when a completed task has no result record", async () => {
		const h = harness([{ taskId: "t1", status: "completed" }]);
		const outcome = await pollMcpTask({ taskId: "t1", request: h.request });
		expect(outcome).toMatchObject({
			status: "completed",
			result: { taskId: "t1", status: "completed" },
		});
	});

	it.each(["failed", "cancelled"] as const)(
		"returns %s as an outcome without throwing",
		async (status) => {
			const h = harness([
				state(status, { error: { code: -32_603, message: "boom" } }),
			]);
			const outcome = await pollMcpTask({ taskId: "t1", request: h.request });
			expect(outcome).toMatchObject({ status, state: { status } });
		},
	);

	it("strict mode rejects schema drift; lenient mode accepts it", async () => {
		const drift = { taskId: "t1", status: "completed", result: {} };
		await expect(
			pollMcpTask({
				taskId: "t1",
				request: harness([drift]).request,
				strict: true,
			}),
		).rejects.toBeInstanceOf(McpTaskResponseError);
		await expect(
			pollMcpTask({ taskId: "t1", request: harness([drift]).request }),
		).resolves.toMatchObject({ status: "completed" });
	});

	it("strict mode validates the tasks/update acknowledgement", async () => {
		const request = vi.fn(async (method: McpTaskMethod) =>
			method === "tasks/get"
				? state("input_required", { inputRequests: { a: {} } })
				: { unexpected: true },
		);
		await expect(
			pollMcpTask({
				taskId: "t1",
				request,
				strict: true,
				resolveInput: () => ({ a: { action: "accept" } }),
			}),
		).rejects.toThrow(/tasks\/update returned an invalid/);
	});
});

describe("pollMcpTask not-found", () => {
	const notFound = () => {
		throw new McpTaskError(-32_602, "Task not found", { taskId: "t1" });
	};

	it("propagates task-not-found by default", async () => {
		const h = harness([notFound]);
		await expect(
			pollMcpTask({ taskId: "t1", request: h.request, now: h.now }),
		).rejects.toThrow("Task not found");
	});

	it("treats task-not-found as working inside the grace window", async () => {
		const h = harness([notFound, notFound, state("completed", { result: {} })]);
		const outcome = await pollMcpTask({
			taskId: "t1",
			request: h.request,
			sleep: h.sleep,
			now: h.now,
			notFoundGraceMs: 10_000,
			defaultIntervalMs: 1_500,
		});
		expect(outcome.status).toBe("completed");
		expect(h.sleeps).toEqual([1_500, 1_500]);
	});

	it("propagates task-not-found once the grace window has elapsed", async () => {
		const h = harness([notFound]);
		await expect(
			pollMcpTask({
				taskId: "t1",
				request: h.request,
				sleep: h.sleep,
				now: h.now,
				notFoundGraceMs: 1_000,
				defaultIntervalMs: 600,
			}),
		).rejects.toThrow("Task not found");
		expect(h.sleeps).toEqual([600, 600]);
	});

	it("never treats other errors as not-found", async () => {
		const h = harness([
			() => {
				throw new Error("MCP error -32601: Method not found: tasks/get");
			},
		]);
		await expect(
			pollMcpTask({
				taskId: "t1",
				request: h.request,
				now: h.now,
				notFoundGraceMs: 60_000,
			}),
		).rejects.toThrow("Method not found");
		expect(h.calls).toHaveLength(1);
	});

	it("classifies the canonical error in every wire shape", () => {
		expect(isMcpTaskNotFoundError(McpTaskError.notFound("t1"))).toBe(true);
		expect(
			isMcpTaskNotFoundError({ code: -32_602, message: "not found" }),
		).toBe(true);
		expect(
			isMcpTaskNotFoundError(
				new Error(
					'MCP tasks/get error: {"code":-32602,"message":"Task not found"}',
				),
			),
		).toBe(true);
		expect(
			isMcpTaskNotFoundError(
				new Error("wrapped", { cause: McpTaskError.notFound("t1") }),
			),
		).toBe(true);
		expect(
			isMcpTaskNotFoundError({ code: -32_602, message: "Invalid params" }),
		).toBe(false);
		expect(
			isMcpTaskNotFoundError({ code: -32_601, message: "Method not found" }),
		).toBe(false);
	});
});

describe("pollMcpTask cancellation", () => {
	it("cancels upstream and rejects when the signal aborts mid-poll", async () => {
		const controller = new AbortController();
		const h = harness([state("working", { pollIntervalMs: 5 })], {
			onGet: (index) => {
				if (index === 1) controller.abort();
			},
		});
		await expect(
			pollMcpTask({
				taskId: "t1",
				request: h.request,
				sleep: h.sleep,
				now: h.now,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(h.calls.map((c) => c.method)).toEqual([
			"tasks/get",
			"tasks/get",
			"tasks/cancel",
		]);
		// The cancel must not ride the aborted signal.
		expect(h.request).toHaveBeenLastCalledWith("tasks/cancel", {
			taskId: "t1",
		});
	});

	it("cancels without polling when already aborted, and prefers an Error reason", async () => {
		const controller = new AbortController();
		const reason = new Error("turn aborted");
		controller.abort(reason);
		const h = harness([state("working")]);
		await expect(
			pollMcpTask({
				taskId: "t1",
				request: h.request,
				signal: controller.signal,
			}),
		).rejects.toBe(reason);
		expect(h.calls.map((c) => c.method)).toEqual(["tasks/cancel"]);
	});

	it("cancels when a request fails because the signal aborted", async () => {
		const controller = new AbortController();
		const h = harness([
			() => {
				controller.abort();
				throw new DOMException("fetch aborted", "AbortError");
			},
		]);
		await expect(
			pollMcpTask({
				taskId: "t1",
				request: h.request,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(h.calls.map((c) => c.method)).toEqual(["tasks/get", "tasks/cancel"]);
	});

	it("does not cancel a task that is already terminal when the abort lands", async () => {
		const controller = new AbortController();
		const h = harness([state("completed", { result: { ok: true } })], {
			onGet: () => controller.abort(),
		});
		const outcome = await pollMcpTask({
			taskId: "t1",
			request: h.request,
			signal: controller.signal,
		});
		expect(outcome.status).toBe("completed");
		expect(h.calls.map((c) => c.method)).toEqual(["tasks/get"]);
	});

	it("swallows cancel failures through onCancelError", async () => {
		const controller = new AbortController();
		controller.abort();
		const onCancelError = vi.fn();
		const request = vi.fn(async () => {
			throw new Error("cancel 500");
		});
		await expect(
			pollMcpTask({
				taskId: "t1",
				request,
				signal: controller.signal,
				onCancelError,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(onCancelError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "cancel 500" }),
		);
	});
});

describe("pollMcpTask input_required rounds", () => {
	it("answers only newly observed requests across rounds, then completes", async () => {
		const h = harness([
			state("input_required", { inputRequests: { a: { q: 1 } } }),
			// `a` is still listed while the server processes it: not re-offered.
			state("input_required", {
				inputRequests: { a: { q: 1 }, b: { q: 2 } },
			}),
			state("input_required", { inputRequests: { a: {}, b: {} } }),
			state("completed", { result: { done: true } }),
		]);
		const resolveInput = vi.fn(
			({ inputRequests }: { inputRequests: Record<string, unknown> }) =>
				Object.fromEntries(
					Object.keys(inputRequests).map((id) => [id, { action: "accept" }]),
				),
		);
		const outcome = await pollMcpTask({
			taskId: "t1",
			request: h.request,
			sleep: h.sleep,
			now: h.now,
			resolveInput,
		});
		expect(outcome).toMatchObject({
			status: "completed",
			result: { done: true },
		});
		expect(
			resolveInput.mock.calls.map(([input]) => input.inputRequests),
		).toEqual([{ a: { q: 1 } }, { b: { q: 2 } }]);
		expect(
			h.calls
				.filter((c) => c.method === "tasks/update")
				.map((c) => c.params.inputResponses),
		).toEqual([{ a: { action: "accept" } }, { b: { action: "accept" } }]);
		// Re-poll immediately after an answer; wait only when nothing is new.
		expect(h.sleeps).toEqual([500]);
	});

	it("surfaces the pending requests when there is no resolver", async () => {
		const h = harness([
			state("input_required", { inputRequests: { a: { q: 1 } } }),
		]);
		const outcome = await pollMcpTask({ taskId: "t1", request: h.request });
		expect(outcome).toMatchObject({
			status: "input_required",
			inputRequests: { a: { q: 1 } },
		});
		expect(h.calls.map((c) => c.method)).toEqual(["tasks/get"]);
	});

	it("surfaces the requests when the resolver declines or answers unknown ids", async () => {
		for (const answer of [null, {}, { other: { action: "accept" } }]) {
			const h = harness([
				state("input_required", { inputRequests: { a: {} } }),
			]);
			const outcome = await pollMcpTask({
				taskId: "t1",
				request: h.request,
				resolveInput: () => answer,
			});
			expect(outcome.status).toBe("input_required");
			expect(h.calls.map((c) => c.method)).toEqual(["tasks/get"]);
		}
	});
});

describe("pollMcpTask push source", () => {
	it("consumes pushed states instead of polling and waits through the source", async () => {
		const pushes = [
			null,
			{ taskId: "t1", status: "completed", result: { pushed: true } },
		];
		const waits: number[] = [];
		const h = harness([state("working", { pollIntervalMs: 50 })]);
		const outcome = await pollMcpTask({
			taskId: "t1",
			request: h.request,
			push: {
				next: async (ms) => {
					waits.push(ms);
					return ms === 0 ? null : (pushes.shift() ?? null);
				},
			},
		});
		expect(outcome).toMatchObject({
			status: "completed",
			result: { pushed: true },
		});
		expect(h.calls.map((c) => c.method)).toEqual(["tasks/get", "tasks/get"]);
		expect(waits).toEqual([0, 50, 0, 50]);
	});
});
