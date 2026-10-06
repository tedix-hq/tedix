/**
 * Turn-abort cost protection (audit B3). Over stateless HTTP the Task is the
 * real cancellable object: when the caller's AbortSignal trips while a task is
 * still non-terminal, `resolveTaskResult` must stop polling `tasks/get`, fire a
 * best-effort `tasks/cancel` (so the upstream stops burning compute), and
 * reject promptly. When the task already reached a terminal state, no cancel
 * is sent and the result is returned as usual.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { McpClientManager } from "../src/client-manager";
import type { McpServerConfig } from "../src/types";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

type FetchCall = { method: string; params: Record<string, unknown> };

afterEach(() => vi.unstubAllGlobals());

function resolveTask(
	manager: McpClientManager,
	config: McpServerConfig,
	result: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	return (
		manager as unknown as {
			resolveTaskResult: (
				c: McpServerConfig,
				r: unknown,
				s?: AbortSignal,
			) => Promise<unknown>;
		}
	).resolveTaskResult(config, result, signal);
}

const TASK_RESULT = { resultType: "task", taskId: "task-b3" };

/** Fetch mock that answers `server/discover` and records every other method. */
function stubTaskFetch(handler: (call: FetchCall) => Response): {
	calls: FetchCall[];
} {
	const calls: FetchCall[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: unknown, init: RequestInit) => {
			const parsed = JSON.parse(String(init.body)) as FetchCall;
			if (parsed.method === "server/discover") {
				return jsonResponse({
					jsonrpc: "2.0",
					id: "d",
					result: {
						resultType: "complete",
						supportedVersions: ["2026-07-28"],
					},
				});
			}
			calls.push({ method: parsed.method, params: parsed.params });
			return handler(parsed);
		}),
	);
	return { calls };
}

describe("task polling abort → upstream cancel", () => {
	it("sends tasks/cancel and rejects when the signal aborts mid-poll", async () => {
		const controller = new AbortController();
		let taskGetCount = 0;
		const { calls } = stubTaskFetch((call) => {
			if (call.method === "tasks/get") {
				taskGetCount += 1;
				if (taskGetCount === 2) {
					// Abort while the task is known and still non-terminal.
					controller.abort();
				}
				return jsonResponse({
					jsonrpc: "2.0",
					id: String(taskGetCount),
					result: { taskId: "task-b3", status: "working", pollIntervalMs: 5 },
				});
			}
			// tasks/cancel acknowledgement.
			return jsonResponse({
				jsonrpc: "2.0",
				id: "c",
				result: { taskId: "task-b3", status: "cancelled" },
			});
		});

		const manager = new McpClientManager();
		const config: McpServerConfig = {
			url: "https://peer.example/mcp",
			taskPolling: { maxAttempts: 30, maxIntervalMs: 50 },
		};

		await expect(
			resolveTask(manager, config, TASK_RESULT, controller.signal),
		).rejects.toMatchObject({ name: "AbortError" });

		// The abort fired an upstream tasks/cancel for the in-flight task.
		const cancels = calls.filter((call) => call.method === "tasks/cancel");
		expect(cancels).toHaveLength(1);
		expect(cancels[0]?.params).toMatchObject({ taskId: "task-b3" });
		// Polling stopped promptly: no tasks/get after the aborting poll.
		expect(calls.filter((call) => call.method === "tasks/get")).toHaveLength(2);
		// The cancel is the LAST wire interaction.
		expect(calls[calls.length - 1]?.method).toBe("tasks/cancel");
	});

	it("sends tasks/cancel immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const { calls } = stubTaskFetch(() =>
			jsonResponse({
				jsonrpc: "2.0",
				id: "c",
				result: { taskId: "task-b3", status: "cancelled" },
			}),
		);

		const manager = new McpClientManager();
		const config: McpServerConfig = { url: "https://peer.example/mcp" };

		await expect(
			resolveTask(manager, config, TASK_RESULT, controller.signal),
		).rejects.toMatchObject({ name: "AbortError" });

		// No poll was wasted; the only wire interaction is the cancel.
		expect(calls.map((call) => call.method)).toEqual(["tasks/cancel"]);
	});

	it("does not cancel when the task already reached a terminal state", async () => {
		const controller = new AbortController();
		const { calls } = stubTaskFetch((call) => {
			expect(call.method).toBe("tasks/get");
			// Abort races in AFTER the server already completed the task: the
			// terminal state wins and no upstream cancel is issued.
			controller.abort();
			return jsonResponse({
				jsonrpc: "2.0",
				id: "1",
				result: {
					taskId: "task-b3",
					status: "completed",
					result: { content: [{ type: "text", text: "done" }] },
				},
			});
		});

		const manager = new McpClientManager();
		const config: McpServerConfig = { url: "https://peer.example/mcp" };

		const result = await resolveTask(
			manager,
			config,
			TASK_RESULT,
			controller.signal,
		);
		expect(result).toMatchObject({
			content: [{ type: "text", text: "done" }],
		});
		expect(calls.map((call) => call.method)).toEqual(["tasks/get"]);
	});

	it("swallows tasks/cancel failures and still rejects with the abort", async () => {
		const controller = new AbortController();
		controller.abort();
		const { calls } = stubTaskFetch(() => {
			return new Response("boom", { status: 500 });
		});

		const manager = new McpClientManager();
		const config: McpServerConfig = { url: "https://peer.example/mcp" };

		await expect(
			resolveTask(manager, config, TASK_RESULT, controller.signal),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(calls.map((call) => call.method)).toEqual(["tasks/cancel"]);
	});
});
