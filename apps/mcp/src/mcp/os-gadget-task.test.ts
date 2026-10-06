import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Mock the store leaf so task-link tests capture the routing-row write and
// tasks/get tests control the routing snapshot — same pattern as
// aggregate-task-handlers.test.ts.
const store = {
	createGenericTask: vi.fn(),
	readGenericTaskInputSnapshot: vi.fn(),
};
vi.mock("./generic-task-store", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./generic-task-store")>();
	return {
		...actual,
		createGenericTask: (...args: unknown[]) => store.createGenericTask(...args),
		readGenericTaskInputSnapshot: (...args: unknown[]) =>
			store.readGenericTaskInputSnapshot(...args),
	};
});

import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import { McpTaskError } from "@tedix/mcp-shared/tasks";
import {
	buildAggregateTaskHandlers,
	hasAggregateTaskCapableTool,
} from "./aggregate-task-handlers";
import { type ToolExecutionContext, ToolHandler } from "./handler";
import {
	osGadgetExecutionToTaskState,
	readDispatchedOsGadgetExecution,
} from "./os-gadget-task";

const EXECUTION_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const GADGET_ID = "33333333-3333-4333-8333-333333333333";
const TASK_ID = `os-gadget-${EXECUTION_ID}`;

function execution(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const lineageOverride =
		typeof overrides.lineage === "object" && overrides.lineage !== null
			? (overrides.lineage as Record<string, unknown>)
			: {};
	return {
		id: EXECUTION_ID,
		organizationId: "org_1",
		workspaceId: WORKSPACE_ID,
		gadgetId: GADGET_ID,
		revisionId: "44444444-4444-4444-8444-444444444444",
		revision: 1,
		status: "running",
		grantedCapabilities: ["skills.run"],
		policyDecision: { allowed: true, reasons: [] },
		input: null,
		output: null,
		error: null,
		costs: null,
		evidenceRefs: null,
		createdByKind: "user",
		createdById: "user_1",
		createdAt: "2026-08-15T00:00:00Z",
		completedAt: null,
		lineage: {
			runId: null,
			workflowInstanceId: null,
			tediId: "55555555-5555-4555-8555-555555555555",
			approvalRequestId: null,
			...lineageOverride,
		},
		...overrides,
	};
}

const ENV = {
	ENVIRONMENT: "test",
	API_URL: "https://api.test",
	DB: {} as unknown,
} as unknown as CloudflareEnv;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

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

function runToolCtx(
	overrides: Partial<ToolExecutionContext<ToolConfig>> = {},
): ToolExecutionContext<ToolConfig> {
	return {
		appId: "app_1",
		app: {
			id: "app_1",
			slug: "tedix-unified",
			name: "Tedix",
			organizationId: "org_1",
		} as ToolExecutionContext["app"],
		appCapabilities: {},
		env: ENV,
		config: {
			transport: "rpc",
			endpoint: "osWorkspaces/gadgets/run",
		} as unknown as ToolConfig,
		toolId: "run_os_gadget",
		requestId: "req_1",
		callerIdentity: {
			authType: "user",
			userId: "user_1",
			organizationId: "org_1",
		},
		clientSupportsTasks: true,
		...overrides,
	};
}

beforeEach(() => {
	vi.unstubAllGlobals();
	store.createGenericTask.mockReset().mockResolvedValue(undefined);
	store.readGenericTaskInputSnapshot.mockReset();
});

