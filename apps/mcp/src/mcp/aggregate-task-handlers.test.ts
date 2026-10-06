import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const genericStore = {
	getGenericTaskState: vi.fn(),
	cancelGenericTask: vi.fn(),
	updateGenericTaskInput: vi.fn(),
};
vi.mock("./generic-task-store", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./generic-task-store")>();
	return {
		...actual,
		getGenericTaskState: (...args: unknown[]) =>
			genericStore.getGenericTaskState(...args),
		cancelGenericTask: (...args: unknown[]) =>
			genericStore.cancelGenericTask(...args),
		updateGenericTaskInput: (...args: unknown[]) =>
			genericStore.updateGenericTaskInput(...args),
	};
});

import {
	buildAggregateTaskHandlers,
	hasAggregateTaskCapableTool,
	reassertTrustedWorkflowTediTaskId,
} from "./aggregate-task-handlers";

const ENV = {
	API_URL: "https://api.test",
	DB: {} as unknown,
} as unknown as CloudflareEnv;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

afterEach(() => vi.unstubAllGlobals());

function stubFetch(
	handler: (url: string, body: Record<string, unknown>) => Response,
) {
	const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: unknown, init: RequestInit) => {
			const body = JSON.parse(String(init.body)).json as Record<
				string,
				unknown
			>;
			calls.push({ url: String(url), body });
			return handler(String(url), body);
		}),
	);
	return calls;
}

