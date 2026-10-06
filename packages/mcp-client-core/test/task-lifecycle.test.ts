import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { McpClientManager } from "../src/client-manager";
import type { McpServerConfig } from "../src/types";

type FetchCall = { method: string; params: Record<string, unknown> };

function response(result: unknown): Response {
	return Response.json({ jsonrpc: "2.0", id: crypto.randomUUID(), result });
}

function managerWithConnection(config: McpServerConfig): McpClientManager {
	const manager = new McpClientManager();
	(
		manager as unknown as {
			connections: Map<string, { config: McpServerConfig }>;
		}
	).connections.set("srv", { config });
	return manager;
}

afterEach(() => vi.unstubAllGlobals());

describe("persisted MCP Task lifecycle", () => {
	it("reads, updates, and cancels without replaying tools/call", async () => {
		const calls: FetchCall[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as FetchCall;
				if (body.method === "server/discover") {
					return response({
						resultType: "complete",
						supportedVersions: ["2026-07-28"],
					});
				}
				calls.push(body);
				if (body.method === "tasks/get") {
					return response({
						resultType: "complete",
						taskId: "task-1",
						status: "working",
						createdAt: "2026-08-23T00:00:00.000Z",
						lastUpdatedAt: "2026-08-23T00:00:01.000Z",
						ttlMs: null,
					});
				}
				return response({ resultType: "complete" });
			}),
		);
		const manager = managerWithConnection({
			url: "https://peer.example/mcp",
		});

		await expect(manager.getTask("srv", "task-1")).resolves.toMatchObject({
			taskId: "task-1",
			status: "working",
		});
		await manager.updateTask("srv", "task-1", { approval: { accept: true } });
		await manager.cancelTask("srv", "task-1");

		expect(calls.map(({ method }) => method)).toEqual([
			"tasks/get",
			"tasks/update",
			"tasks/cancel",
		]);
		expect(calls[1]?.params).toMatchObject({
			taskId: "task-1",
			inputResponses: { approval: { accept: true } },
		});
	});

	it("resumes a persisted task id to its terminal result", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as FetchCall;
				if (body.method === "server/discover") {
					return response({
						resultType: "complete",
						supportedVersions: ["2026-07-28"],
					});
				}
				calls.push(body.method);
				return response({
					resultType: "complete",
					taskId: "task-resume",
					status: "completed",
					result: { content: [{ type: "text", text: "done" }] },
				});
			}),
		);
		const manager = managerWithConnection({
			url: "https://peer.example/mcp",
		});

		await expect(manager.resumeTask("srv", "task-resume")).resolves.toEqual({
			content: [{ type: "text", text: "done" }],
		});
		expect(calls).toEqual(["tasks/get"]);
	});
});

describe("invocation-owned resumed Tasks", () => {
	it("uses an explicit resolver for task update and deterministic fill when absent/null", async () => {
		const shared = vi.fn();
		const answers: unknown[] = [];
		let updated = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url, init) => {
				const body = JSON.parse(String(init.body));
				if (body.method === "server/discover")
					return response({
						resultType: "complete",
						supportedVersions: ["2026-07-28"],
					});
				if (body.method === "tasks/update") {
					answers.push(body.params.inputResponses);
					updated = true;
					return response({ resultType: "complete" });
				}
				return response({
					resultType: "complete",
					taskId: "task",
					status: updated ? "completed" : "input_required",
					...(updated
						? { result: { content: [{ type: "text", text: "done" }] } }
						: {
								inputRequests: {
									form: {
										requestedSchema: {
											type: "object",
											properties: { reason: { type: "string" } },
											required: ["reason"],
										},
									},
								},
							}),
				});
			}),
		);
		const manager = managerWithConnection({
			url: "https://peer.example/mcp",
			onTaskInputRequired: shared,
		});
		await manager.resumeTask("srv", "task", {
			onTaskInputRequired: async () => ({
				form: { action: "accept", content: { reason: "original" } },
			}),
		});
		updated = false;
		await manager.resumeTask("srv", "task");
		updated = false;
		await manager.resumeTask("srv", "task", { onTaskInputRequired: null });
		expect(answers).toEqual([
			{ form: { action: "accept", content: { reason: "original" } } },
			{ form: { action: "accept", content: { reason: "" } } },
			{ form: { action: "accept", content: { reason: "" } } },
		]);
		expect(shared).not.toHaveBeenCalled();
	});
	it("cancels the original task without sending late resolver answers", async () => {
		const controller = new AbortController();
		const calls: string[] = [];
		const cancelSignals: unknown[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url, init) => {
				const body = JSON.parse(String(init.body));
				if (body.method === "server/discover")
					return response({
						resultType: "complete",
						supportedVersions: ["2026-07-28"],
					});
				calls.push(body.method);
				if (body.method === "tasks/cancel") {
					cancelSignals.push(init.signal);
					return response({ resultType: "complete" });
				}
				return response({
					resultType: "complete",
					taskId: "task",
					status: "input_required",
					inputRequests: {
						form: { requestedSchema: { type: "object", properties: {} } },
					},
				});
			}),
		);
		const manager = managerWithConnection({ url: "https://peer.example/mcp" });
		await expect(
			manager.resumeTask("srv", "task", {
				signal: controller.signal,
				onTaskInputRequired: async () => {
					controller.abort(new Error("original aborted"));
					return { form: { action: "accept", content: {} } };
				},
			}),
		).rejects.toThrow("original aborted");
		expect(calls).toEqual(["tasks/get", "tasks/cancel"]);
		expect(cancelSignals).toEqual([undefined]);
	});
});

it("threads the original cancellation into a pending tasks/get wire before best-effort cancel", async () => {
	const controller = new AbortController();
	let began!: () => void;
	const ready = new Promise<void>((resolve) => {
		began = resolve;
	});
	const calls: string[] = [];
	let getSignal: AbortSignal | null | undefined;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, init) => {
			const body = JSON.parse(String(init.body));
			if (body.method === "server/discover")
				return response({
					resultType: "complete",
					supportedVersions: ["2026-07-28"],
				});
			calls.push(body.method);
			if (body.method === "tasks/cancel") {
				expect(init.signal).toBeUndefined();
				return response({ resultType: "complete" });
			}
			getSignal = init.signal;
			began();
			return new Promise<Response>((_resolve, reject) =>
				init.signal!.addEventListener(
					"abort",
					() => reject(init.signal!.reason),
					{ once: true },
				),
			);
		}),
	);
	const manager = managerWithConnection({ url: "https://peer.example/mcp" });
	const result = manager.resumeTask("srv", "task", {
		signal: controller.signal,
	});
	const rejected = expect(result).rejects.toThrow("pending task cancelled");
	await ready;
	controller.abort(new Error("pending task cancelled"));
	await rejected;
	expect(getSignal).toBe(controller.signal);
	expect(calls).toEqual(["tasks/get", "tasks/cancel"]);
});