describe("readDispatchedOsGadgetExecution", () => {
	it("detects a dispatched receipt (non-terminal status + runId)", () => {
		expect(
			readDispatchedOsGadgetExecution({
				execution: execution({
					status: "queued",
					lineage: { runId: "run-1" },
				}),
			}),
		).toEqual({
			executionId: EXECUTION_ID,
			workspaceId: WORKSPACE_ID,
			gadgetId: GADGET_ID,
			runId: "run-1",
		});
	});

	it("reads runId from canonical receipt lineage", () => {
		expect(
			readDispatchedOsGadgetExecution({
				execution: execution({
					status: "awaiting_approval",
					lineage: { runId: "run-2" },
				}),
			})?.runId,
		).toBe("run-2");
	});

	it("detects an approval-parked receipt before it has a runId", () => {
		expect(
			readDispatchedOsGadgetExecution({
				execution: execution({ status: "awaiting_approval" }),
			}),
		).toEqual({
			executionId: EXECUTION_ID,
			workspaceId: WORKSPACE_ID,
			gadgetId: GADGET_ID,
			runId: null,
		});
	});

	it("returns null for terminal receipts even when lineage is present", () => {
		for (const status of ["denied", "completed", "failed"]) {
			expect(
				readDispatchedOsGadgetExecution({
					execution: execution({ status, lineage: { runId: "run-3" } }),
				}),
			).toBeNull();
		}
	});
});

describe("run_os_gadget task linkage (rpc handler)", () => {
	it("keeps the API result schema-pure and returns an internal task marker", async () => {
		stubFetch(() =>
			jsonResponse({
				json: {
					execution: execution({
						status: "queued",
						lineage: { runId: "run-1" },
					}),
				},
			}),
		);
		const handler = new ToolHandler();
		const result = await handler.execute(
			{ workspaceId: WORKSPACE_ID, gadgetId: GADGET_ID },
			runToolCtx(),
		);

		expect(result.status).toBe(200);
		expect(result.data as Record<string, unknown>).not.toHaveProperty("task");
		expect(result.osGadgetTask).toEqual({
			taskId: TASK_ID,
			status: "working",
			ttlMs: null,
			pollIntervalMs: 2_500,
		});
		expect(store.createGenericTask).toHaveBeenCalledOnce();
		expect(store.createGenericTask.mock.calls[0]?.[0]).toMatchObject({
			taskId: TASK_ID,
			orgId: "org_1",
			appId: "app_1",
			toolName: "run_os_gadget",
			inputArgs: {
				workspaceId: WORKSPACE_ID,
				gadgetId: GADGET_ID,
				executionId: EXECUTION_ID,
				runId: "run-1",
			},
		});
	});

	it("links an approval-parked receipt before runtime dispatch", async () => {
		stubFetch(() =>
			jsonResponse({
				json: { execution: execution({ status: "awaiting_approval" }) },
			}),
		);
		const handler = new ToolHandler();
		const result = await handler.execute(
			{ workspaceId: WORKSPACE_ID, gadgetId: GADGET_ID },
			runToolCtx(),
		);

		expect(result.status).toBe(200);
		expect(result.data as Record<string, unknown>).not.toHaveProperty("task");
		expect(result.osGadgetTask).toEqual({
			taskId: TASK_ID,
			status: "working",
			ttlMs: null,
			pollIntervalMs: 2_500,
		});
		expect(store.createGenericTask.mock.calls[0]?.[0]).toMatchObject({
			inputArgs: {
				workspaceId: WORKSPACE_ID,
				gadgetId: GADGET_ID,
				executionId: EXECUTION_ID,
			},
		});
		expect(
			store.createGenericTask.mock.calls[0]?.[0].inputArgs,
		).not.toHaveProperty("runId");
	});

	it("passes a denied receipt through unchanged", async () => {
		stubFetch(() =>
			jsonResponse({
				json: {
					execution: execution({
						status: "denied",
						policyDecision: { allowed: false, reasons: ["archived gadget"] },
					}),
				},
			}),
		);
		const handler = new ToolHandler();
		const result = await handler.execute(
			{ workspaceId: WORKSPACE_ID, gadgetId: GADGET_ID },
			runToolCtx(),
		);

		expect(result.data as Record<string, unknown>).not.toHaveProperty("task");
		expect(result.osGadgetTask).toBeUndefined();
		expect(store.createGenericTask).not.toHaveBeenCalled();
	});

	it("does not wrap when the caller declined the Tasks extension", async () => {
		stubFetch(() =>
			jsonResponse({
				json: {
					execution: execution({
						status: "running",
						lineage: { runId: "run-1" },
					}),
				},
			}),
		);
		const handler = new ToolHandler();
		const result = await handler.execute(
			{ workspaceId: WORKSPACE_ID, gadgetId: GADGET_ID },
			runToolCtx({ clientSupportsTasks: false }),
		);

		expect(result.data as Record<string, unknown>).not.toHaveProperty("task");
		expect(result.osGadgetTask).toBeUndefined();
		expect(store.createGenericTask).not.toHaveBeenCalled();
	});

	it("falls back to the synchronous result when the routing row write fails", async () => {
		stubFetch(() =>
			jsonResponse({
				json: {
					execution: execution({
						status: "running",
						lineage: { runId: "run-1" },
					}),
				},
			}),
		);
		store.createGenericTask.mockRejectedValueOnce(new Error("D1 write failed"));
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const handler = new ToolHandler();
		const result = await handler.execute(
			{ workspaceId: WORKSPACE_ID, gadgetId: GADGET_ID },
			runToolCtx(),
		);
		expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
			event: "os_gadget_task.routing_write_failed",
			appId: "app_1",
			taskId: TASK_ID,
			executionId: EXECUTION_ID,
			exception: { type: "Error", message: "Content omitted" },
		});
		errorSpy.mockRestore();

		expect(result.status).toBe(200);
		expect(result.data as Record<string, unknown>).not.toHaveProperty("task");
		expect(result.osGadgetTask).toBeUndefined();
	});
});