describe("aggregate task handlers — tedi-run routing", () => {
	it("reasserts a task receipt only after service-binding auth and preserves other workflow headers", () => {
		const taskId = "tedi:target-tedi:run-1";
		const trusted = new Headers({
			"X-Tedix-Workflow-Tedi-Task-Id": "tedi:forged:run",
			"X-Tedix-Skill-Run-Id": "skill-run-1",
			"X-Tedix-Workflow-Step-Id": "step-1",
		});
		reassertTrustedWorkflowTediTaskId(trusted, taskId, "service-binding");
		expect(trusted.get("X-Tedix-Workflow-Tedi-Task-Id")).toBe(taskId);
		expect(trusted.get("X-Tedix-Skill-Run-Id")).toBe("skill-run-1");
		expect(trusted.get("X-Tedix-Workflow-Step-Id")).toBe("step-1");

		const external = new Headers({
			"X-Tedix-Workflow-Tedi-Task-Id": taskId,
		});
		reassertTrustedWorkflowTediTaskId(external, taskId, "oauth");
		expect(external.has("X-Tedix-Workflow-Tedi-Task-Id")).toBe(false);
		reassertTrustedWorkflowTediTaskId(
			external,
			"tedi:target-tedi:run-1".repeat(40),
			"service-binding",
		);
		expect(external.has("X-Tedix-Workflow-Tedi-Task-Id")).toBe(false);
	});

	it("delegates the exact workflow-owned tedi task read to the API", async () => {
		const requests: Array<{ url: string; headers: Headers }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: unknown, init: RequestInit) => {
				const headers = new Headers(init.headers);
				requests.push({ url: String(url), headers });
				if (headers.get("X-Tedix-Tedi-Scopes") !== "tedis:read") {
					return jsonResponse({ json: { message: "Forbidden" } }, 403);
				}
				if (String(url).includes("cognitiveRuntime/readMessages")) {
					return jsonResponse({
						json: {
							messages: [
								{ id: "msg-1", role: "assistant", content: "verified reply" },
							],
						},
					});
				}
				return jsonResponse({
					json: {
						events: [
							{
								kind: "message.completed",
								runId: "run-1",
								messageId: "msg-1",
								conversationId: "conv-1",
								createdAt: "2026-09-23T00:00:00Z",
							},
							{
								kind: "run.completed",
								runId: "run-1",
								conversationId: "conv-1",
								createdAt: "2026-09-23T00:01:00Z",
							},
						],
					},
				});
			}),
		);
		const taskId = "tedi:target-tedi:run-1";
		const callerIdentity = {
			authType: "service" as const,
			organizationId: "org-1",
			tediId: "calling-tedi",
			skillRunId: "workflow-1",
		};
		const admitted = buildAggregateTaskHandlers({
			env: ENV,
			organizationId: "org-1",
			callerIdentity,
			delegatedTediTaskId: taskId,
		});
		await expect(admitted.get({ taskId })).resolves.toMatchObject({
			status: "completed",
			result: { assistant: { content: "verified reply" } },
		});
		expect(requests[0]?.headers.get("X-Tedix-Org-Id")).toBe("org-1");
		expect(requests[0]?.headers.get("X-Tedix-Tedi-Scopes")).toBe("tedis:read");
		expect(requests[1]?.url).toContain("cognitiveRuntime/readMessages");
		expect(requests[1]?.headers.get("X-Tedix-Tedi-Scopes")).toBe("tedis:read");

		const foreignTask = buildAggregateTaskHandlers({
			env: ENV,
			organizationId: "org-1",
			callerIdentity,
			delegatedTediTaskId: "tedi:other-tedi:other-run",
		});
		await expect(foreignTask.get({ taskId })).rejects.toMatchObject({
			code: -32_603,
		});
		expect(requests[2]?.headers.get("X-Tedix-Tedi-Scopes")).toBeNull();
	});

	it("routes a namespaced tedi:<tediId>:<runId> id to cognitiveRuntime.listEvents", async () => {
		const calls = stubFetch((url) => {
			if (url.includes("cognitiveRuntime/listEvents")) {
				return jsonResponse({
					json: {
						events: [
							{
								kind: "run.started",
								runId: "run-1",
								createdAt: "2026-06-14T00:00:00Z",
							},
							{
								kind: "run.completed",
								runId: "run-1",
								conversationId: "conv-1",
								createdAt: "2026-06-14T00:01:00Z",
							},
						],
					},
				});
			}
			return jsonResponse({ json: {} }, 404);
		});

		const handlers = buildAggregateTaskHandlers({
			env: ENV,
			organizationId: "org-1",
			callerIdentity: {
				authType: "oauth",
				organizationId: "org-1",
				userId: "user-1",
			},
			bearerToken: "user-token",
		});
		const state = await handlers.get({ taskId: "tedi:tedi-uuid-1:run-1" });

		// Routed to the cognitive runtime (not the kernel runtime).
		expect(calls[0]?.url).toContain("cognitiveRuntime/listEvents");
		expect(calls[0]?.body).toMatchObject({
			tediId: "tedi-uuid-1",
			runId: "run-1",
		});
		expect(state.status).toBe("completed");
		// Envelope keeps the namespaced id; bare run id stays in result.
		expect(state.taskId).toBe("tedi:tedi-uuid-1:run-1");
		expect((state.result as { runId?: string })?.runId).toBe("run-1");
	});

	it("inlines the assistant reply into a completed tedi-run task via messages_read", async () => {
		const calls = stubFetch((url) => {
			if (url.includes("cognitiveRuntime/listEvents")) {
				return jsonResponse({
					json: {
						events: [
							{
								kind: "message.completed",
								runId: "run-9",
								messageId: "msg-9",
								conversationId: "conv-9",
								createdAt: "2026-06-14T00:00:30Z",
							},
							{
								kind: "run.completed",
								runId: "run-9",
								conversationId: "conv-9",
								createdAt: "2026-06-14T00:01:00Z",
							},
						],
					},
				});
			}
			if (url.includes("cognitiveRuntime/readMessages")) {
				return jsonResponse({
					json: {
						messages: [
							{ id: "u-1", role: "user", content: "frage" },
							{ id: "msg-9", role: "assistant", content: "die Antwort" },
						],
					},
				});
			}
			return jsonResponse({ json: {} }, 404);
		});

		const handlers = buildAggregateTaskHandlers({
			env: ENV,
			organizationId: "org-1",
			callerIdentity: {
				authType: "oauth",
				organizationId: "org-1",
				userId: "user-1",
			},
			bearerToken: "user-token",
		});
		const state = await handlers.get({ taskId: "tedi:tedi-uuid-9:run-9" });

		// tasks/get is now self-sufficient: the assistant content is inlined,
		// so a Tasks client needs no follow-up messages_read.
		expect(state.status).toBe("completed");
		const result = state.result as {
			assistant?: { content?: string };
			content?: string;
		};
		expect(result.assistant?.content).toBe("die Antwort");
		expect(result.content).toBe("die Antwort");
		// It resolved by reading the run's conversation for the output message.
		const readCall = calls.find((c) =>
			c.url.includes("cognitiveRuntime/readMessages"),
		);
		expect(readCall?.body).toMatchObject({
			tediId: "tedi-uuid-9",
			conversationId: "conv-9",
		});
	});

	it("returns -32602 not-found for an unknown tedi run (empty event page)", async () => {
		stubFetch((url) =>
			url.includes("cognitiveRuntime/listEvents")
				? jsonResponse({ json: { events: [] } })
				: jsonResponse({ json: {} }, 404),
		);
		const handlers = buildAggregateTaskHandlers({
			env: ENV,
			organizationId: "org-1",
		});
		await expect(
			handlers.get({ taskId: "tedi:t:missing" }),
		).rejects.toMatchObject({
			code: -32_602,
		});
	});

	it("falls back to the home/kernel handler for a bare run id", async () => {
		const calls = stubFetch((url) => {
			if (url.includes("kernelRuntime/readRun")) {
				return jsonResponse({
					json: {
						run: {
							id: "home-run-1",
							status: "completed",
							createdAt: "2026-06-14T00:00:00Z",
							conversationId: "home:main",
							metadata: {
								bodyExecutionResult: { status: "completed" },
							},
						},
					},
				});
			}
			return jsonResponse({ json: {} }, 404);
		});

		const handlers = buildAggregateTaskHandlers({
			env: ENV,
			organizationId: "org-1",
		});
		const state = await handlers.get({ taskId: "home-run-1" });
		expect(calls[0]?.url).toContain("kernelRuntime/readRun");
		expect(state.status).toBe("completed");
	});

	it("tedi-run update directs to the durable approval tools (not tasks/update)", async () => {
		stubFetch(() => jsonResponse({ json: {} }));
		const handlers = buildAggregateTaskHandlers({
			env: ENV,
			organizationId: "org-1",
		});
		await expect(
			handlers.update({ taskId: "tedi:t:run-1", inputResponses: {} }),
		).rejects.toMatchObject({ data: { respondWith: "permissions_respond" } });
	});
});

