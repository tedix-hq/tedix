import { McpTaskError } from "@tedix/mcp-shared/tasks";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	buildHomeTaskHandlers,
	homeRunToTaskState,
} from "./home-task-handlers";

const ORG_ID = "org_home_tasks";

function makeRun(overrides: Record<string, unknown> = {}) {
	return {
		id: "run_1",
		organizationId: ORG_ID,
		conversationId: "home:main",
		status: "running",
		createdAt: "2026-06-10T10:00:00.000Z",
		updatedAt: "2026-06-10T10:00:05.000Z",
		...overrides,
	};
}

function makeEnv(fetchImpl: (request: Request) => Promise<Response>) {
	const fetchMock = vi.fn(fetchImpl);
	const env = {
		ENVIRONMENT: "test",
		API_URL: "https://api.example.test",
		API_SERVICE: { fetch: fetchMock },
	} as unknown as CloudflareEnv;
	return { env, fetchMock };
}

function okRunResponse(run: Record<string, unknown>) {
	return new Response(JSON.stringify({ json: { run } }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function orpcErrorResponse(
	status: number,
	code: string,
	message: string,
): Response {
	return new Response(
		JSON.stringify({ json: { code, status, message, defined: false } }),
		{
			status,
			headers: { "content-type": "application/json" },
		},
	);
}

describe("homeRunToTaskState — status mapping", () => {
	it.each([
		["queued", "working"],
		["running", "working"],
		["requires_approval", "input_required"],
		["failed", "failed"],
		["canceled", "cancelled"],
	] as const)(
		"maps home run status %s → task status %s",
		(runStatus, taskStatus) => {
			const state = homeRunToTaskState(
				makeRun({ status: runStatus }) as Parameters<
					typeof homeRunToTaskState
				>[0],
			);
			expect(state.taskId).toBe("run_1");
			expect(state.status).toBe(taskStatus);
		},
	);

	it("keeps a persist-first completed row working until the turn body is durable", () => {
		const provisional = homeRunToTaskState(
			makeRun({ status: "completed" }) as Parameters<
				typeof homeRunToTaskState
			>[0],
		);
		expect(provisional.status).toBe("working");
		expect(provisional.pollIntervalMs).toBeGreaterThan(0);
		expect(provisional.result).toBeUndefined();

		const completed = homeRunToTaskState(
			makeRun({
				status: "completed",
				metadata: { bodyExecutionResult: { status: "completed" } },
			}) as Parameters<typeof homeRunToTaskState>[0],
		);
		expect(completed.status).toBe("completed");
	});

	it("completes a reconciled delegation without a local turn body result", () => {
		const state = homeRunToTaskState(
			makeRun({
				status: "completed",
				delegatedTediId: "tedi_9",
				childRunId: "child_1",
				metadata: {
					childRunStatus: "completed",
					childRunTerminalEventKind: "run.completed",
					childRunPreview: "No commit: the required formatting command failed.",
				},
			}) as Parameters<typeof homeRunToTaskState>[0],
		);
		expect(state.status).toBe("completed");
		expect(state.pollIntervalMs).toBeUndefined();
		expect(state.result).toMatchObject({
			delegatedTediId: "tedi_9",
			childRunId: "child_1",
			assistantText: "No commit: the required formatting command failed.",
		});
	});

	it.each([
		{ delegatedTediId: null },
		{ childRunId: null },
		{ metadata: { childRunStatus: "completed" } },
		{ metadata: { childRunTerminalEventKind: "run.completed" } },
		{
			metadata: {
				childRunStatus: "running",
				childRunTerminalEventKind: "run.completed",
			},
		},
		{
			metadata: {
				childRunStatus: "completed",
				childRunTerminalEventKind: "run.started",
			},
		},
		{ status: "running" },
	])("keeps an unconfirmed delegation working: %j", (overrides) => {
		const state = homeRunToTaskState(
			makeRun({
				status: "completed",
				delegatedTediId: "tedi_9",
				childRunId: "child_1",
				outputMessageId: "run_1:assistant",
				metadata: {
					childRunStatus: "completed",
					childRunTerminalEventKind: "run.completed",
				},
				...overrides,
			}) as Parameters<typeof homeRunToTaskState>[0],
		);
		expect(state.status).toBe("working");
		expect(state.result).toBeUndefined();
	});

	it("non-terminal states advertise a poll interval, terminal states do not", () => {
		const working = homeRunToTaskState(
			makeRun({ status: "running" }) as Parameters<
				typeof homeRunToTaskState
			>[0],
		);
		expect(working.pollIntervalMs).toBeGreaterThan(0);
		expect(working.result).toBeUndefined();

		const done = homeRunToTaskState(
			makeRun({
				status: "completed",
				metadata: { bodyExecutionResult: { status: "completed" } },
			}) as Parameters<typeof homeRunToTaskState>[0],
		);
		expect(done.pollIntervalMs).toBeUndefined();
		expect(done.result).toBeDefined();
	});

	it("terminal runs surface route metadata + output pointers from the run row", () => {
		const state = homeRunToTaskState(
			makeRun({
				status: "completed",
				outputMessageId: "run_1:assistant",
				delegatedTediId: "tedi_9",
				childRunId: "child_1",
				completedAt: "2026-06-10T10:01:00.000Z",
				metadata: {
					kernelRoute: { routeKind: "delegate_tedi", rationale: "needs cto" },
					childRunPreview: "Done: invoices reviewed",
					bodyExecutionResult: { status: "completed" },
				},
			}) as Parameters<typeof homeRunToTaskState>[0],
		);
		expect(state.status).toBe("completed");
		expect(state.result).toMatchObject({
			homeRunId: "run_1",
			conversationId: "home:main",
			runStatus: "completed",
			outputMessageId: "run_1:assistant",
			delegatedTediId: "tedi_9",
			childRunId: "child_1",
			kernelRoute: { routeKind: "delegate_tedi", rationale: "needs cto" },
			childRunPreview: "Done: invoices reviewed",
			assistantText: "Done: invoices reviewed",
		});
	});

	it("failed runs carry a structured error with the run metadata message", () => {
		const state = homeRunToTaskState(
			makeRun({
				status: "failed",
				metadata: { error: "kernel exploded" },
			}) as Parameters<typeof homeRunToTaskState>[0],
		);
		expect(state.status).toBe("failed");
		expect(state.error).toMatchObject({
			code: -32_603,
			message: "kernel exploded",
		});
	});

	it("requires_approval directs the caller to the durable approval tools", () => {
		const state = homeRunToTaskState(
			makeRun({ status: "requires_approval" }) as Parameters<
				typeof homeRunToTaskState
			>[0],
		);
		expect(state.status).toBe("input_required");
		expect(state.inputRequests).toMatchObject({
			approval: {
				homeRunId: "run_1",
				approveWith: "respond_home_approval",
				rejectWith: "respond_home_approval",
				planOnlyApproveWith: "approve_home_plan",
			},
		});
	});
});

describe("buildHomeTaskHandlers — get", () => {
	it("calls kernelRuntime/readRun via the service binding with the caller org header", async () => {
		const { env, fetchMock } = makeEnv(async (request) => {
			expect(request.url).toBe("https://api/rpc/kernelRuntime/readRun");
			const headers = request.headers;
			expect(headers.get("X-Service-Binding")).toBe("true");
			expect(headers.get("X-Tedix-Org-Id")).toBe(ORG_ID);
			expect(await request.json()).toEqual({
				json: { runId: "run_1" },
			});
			return okRunResponse(makeRun());
		});

		const handlers = buildHomeTaskHandlers({
			env,
			organizationId: ORG_ID,
			callerScopes: ["mcp:tedis.read"],
		});
		const state = await handlers.get({ taskId: "run_1" });
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(
			(fetchMock.mock.calls[0]?.[0] as Request).headers.get(
				"X-Tedix-Tedi-Scopes",
			),
		).toBe("mcp:tedis.read tedis:read");
		expect(state).toMatchObject({
			taskId: "run_1",
			status: "working",
			createdAt: "2026-06-10T10:00:00.000Z",
			lastUpdatedAt: "2026-06-10T10:00:05.000Z",
			ttlMs: null,
		});
	});

	it("maps the org-scoped 404 (missing OR cross-org run) to task not-found", async () => {
		// apps/api kernelRuntime.readRun scopes the row query by the caller org —
		// a run id belonging to another org returns the same NOT_FOUND.
		const { env } = makeEnv(async () =>
			orpcErrorResponse(404, "NOT_FOUND", "Home run not found"),
		);
		const handlers = buildHomeTaskHandlers({ env, organizationId: ORG_ID });
		const error = await handlers
			.get({ taskId: "run_other_org" })
			.then(() => undefined)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(McpTaskError);
		expect((error as McpTaskError).code).toBe(-32_602);
		expect((error as McpTaskError).message).toBe("Task not found");
		expect((error as McpTaskError).data).toEqual({ taskId: "run_other_org" });
	});

	it("surfaces non-404 upstream failures as internal task errors", async () => {
		const { env } = makeEnv(async () =>
			orpcErrorResponse(500, "INTERNAL_SERVER_ERROR", "D1 unavailable"),
		);
		const handlers = buildHomeTaskHandlers({ env, organizationId: ORG_ID });
		const error = await handlers
			.get({ taskId: "run_1" })
			.then(() => undefined)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(McpTaskError);
		expect((error as McpTaskError).code).toBe(-32_603);
		expect((error as McpTaskError).message).toBe("D1 unavailable");
	});
});

describe("buildHomeTaskHandlers — cancel", () => {
	it("calls kernelRuntime/cancelRun and returns an ack-only handler result", async () => {
		const { env, fetchMock } = makeEnv(async (request) => {
			expect(request.url).toBe("https://api/rpc/kernelRuntime/cancelRun");
			const body = (await request.json()) as {
				json: Record<string, unknown>;
			};
			expect(body.json.runId).toBe("run_1");
			expect(typeof body.json.reason).toBe("string");
			const headers = request.headers;
			expect(headers.get("X-Tedix-Org-Id")).toBe(ORG_ID);
			return okRunResponse(makeRun({ status: "canceled" }));
		});

		const handlers = buildHomeTaskHandlers({ env, organizationId: ORG_ID });
		const result = await handlers.cancel({ taskId: "run_1" });
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(result).toBeUndefined();
	});

	it("maps 404 to task not-found and conflicts to structured errors", async () => {
		const { env } = makeEnv(async () =>
			orpcErrorResponse(409, "CONFLICT", "Home run is already terminal"),
		);
		const handlers = buildHomeTaskHandlers({ env, organizationId: ORG_ID });
		const error = await handlers
			.cancel({ taskId: "run_1" })
			.then(() => undefined)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(McpTaskError);
		expect((error as McpTaskError).code).toBe(-32_000);
		expect((error as McpTaskError).message).toBe(
			"Home run is already terminal",
		);
	});
});

describe("buildHomeTaskHandlers — update", () => {
	it("rejects tasks/update and directs callers to the durable approval tools", async () => {
		const { env, fetchMock } = makeEnv(async () => okRunResponse(makeRun()));
		const handlers = buildHomeTaskHandlers({ env, organizationId: ORG_ID });
		const error = await handlers
			.update({ taskId: "run_1", inputResponses: { approved: true } })
			.then(() => undefined)
			.catch((e: unknown) => e);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(error).toBeInstanceOf(McpTaskError);
		expect((error as McpTaskError).code).toBe(-32_000);
		expect((error as McpTaskError).message).toContain("respond_home_approval");
		expect((error as McpTaskError).data).toMatchObject({
			taskId: "run_1",
			approveWith: "respond_home_approval",
			rejectWith: "respond_home_approval",
			planOnlyApproveWith: "approve_home_plan",
		});
	});
});