describe("aggregate tasks/get — os-gadget routing", () => {
	function handlers() {
		return buildAggregateTaskHandlers({
			env: ENV,
			organizationId: "org_1",
		});
	}

	function routingSnapshot() {
		store.readGenericTaskInputSnapshot.mockResolvedValue({
			workspaceId: WORKSPACE_ID,
			gadgetId: GADGET_ID,
			executionId: EXECUTION_ID,
			runId: "run-1",
		});
	}

	it("resolves a pending run to working with a status note", async () => {
		routingSnapshot();
		const calls = stubFetch(() =>
			jsonResponse({
				json: {
					execution: execution({
						status: "running",
						lineage: { runId: "run-1" },
					}),
				},
			}),
		);

		const state = await handlers().get({ taskId: TASK_ID });

		expect(calls[0]?.url).toContain("osWorkspaces/executions/get");
		expect(calls[0]?.body).toMatchObject({
			workspaceId: WORKSPACE_ID,
			gadgetId: GADGET_ID,
			executionId: EXECUTION_ID,
		});
		expect(store.readGenericTaskInputSnapshot).toHaveBeenCalledWith(
			ENV.DB,
			TASK_ID,
			"org_1",
		);
		expect(state.status).toBe("working");
		expect(state.taskId).toBe(TASK_ID);
		expect(state.statusMessage).toContain("executing");
		expect(state.pollIntervalMs).toBe(2_500);
	});

	it("routes awaiting_approval to permissions_respond, never tasks/update", async () => {
		routingSnapshot();
		stubFetch(() =>
			jsonResponse({
				json: {
					execution: execution({
						status: "awaiting_approval",
						lineage: { runId: "run-1" },
					}),
				},
			}),
		);

		const state = await handlers().get({ taskId: TASK_ID });
		expect(state.status).toBe("working");
		expect(state.statusMessage).toContain("permissions_respond");
	});

	it("inlines the receipt on a completed run", async () => {
		routingSnapshot();
		stubFetch(() =>
			jsonResponse({
				json: {
					execution: execution({
						status: "completed",
						runId: "run-1",
						output: { ok: true },
						completedAt: "2026-08-15T00:05:00Z",
					}),
				},
			}),
		);

		const state = await handlers().get({ taskId: TASK_ID });
		expect(state.status).toBe("completed");
		expect(state.lastUpdatedAt).toBe("2026-08-15T00:05:00Z");
		const receipt = (state.result as { execution: Record<string, unknown> })
			.execution;
		expect(receipt.id).toBe(EXECUTION_ID);
		expect(receipt.output).toEqual({ ok: true });
	});

	it("inlines the receipt on a failed run", async () => {
		routingSnapshot();
		stubFetch(() =>
			jsonResponse({
				json: {
					execution: execution({
						status: "failed",
						runId: "run-1",
						error: "skill run failed",
						completedAt: "2026-08-15T00:05:00Z",
					}),
				},
			}),
		);

		const state = await handlers().get({ taskId: TASK_ID });
		expect(state.status).toBe("failed");
		expect(state.error?.message).toBe("skill run failed");
		const errorData = state.error?.data as
			| { execution: Record<string, unknown> }
			| undefined;
		expect(errorData?.execution.id).toBe(EXECUTION_ID);
	});

	it("maps a denied receipt to failed with the policy reasons", async () => {
		routingSnapshot();
		stubFetch(() =>
			jsonResponse({
				json: {
					execution: execution({
						status: "denied",
						policyDecision: {
							allowed: false,
							reasons: ["capability not declared"],
						},
					}),
				},
			}),
		);

		const state = await handlers().get({ taskId: TASK_ID });
		expect(state.status).toBe("failed");
		expect(state.error?.message).toContain("capability not declared");
	});

	it("maps a canceled receipt to cancelled with the receipt inlined", async () => {
		routingSnapshot();
		stubFetch(() =>
			jsonResponse({
				json: {
					execution: execution({
						status: "canceled",
						runId: "run-1",
						completedAt: "2026-08-15T00:05:00Z",
					}),
				},
			}),
		);

		const state = await handlers().get({ taskId: TASK_ID });
		expect(state.status).toBe("cancelled");
		expect(
			(state.result as { execution: Record<string, unknown> }).execution.id,
		).toBe(EXECUTION_ID);
	});

	it("projects a missing/foreign routing row as not found", async () => {
		store.readGenericTaskInputSnapshot.mockResolvedValue(null);
		stubFetch(() => jsonResponse({ json: {} }));

		await expect(handlers().get({ taskId: TASK_ID })).rejects.toMatchObject({
			code: -32_602,
		});
	});

	it("projects a missing receipt (executions.get 404) as not found", async () => {
		routingSnapshot();
		stubFetch(() => jsonResponse({ json: {} }, 404));

		await expect(handlers().get({ taskId: TASK_ID })).rejects.toMatchObject({
			code: -32_602,
		});
	});

	it("rejects tasks/update — approvals flow through permissions_respond", async () => {
		await expect(
			handlers().update({ taskId: TASK_ID, inputResponses: {} }),
		).rejects.toMatchObject({
			code: -32_000,
			data: { respondWith: "permissions_respond" },
		});
	});

	it("rejects tasks/cancel — receipts settle from run evidence", async () => {
		const error = await handlers()
			.cancel({ taskId: TASK_ID })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(McpTaskError);
		expect((error as McpTaskError).code).toBe(-32_000);
	});
});

describe("osGadgetExecutionToTaskState — defensive statuses", () => {
	it("keeps an unknown non-terminal status polling", () => {
		const state = osGadgetExecutionToTaskState(
			TASK_ID,
			execution({
				status: "dispatching",
				lineage: { runId: "run-1" },
			}),
		);
		expect(state.status).toBe("working");
		expect(state.statusMessage).toContain("dispatching");
	});

	it("notes the queued phase", () => {
		const state = osGadgetExecutionToTaskState(
			TASK_ID,
			execution({ status: "queued", lineage: { runId: "run-1" } }),
		);
		expect(state.status).toBe("working");
		expect(state.statusMessage).toContain("queued");
	});
});

describe("hasAggregateTaskCapableTool — os gadget run", () => {
	it("marks a surface with run_os_gadget task-capable", () => {
		expect(
			hasAggregateTaskCapableTool([
				{ config: { endpoint: "osWorkspaces/gadgets/run" } },
			]),
		).toBe(true);
	});
});