describe("aggregate task handlers — generic-<uuid> routing", () => {
	afterEach(() => {
		genericStore.getGenericTaskState.mockReset();
		genericStore.cancelGenericTask.mockReset();
		genericStore.updateGenericTaskInput.mockReset();
	});

	it("routes generic-<uuid> get to the mcp_tasks store (not the runtime APIs)", async () => {
		const calls = stubFetch(() => jsonResponse({ json: {} }, 404));
		genericStore.getGenericTaskState.mockResolvedValue({
			taskId: "generic-abc",
			status: "working",
			createdAt: "2026-06-14T00:00:00Z",
			lastUpdatedAt: "2026-06-14T00:00:00Z",
			ttlMs: 900000,
		});

		const handlers = buildAggregateTaskHandlers({
			env: ENV,
			organizationId: "org-1",
		});
		const state = await handlers.get({ taskId: "generic-abc" });

		expect(state.status).toBe("working");
		expect(genericStore.getGenericTaskState).toHaveBeenCalledWith(
			ENV.DB,
			"generic-abc",
			"org-1",
			undefined,
		);
		// No runtime API calls for a generic task.
		expect(calls).toHaveLength(0);
	});

	it("routes generic-<uuid> cancel and update to the store", async () => {
		stubFetch(() => jsonResponse({ json: {} }, 404));
		genericStore.cancelGenericTask.mockResolvedValue({
			taskId: "generic-abc",
			status: "cancelled",
			createdAt: "2026-06-14T00:00:00Z",
			lastUpdatedAt: "2026-06-14T00:00:00Z",
			ttlMs: null,
		});
		genericStore.updateGenericTaskInput.mockResolvedValue(undefined);

		const handlers = buildAggregateTaskHandlers({
			env: ENV,
			organizationId: "org-1",
		});
		await handlers.cancel({ taskId: "generic-abc" });
		await handlers.update({
			taskId: "generic-abc",
			inputResponses: { ok: true },
		});

		expect(genericStore.cancelGenericTask).toHaveBeenCalledWith(
			ENV.DB,
			"generic-abc",
			"org-1",
			undefined,
		);
		expect(genericStore.updateGenericTaskInput).toHaveBeenCalledWith(
			ENV.DB,
			"generic-abc",
			"org-1",
			{ ok: true },
			undefined,
		);
	});

	it("without home surface, a bare id is not-found (only generic ids served)", async () => {
		stubFetch(() => jsonResponse({ json: {} }, 404));
		const handlers = buildAggregateTaskHandlers({
			env: ENV,
			organizationId: "org-1",
			includeHomeSurface: false,
		});
		await expect(
			handlers.get({ taskId: "some-bare-id" }),
		).rejects.toMatchObject({
			code: -32_602,
		});
	});
});

describe("aggregate task handlers — graph-gds task routing", () => {
	it("mounts task handlers for generic async or graph maintenance tools", () => {
		expect(
			hasAggregateTaskCapableTool([
				{ config: { endpoint: "memoryGraph/graph/maintenance" } },
			]),
		).toBe(true);
		expect(
			hasAggregateTaskCapableTool([{ config: { _asyncTask: true } }]),
		).toBe(true);
		expect(
			hasAggregateTaskCapableTool([
				{ config: { endpoint: "memoryGraph/graph/health" } },
			]),
		).toBe(false);
	});

	it("maps the API lifecycle to MCP Tasks and preserves org scope", async () => {
		const requests: Array<{
			url: string;
			headers: Headers;
			body: Record<string, unknown>;
		}> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: unknown, init: RequestInit) => {
				requests.push({
					url: String(url),
					headers: new Headers(init.headers),
					body: JSON.parse(String(init.body)).json,
				});
				return jsonResponse({
					json: {
						id: "graph-gds-abc",
						workflowId: "graph-gds-abc",
						status: "completed",
						createdAt: "2026-07-28T00:00:00.000Z",
						lastUpdatedAt: "2026-07-28T00:01:00.000Z",
						pollIntervalMs: 2500,
						result: {
							operation: "gds_refresh",
							organizationId: "org-1",
							watermark: 42,
							epoch: "epoch-1",
						},
					},
				});
			}),
		);
		const handlers = buildAggregateTaskHandlers({
			env: ENV,
			organizationId: "org-1",
			callerIdentity: {
				authType: "oauth",
				organizationId: "org-1",
				userId: "user-1",
			},
			bearerToken: "user-token",
		});

		await expect(
			handlers.get({ taskId: "graph-gds-abc" }),
		).resolves.toMatchObject({
			taskId: "graph-gds-abc",
			status: "completed",
			result: {
				workflowId: "graph-gds-abc",
				watermark: 42,
				epoch: "epoch-1",
			},
		});
		expect(requests[0]?.url).toContain(
			"memoryGraph/graph/maintenanceTaskStatus",
		);
		expect(requests[0]?.headers.get("X-Tedix-Org-Id")).toBe("org-1");
		expect(requests[0]?.headers.get("Authorization")).toBe("Bearer user-token");
		expect(requests[0]?.body).toEqual({ taskId: "graph-gds-abc" });
	});

	it("routes cooperative cancellation and rejects mid-flight input", async () => {
		const calls = stubFetch(() =>
			jsonResponse({
				json: {
					id: "graph-gds-abc",
					status: "cancel_requested",
				},
			}),
		);
		const handlers = buildAggregateTaskHandlers({
			env: ENV,
			organizationId: "org-1",
			callerIdentity: {
				authType: "oauth",
				organizationId: "org-1",
				userId: "user-1",
			},
			bearerToken: "user-token",
		});

		await expect(
			handlers.cancel({ taskId: "graph-gds-abc" }),
		).resolves.toBeUndefined();
		expect(calls[0]?.url).toContain("memoryGraph/graph/maintenanceTaskCancel");
		await expect(
			handlers.update({
				taskId: "graph-gds-abc",
				inputResponses: { continue: true },
			}),
		).rejects.toMatchObject({ code: -32_000 });
	});

	it("fails closed when upstream reports completion without a receipt", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					json: {
						id: "graph-gds-corrupt",
						workflowId: "graph-gds-corrupt",
						status: "completed",
						createdAt: "2026-07-28T00:00:00.000Z",
						lastUpdatedAt: "2026-07-28T00:01:00.000Z",
						result: null,
					},
				}),
			),
		);
		const handlers = buildAggregateTaskHandlers({
			env: ENV,
			organizationId: "org-1",
			callerIdentity: {
				authType: "oauth",
				organizationId: "org-1",
				userId: "user-1",
			},
			bearerToken: "user-token",
		});

		await expect(
			handlers.get({ taskId: "graph-gds-corrupt" }),
		).resolves.toMatchObject({
			status: "failed",
			error: {
				message: "Graph GDS refresh completed without a valid atomic receipt",
			},
		});
	});

	it("replays API-key authority through the public API path", async () => {
		const requests: Headers[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				requests.push(new Headers(init.headers));
				return jsonResponse({
					json: {
						id: "graph-gds-api-key",
						status: "running",
						createdAt: "2026-07-28T00:00:00.000Z",
						lastUpdatedAt: "2026-07-28T00:01:00.000Z",
					},
				});
			}),
		);
		const handlers = buildAggregateTaskHandlers({
			env: {
				...ENV,
				API_SERVICE: { fetch: vi.fn() },
			} as unknown as CloudflareEnv,
			organizationId: "org-1",
			callerIdentity: {
				authType: "apiKey",
				organizationId: "org-1",
				clientId: "key-1",
			},
			bearerToken: "api-key-token",
		});

		await expect(
			handlers.get({ taskId: "graph-gds-api-key" }),
		).resolves.toMatchObject({
			status: "working",
		});
		expect(requests[0]?.get("Authorization")).toBe("Bearer api-key-token");
		expect(requests[0]?.get("X-Service-Binding")).toBeNull();
	});

	it("rejects external-agent graph task authority", async () => {
		const handlers = buildAggregateTaskHandlers({
			env: ENV,
			organizationId: "org-1",
			callerIdentity: {
				authType: "external_agent",
				organizationId: "org-1",
				externalAgentPrincipalId: "agent-1",
			},
		});

		await expect(
			handlers.get({ taskId: "graph-gds-external" }),
		).rejects.toMatchObject({
			code: -32_603,
			message: "External agents cannot run graph projection maintenance",
		});
	});
});
