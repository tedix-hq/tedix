import {
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vite-plus/test";
import { ToolHandler, type ToolExecutionContext } from "./handler";
import type { AppTool, ServerContext } from "./server-context";
import { enteredSpans } from "../../test/stubs/cloudflare-workers";

vi.mock("./utils/analytics", async () => {
	const actual =
		await vi.importActual<typeof import("./utils/analytics")>(
			"./utils/analytics",
		);
	return {
		...actual,
		trackMcpEvent: vi.fn(),
		emitMcpAuditEvent: vi.fn(),
	};
});

const createGenericTaskMock = vi.fn(async () => {});
const setGenericTaskWorkflowIdMock = vi.fn(async () => {});
vi.mock("./generic-task-store", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./generic-task-store")>();
	return {
		...actual,
		createGenericTask: (...args: unknown[]) =>
			createGenericTaskMock(...(args as [])),
		setGenericTaskWorkflowId: (...args: unknown[]) =>
			setGenericTaskWorkflowIdMock(...(args as [])),
	};
});

import { executeTool } from "./tool-execution";
import { emitMcpAuditEvent, trackMcpEvent } from "./utils/analytics";

interface FakeRpcResult {
	status: number;
	data: Record<string, unknown>;
	tokensUsed?: number;
	providerConfirmation?: string;
	osGadgetTask?: {
		taskId: string;
		status: "working";
		ttlMs: null;
		pollIntervalMs: number;
	};
	readObservation?: Record<string, unknown>;
}

const trackSpy = trackMcpEvent as unknown as MockInstance;
const auditSpy = emitMcpAuditEvent as unknown as MockInstance;

beforeEach(() => {
	trackSpy.mockClear();
	auditSpy.mockClear();
	enteredSpans.length = 0;
});

function makeTool(): AppTool {
	return {
		id: "tool-row-id",
		toolId: "fetch_report",
		title: "Fetch Report",
		description: "Fetches a report",
		toolTypeId: "rpc",
		inputSchema: { type: "object", properties: {} },
		outputSchema: null,
		config: {
			transport: "rpc",
			endpoint: "reports/fetch",
		},
		icons: null,
		executionTaskSupport: null,
		annotations: null,
		meta: null,
		invocationStatus: null,
		fileParams: null,
		adapterScope: null,
		resultStrategy: null,
		outputTemplate: null,
		widgetKey: null,
		widgetRoute: null,
		widgetAccessible: null,
		visibility: null,
		widgetDescription: null,
		widgetPrefersBorder: null,
		widgetDomain: null,
		schemaDialect: null,
		schemaSource: null,
		schemaSourceRef: null,
		schemaSourceHash: null,
		schemaSyncedAt: null,
		sortOrder: null,
		enabled: true,
		createdAt: null,
		updatedAt: null,
	};
}

function makeGmailSendTool(): AppTool {
	return {
		...makeTool(),
		toolId: "gmail_send",
		title: "Send email",
		config: {
			transport: "external",
			method: "POST",
			baseUrl: "https://gmail.googleapis.com",
			endpoint: "gmail/v1/users/me/messages/send",
			bodyEncoding: "gmail-rfc2822",
		},
	};
}

function makeGraphMaintenanceTool(): AppTool {
	return {
		...makeTool(),
		toolId: "graph_maintenance",
		title: "Graph Maintenance",
		config: {
			transport: "rpc",
			endpoint: "memoryGraph/graph/maintenance",
		},
	};
}

function makeAggregateTediMessageTool(): AppTool {
	return {
		...makeTool(),
		toolId: "cto__run_tedi_turn",
		title: "cto__run_tedi_turn",
		toolTypeId: "mcp",
		config: {
			transport: "mcp",
			mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
			mcpToolName: "run_tedi_turn",
			_aggregateTediId: "cto-tedi-id",
		},
	};
}

function makeOsGadgetRunTool(): AppTool {
	return {
		...makeTool(),
		toolId: "run_os_gadget",
		title: "Run OS Gadget",
		config: {
			transport: "rpc",
			endpoint: "osWorkspaces/gadgets/run",
		},
	};
}

function makeAgent(result: FakeRpcResult): ServerContext {
	const toolHandler = {
		execute: vi.fn(async () => result),
		buildStructuredContent: vi.fn(
			(r: FakeRpcResult, _ctx: ToolExecutionContext) => r.data,
		),
		buildTextContent: vi.fn((r: FakeRpcResult) =>
			r.status >= 400 ? `Error: ${String(r.data.error)}` : "ok",
		),
	};

	return {
		env: { ENVIRONMENT: "test", GIT_SHA: "1234567890abcdef" },
		ctx: { waitUntil: vi.fn() },
		appId: "app-uuid",
		appSlug: "test-app",
		app: {
			id: "app-uuid",
			slug: "test-app",
			name: "Test App",
			organizationId: "org-uuid",
		},
		appMetadata: null,
		appCapabilities: {},
		apiClient: {},
		toolHandler,
		callerIdentity: {
			authType: "oauth",
			userId: "user-uuid",
			tediId: "tedi-uuid",
			clientId: "oauth-client-id",
			scopes: ["mcp:tools.call", "mcp:observe"],
		},
		traceId: "trace-uuid",
		connectionLabel: undefined,
		bearerToken: undefined,
		upstreamAppId: undefined,
		registeredTools: new Map(),
		registeredResources: new Map(),
		registeredResourceTemplates: new Map(),
		registeredPrompts: new Map(),
		registeredWidgetResourceUris: new Set(),
		toolOutputTemplates: new Map(),
	} as unknown as ServerContext;
}

it("traces native and Code Mode tool calls without recording tenant input", async () => {
	const agent = makeAgent({ status: 200, data: { content: "private result" } });
	const tool = makeTool();
	const args = { privateInput: "private request" };

	await executeTool(agent, tool, args, {
		adapterScope: "primary",
		resultStrategy: "merge",
	});
	await executeTool(agent, tool, args, {
		adapterScope: "primary",
		resultStrategy: "merge",
		executionId: "code-exec-uuid",
	});

	expect(enteredSpans).toEqual([
		{
			name: "tedix.mcp.tool_call",
			attributes: {
				"tedix.trace_id": "trace-uuid",
				"tedix.app_id": "app-uuid",
				"tedix.tool_id": "fetch_report",
			},
		},
		{
			name: "tedix.mcp.tool_call",
			attributes: {
				"tedix.trace_id": "trace-uuid",
				"tedix.app_id": "app-uuid",
				"tedix.tool_id": "fetch_report",
				"tedix.execution_id": "code-exec-uuid",
			},
		},
	]);
});

it("logs handler cause chains while preserving the MCP error result", async () => {
	const agent = makeAgent({ status: 200, data: {} });
	(agent.toolHandler.execute as unknown as MockInstance).mockRejectedValueOnce(
		new Error("handler unavailable for secret", {
			cause: new Error("upstream dropped secret"),
		}),
	);
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const result = await executeTool(
			agent,
			makeTool(),
			{ privateInput: "secret" },
			{
				adapterScope: "primary",
				resultStrategy: "merge",
			},
		);
		expect(result.isError).toBe(true);
		expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
			event: "tool_execution.handler_failed",
			appId: "app-uuid",
			toolName: "fetch_report",
			exception: {
				type: "Error",
				message: "Content omitted",
				cause: { type: "Error", message: "Content omitted" },
			},
		});
		expect(JSON.stringify(errorSpy.mock.calls[0]?.[0])).not.toContain("secret");
	} finally {
		errorSpy.mockRestore();
	}
});

it("routes a selected organization through its own caller context and rejects other tools", async () => {
	const base = makeAgent({ status: 200, data: { ok: true } });
	const agent = {
		...base,
		appSlug: "connect",
		app: { ...base.app, slug: "connect", organizationId: null },
		appMetadata: { mcpConfig: { multiOrgConsent: true } },
		callerIdentity: {
			...base.callerIdentity!,
			verifiedMultiOrgOrganizations: [
				{
					organizationId: "org-1",
					descopeTenantId: "tenant-1",
					gatewaySlug: "tedix",
				},
				{
					organizationId: "org-2",
					descopeTenantId: "tenant-2",
					gatewaySlug: "sample",
				},
			],
		},
	} as unknown as ServerContext;
	const tool = {
		...makeTool(),
		toolId: "sample__fetch_report",
		config: {
			transport: "rpc",
			endpoint: "reports/fetch",
			_multiOrgOrganizationId: "org-2",
		},
	};
	await executeTool(
		agent,
		tool,
		{},
		{ adapterScope: "primary", resultStrategy: "merge" },
	);
	expect(agent.toolHandler.execute).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			callerIdentity: expect.objectContaining({
				organizationId: "org-2",
				tediId: undefined,
				userId: "user-uuid",
				authType: "oauth",
				scopes: base.callerIdentity!.scopes,
			}),
		}),
	);
	expect(agent.callerIdentity?.tediId).toBe("tedi-uuid");
	// Exercise the real credential dispatch, not only the mocked handler context.
	const apiFetch = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request =
				input instanceof Request ? input : new Request(input, init);
			expect(request.url).toContain("connections/fetchOrgToken");
			expect(request.headers.get("X-Tedix-Tedi-Id")).toBeNull();
			expect(request.headers.get("X-Tedix-Acting-User")).toBe("user-uuid");
			expect(request.headers.get("X-Tedix-Org-Id")).toBe("org-2");
			expect(await request.json()).toMatchObject({
				json: { organizationId: "org-2", userId: "user-uuid", scope: "user" },
			});
			return Response.json({
				json: { accessToken: "personal-provider-token" },
			});
		},
	);
	const providerFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			"Bearer personal-provider-token",
		);
		return Response.json({ id: "calendar" });
	});
	vi.stubGlobal("fetch", providerFetch);
	try {
		const result = await executeTool(
			{
				...agent,
				env: {
					...agent.env,
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
				toolHandler: new ToolHandler(),
				callerIdentity: {
					...agent.callerIdentity!,
					scopes: ["connections.execute"],
				},
			},
			{
				...tool,
				config: {
					transport: "external",
					method: "GET",
					baseUrl: "https://graph.microsoft.com",
					endpoint: "v1.0/me/calendar",
					_multiOrgOrganizationId: "org-2",
					auth: {
						type: "connection",
						connectionId: "connect-human-routing-test",
						credentialScope: "user",
					},
				},
			},
			{},
			{ adapterScope: "primary", resultStrategy: "merge" },
		);
		expect(result.isError).not.toBe(true);
		expect(apiFetch).toHaveBeenCalledTimes(1);
		expect(providerFetch).toHaveBeenCalledTimes(1);
	} finally {
		vi.unstubAllGlobals();
	}
	for (const denied of [
		{ ...tool, config: { ...tool.config, _multiOrgOrganizationId: "other" } },
		{ ...tool, toolId: "tedix__fetch_report" },
		{
			...tool,
			toolId: "unscoped",
			config: { transport: "rpc", endpoint: "reports/fetch" },
		},
	]) {
		await expect(
			executeTool(
				agent,
				denied,
				{},
				{ adapterScope: "primary", resultStrategy: "merge" },
			),
		).rejects.toThrow("outside the selected organizations");
	}
});

describe("executeTool home soft-deadline ack (honest text on queued turns)", () => {
	it("attests a successful configured collection read outside model data", async () => {
		const tool = {
			...makeTool(),
			toolId: "get_message",
			writeCapability: "read" as const,
			annotations: { readOnlyHint: true },
			config: {
				transport: "mcp" as const,
				endpoint: "",
				auth: { type: "connection", connectionId: "google-gmail" },
				_sourceAppId: "00000000-0000-4000-8000-000000000001",
				_sourceAppSlug: "google-gmail",
				readCollection: "messages",
			},
		};
		const result = await executeTool(
			makeAgent({ status: 200, data: { id: "message-1" } }),
			tool,
			{},
			{ adapterScope: "primary", resultStrategy: "merge" },
		);
		expect(result._meta["io.tedix/readCollection"]).toMatchObject({
			kind: "connected_collection_read",
			source: {
				appId: "00000000-0000-4000-8000-000000000001",
				appSlug: "google-gmail",
				toolName: "get_message",
				connectionProviderId: "google-gmail",
			},
			collection: "messages",
		});
		expect(result.structuredContent).toMatchObject({ id: "message-1" });
		expect(JSON.stringify(result.structuredContent)).not.toContain(
			"connected_collection_read",
		);
		const failed = await executeTool(
			makeAgent({ status: 503, data: { error: "unavailable" } }),
			tool,
			{},
			{ adapterScope: "primary", resultStrategy: "merge" },
		);
		expect(failed._meta["io.tedix/readCollection"]).toBeUndefined();
	});

	it("records an unclassified read without guessing from the tool name", async () => {
		const tool = {
			...makeTool(),
			toolId: "search_threads",
			writeCapability: "read" as const,
			annotations: { readOnlyHint: true },
			config: {
				transport: "mcp" as const,
				endpoint: "",
				auth: { type: "connection", connectionId: "google-gmail" },
				_sourceAppId: "00000000-0000-4000-8000-000000000001",
				_sourceAppSlug: "google-gmail",
			},
		};
		const result = await executeTool(
			makeAgent({ status: 200, data: { threads: [] } }),
			tool,
			{},
			{ adapterScope: "primary", resultStrategy: "merge" },
		);
		expect(result._meta["io.tedix/readCollection"]).toMatchObject({
			collection: null,
			source: { toolName: "search_threads" },
		});
		const write = await executeTool(
			makeAgent({ status: 200, data: { id: "message-1" } }),
			{
				...tool,
				writeCapability: "write",
				annotations: { readOnlyHint: false },
			},
			{},
			{ adapterScope: "primary", resultStrategy: "merge" },
		);
		expect(write._meta["io.tedix/readCollection"]).toBeUndefined();
	});

	it("keeps a trusted read observation in protocol metadata, outside model data", async () => {
		const observation = { kind: "docs_file_observation", receiptId: "receipt" };
		const result = await executeTool(
			makeAgent({
				status: 200,
				data: { content: "hello" },
				readObservation: observation,
			}),
			makeTool(),
			{},
			{ adapterScope: "primary", resultStrategy: "merge" },
		);
		expect(result._meta["io.tedix/readObservation"]).toEqual(observation);
		expect(result.structuredContent).toMatchObject({ content: "hello" });
	});
	function makeHomeEnqueueTool(): AppTool {
		const tool = makeTool();
		return {
			...tool,
			toolId: "ask",
			title: "ask",
			config: {
				transport: "rpc",
				endpoint: "kernelRuntime/enqueueMessage",
				_emitTaskLinkage: true,
			},
		};
	}

	it("prepends the ack text block when the RPC result is the queued shape", async () => {
		const agent = makeAgent({
			status: 200,
			data: {
				status: "queued",
				run: { id: "home_run_42", status: "running" },
				task: { id: "home_run_42", pollWith: "tasks/get" },
			},
		});
		const result = await executeTool(
			agent,
			makeHomeEnqueueTool(),
			{ content: "check my Gmail" },
			{ adapterScope: "primary", resultStrategy: "merge" },
		);

		expect(result.content).toHaveLength(2);
		expect(result.content[0]?.text).toBe(
			"Working on it — this turn continues in the background. Poll tasks/get with task id home_run_42 or read_home_run for the result; the Home transcript receives the answer when ready.",
		);
		// The JSON payload block is untouched, and the ack never leaks into
		// structuredContent (the run object stays exactly as returned).
		expect(result.content[1]?.text).toBe("ok");
		expect(result.structuredContent).toMatchObject({
			status: "queued",
			run: { id: "home_run_42", status: "running" },
		});
		expect(result.isError).toBeUndefined();
	});

	it("keeps fast-turn output identical (assistantMessage present → single block)", async () => {
		const agent = makeAgent({
			status: 200,
			data: {
				status: "needs_delegation",
				run: { id: "home_run_42", status: "completed" },
				assistantMessage: {
					id: "home_run_42:assistant",
					content: "Here is your answer.",
				},
			},
		});
		const result = await executeTool(
			agent,
			makeHomeEnqueueTool(),
			{ content: "check my Gmail" },
			{ adapterScope: "primary", resultStrategy: "merge" },
		);

		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
	});

	it("never synthesizes the ack for tools without _emitTaskLinkage", async () => {
		const agent = makeAgent({
			status: 200,
			data: {
				status: "queued",
				run: { id: "home_run_42", status: "running" },
			},
		});
		const result = await executeTool(
			agent,
			makeTool(),
			{},
			{ adapterScope: "primary", resultStrategy: "merge" },
		);

		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
	});
});

describe("executeTool provider completion evidence", () => {
	it("carries only a trusted adapter confirmation into structured content", async () => {
		const agent = makeAgent({
			status: 200,
			data: { id: "msg_1", threadId: "thread_1" },
			providerConfirmation: "gmail-message:msg_1",
		});
		const result = await executeTool(
			agent,
			makeGmailSendTool(),
			{ to: "recipient@example.com", subject: "Hello", body: "Body" },
			{ adapterScope: "primary", resultStrategy: "merge" },
		);

		expect(result.structuredContent).toMatchObject({
			id: "msg_1",
			completionEvidence: {
				operation: "gmail_send",
				status: "succeeded",
				providerConfirmation: "gmail-message:msg_1",
			},
		});
	});

	it("does not infer confirmation from a successful provider ID", async () => {
		const result = await executeTool(
			makeAgent({ status: 200, data: { id: "msg_1" } }),
			makeGmailSendTool(),
			{},
			{ adapterScope: "primary", resultStrategy: "merge" },
		);

		expect(result.structuredContent).not.toHaveProperty("completionEvidence");
	});
});

describe("executeTool Code Mode inner-call telemetry", () => {
	it("emits success false for status>=400 handler results with caller metadata", async () => {
		const agent = makeAgent({
			status: 500,
			data: { error: "upstream failed" },
		});
		const result = await executeTool(
			agent,
			makeTool(),
			{ reportId: "rpt-1" },
			{
				adapterScope: "primary",
				resultStrategy: "merge",
				executionId: "code-exec-uuid",
			},
		);

		expect(result.isError).toBe(true);
		expect(trackSpy).toHaveBeenCalledTimes(1);
		expect(auditSpy).toHaveBeenCalledTimes(1);
		const executeMock = agent.toolHandler.execute as unknown as MockInstance;
		expect(executeMock).toHaveBeenCalledTimes(1);
		expect(executeMock.mock.calls[0]?.[1]).toMatchObject({
			traceId: "trace-uuid",
			executionId: "code-exec-uuid",
		});
		expect(trackSpy.mock.calls[0]?.[1]).toMatchObject({
			eventType: "tool_call",
			appId: "app-uuid",
			appSlug: "test-app",
			organizationId: "org-uuid",
			toolName: "fetch_report",
			success: false,
			errorMessage: "Error: upstream failed",
			tediId: "tedi-uuid",
			userId: "user-uuid",
			clientId: "oauth-client-id",
			authType: "oauth",
			traceId: "trace-uuid",
			executionId: "code-exec-uuid",
			metadata: {
				delegationMode: "human_to_tedi",
				agentTediId: "tedi-uuid",
				subjectUserId: "user-uuid",
				oauthClientId: "oauth-client-id",
				grantedScopeCount: 2,
			},
		});
	});

	it("keeps a graph maintenance handle raw inside Code Mode", async () => {
		const agent = makeAgent({
			status: 200,
			data: {
				task: {
					id: "graph-gds-abc",
					status: "queued",
					createdAt: "2026-07-28T00:00:00.000Z",
					lastUpdatedAt: "2026-07-28T00:00:00.000Z",
					pollIntervalMs: 2500,
				},
			},
		});
		const result = await executeTool(
			agent,
			makeGraphMaintenanceTool(),
			{},
			{
				adapterScope: "primary",
				resultStrategy: "merge",
				executionId: "code-exec-uuid",
				clientSupportsTasks: true,
			},
		);

		expect(
			(result._meta as Record<string, unknown>)["tedix/genericTask"],
		).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			task: { id: "graph-gds-abc", status: "queued" },
		});
	});

	it("does not reinterpret a graph-shaped result from another endpoint", async () => {
		const agent = makeAgent({
			status: 200,
			data: {
				task: {
					id: "graph-gds-spoofed",
					status: "queued",
					createdAt: "2026-07-28T00:00:00.000Z",
					lastUpdatedAt: "2026-07-28T00:00:00.000Z",
				},
			},
		});
		const result = await executeTool(
			agent,
			makeTool(),
			{},
			{
				adapterScope: "primary",
				resultStrategy: "merge",
				clientSupportsTasks: true,
			},
		);

		expect(
			(result._meta as Record<string, unknown>)["tedix/genericTask"],
		).toBeUndefined();
	});
});

describe("executeTool graph maintenance MCP Task bridge", () => {
	it("publishes the native task marker for a top-level task-capable client", async () => {
		const agent = makeAgent({
			status: 200,
			data: {
				task: {
					id: "graph-gds-abc",
					status: "queued",
					createdAt: "2026-07-28T00:00:00.000Z",
					lastUpdatedAt: "2026-07-28T00:00:00.000Z",
					pollIntervalMs: 2500,
				},
			},
		});
		const result = await executeTool(
			agent,
			makeGraphMaintenanceTool(),
			{},
			{
				adapterScope: "primary",
				resultStrategy: "merge",
				clientSupportsTasks: true,
			},
		);

		expect(
			(result._meta as Record<string, unknown>)["tedix/genericTask"],
		).toEqual({
			taskId: "graph-gds-abc",
			status: "working",
			createdAt: "2026-07-28T00:00:00.000Z",
			lastUpdatedAt: "2026-07-28T00:00:00.000Z",
			ttlMs: null,
			pollIntervalMs: 2500,
		});
		expect(result.structuredContent).toMatchObject({
			task: { id: "graph-gds-abc", status: "queued" },
		});
	});
});

describe("executeTool aggregate tedi MCP Task bridge", () => {
	it("publishes the trusted namespaced tedi task for a capable top-level caller", async () => {
		const agent = makeAgent({
			status: 200,
			data: {
				ok: true,
				pending: true,
				task: {
					id: "tedi:cto-tedi-id:run-42",
					pollWith: "tasks/get",
				},
			},
		});
		const result = await executeTool(
			agent,
			makeAggregateTediMessageTool(),
			{},
			{
				adapterScope: "primary",
				resultStrategy: "merge",
				clientSupportsTasks: true,
			},
		);

		expect(
			(result._meta as Record<string, unknown>)["tedix/genericTask"],
		).toEqual({
			taskId: "tedi:cto-tedi-id:run-42",
			status: "working",
			createdAt: undefined,
			lastUpdatedAt: undefined,
			ttlMs: null,
			pollIntervalMs: 2500,
		});
	});

	it("keeps the task link as data for Code Mode inner calls", async () => {
		const agent = makeAgent({
			status: 200,
			data: {
				task: {
					id: "tedi:cto-tedi-id:run-42",
					pollWith: "tasks/get",
				},
			},
		});
		const result = await executeTool(
			agent,
			makeAggregateTediMessageTool(),
			{},
			{
				adapterScope: "primary",
				resultStrategy: "merge",
				executionId: "code-exec-1",
				clientSupportsTasks: true,
			},
		);

		expect(
			(result._meta as Record<string, unknown>)["tedix/genericTask"],
		).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			task: { id: "tedi:cto-tedi-id:run-42" },
		});
	});
});

describe("executeTool governed OS Gadget MCP Task bridge", () => {
	const taskMarker = {
		taskId: "os-gadget-11111111-1111-4111-8111-111111111111",
		status: "working" as const,
		ttlMs: null,
		pollIntervalMs: 2_500,
	};

	function makeOsGadgetAgent(): ServerContext {
		return makeAgent({
			status: 200,
			data: {
				execution: {
					id: "11111111-1111-4111-8111-111111111111",
					status: "queued",
				},
			},
			osGadgetTask: taskMarker,
		});
	}

	it("publishes the internal marker without polluting structuredContent", async () => {
		const result = await executeTool(
			makeOsGadgetAgent(),
			makeOsGadgetRunTool(),
			{},
			{
				adapterScope: "primary",
				resultStrategy: "merge",
				clientSupportsTasks: true,
			},
		);

		expect(
			(result._meta as Record<string, unknown>)["tedix/genericTask"],
		).toEqual(taskMarker);
		expect(result.structuredContent).toMatchObject({
			execution: {
				id: "11111111-1111-4111-8111-111111111111",
				status: "queued",
			},
		});
		expect(result.structuredContent).not.toHaveProperty("task");
	});

	it("keeps Code Mode inner calls synchronous and schema-valid", async () => {
		const result = await executeTool(
			makeOsGadgetAgent(),
			makeOsGadgetRunTool(),
			{},
			{
				adapterScope: "primary",
				resultStrategy: "merge",
				executionId: "code-exec-1",
				clientSupportsTasks: true,
			},
		);

		expect(
			(result._meta as Record<string, unknown>)["tedix/genericTask"],
		).toBeUndefined();
		expect(result.structuredContent).not.toHaveProperty("task");
	});

	it("does not expose a task marker to clients without Tasks support", async () => {
		const result = await executeTool(
			makeOsGadgetAgent(),
			makeOsGadgetRunTool(),
			{},
			{
				adapterScope: "primary",
				resultStrategy: "merge",
				clientSupportsTasks: false,
			},
		);

		expect(
			(result._meta as Record<string, unknown>)["tedix/genericTask"],
		).toBeUndefined();
		expect(result.structuredContent).not.toHaveProperty("task");
	});
});

describe("executeTool generic async task gate (_asyncTask + clientSupportsTasks)", () => {
	function makeAsyncTool(): AppTool {
		return {
			...makeTool(),
			toolId: "long_running_job",
			title: "Long Running Job",
			config: {
				transport: "rpc",
				endpoint: "jobs/run",
				_asyncTask: true,
			},
		};
	}

	function makeAsyncAgent(): ServerContext {
		const agent = makeAgent({ status: 200, data: { ok: true } });
		const workflowCreate = vi.fn(async () => ({ id: "wf-instance-1" }));
		(agent as unknown as { env: Record<string, unknown> }).env = {
			ENVIRONMENT: "test",
			GIT_SHA: "1234567890abcdef",
			DB: {},
			GENERIC_TASKS_WORKFLOW: { create: workflowCreate },
		};
		return agent;
	}

	beforeEach(() => {
		createGenericTaskMock.mockClear();
		setGenericTaskWorkflowIdMock.mockClear();
	});

	it("returns a generic task marker when the client opted into tasks", async () => {
		const agent = makeAsyncAgent();
		const result = await executeTool(
			agent,
			makeAsyncTool(),
			{ x: 1 },
			{
				adapterScope: "primary",
				resultStrategy: "merge",
				clientSupportsTasks: true,
			},
		);

		const marker = (result._meta as Record<string, unknown>)[
			"tedix/genericTask"
		] as Record<string, unknown> | undefined;
		expect(marker).toBeDefined();
		expect(String(marker?.taskId).startsWith("generic-")).toBe(true);
		expect(marker?.status).toBe("working");
		expect(createGenericTaskMock).toHaveBeenCalledTimes(1);
		// Workflow instance id is persisted onto the row after `workflow.create`.
		expect(setGenericTaskWorkflowIdMock).toHaveBeenCalledTimes(1);
		const [, persistedTaskId, , persistedWorkflowId] =
			setGenericTaskWorkflowIdMock.mock.calls[0] as unknown as [
				unknown,
				string,
				string,
				string,
			];
		expect(persistedTaskId).toBe(marker?.taskId);
		expect(persistedWorkflowId).toBe("wf-instance-1");
	});

	it("runs selected-organization tools synchronously so consent is not replayed later", async () => {
		const base = makeAsyncAgent();
		const agent = {
			...base,
			appSlug: "connect",
			app: { ...base.app, slug: "connect", organizationId: null },
			appMetadata: { mcpConfig: { multiOrgConsent: true } },
			callerIdentity: {
				...base.callerIdentity!,
				verifiedMultiOrgOrganizations: [
					{
						organizationId: "org-1",
						descopeTenantId: "tenant-1",
						gatewaySlug: "tedix",
					},
				],
			},
		} as unknown as ServerContext;
		const tool = {
			...makeAsyncTool(),
			toolId: "tedix__long_running_job",
			config: {
				transport: "rpc",
				endpoint: "jobs/run",
				_asyncTask: true,
				_multiOrgOrganizationId: "org-1",
			},
		};
		const result = await executeTool(
			agent,
			tool,
			{},
			{
				adapterScope: "primary",
				resultStrategy: "merge",
				clientSupportsTasks: true,
			},
		);
		expect(
			(result._meta as Record<string, unknown>)["tedix/genericTask"],
		).toBeUndefined();
		expect(createGenericTaskMock).not.toHaveBeenCalled();
	});

	it("does not persist a workflow id when the GENERIC_TASKS_WORKFLOW binding is absent", async () => {
		const agent = makeAsyncAgent();
		(
			agent as unknown as { env: Record<string, unknown> }
		).env.GENERIC_TASKS_WORKFLOW = undefined;
		const result = await executeTool(
			agent,
			makeAsyncTool(),
			{ x: 1 },
			{
				adapterScope: "primary",
				resultStrategy: "merge",
				clientSupportsTasks: true,
			},
		);

		const marker = (result._meta as Record<string, unknown>)[
			"tedix/genericTask"
		] as Record<string, unknown> | undefined;
		expect(marker).toBeDefined();
		expect(createGenericTaskMock).toHaveBeenCalledTimes(1);
		// Binding-absent branch: task created without an executor, no workflow id.
		expect(setGenericTaskWorkflowIdMock).not.toHaveBeenCalled();
	});

	it("runs synchronously when the client did NOT opt into tasks", async () => {
		const agent = makeAsyncAgent();
		const result = await executeTool(
			agent,
			makeAsyncTool(),
			{ x: 1 },
			{
				adapterScope: "primary",
				resultStrategy: "merge",
				clientSupportsTasks: false,
			},
		);

		expect(
			(result._meta as Record<string, unknown>)["tedix/genericTask"],
		).toBeUndefined();
		expect(createGenericTaskMock).not.toHaveBeenCalled();
		// Normal synchronous tool output.
		expect(result.content[0]?.text).toBe("ok");
	});

	it("captures caller IDENTITY references from callerIdentity (no token, no scopes)", async () => {
		const agent = makeAsyncAgent();
		(agent as unknown as { connectionLabel?: string }).connectionLabel =
			"promptwatch";
		// A bearer token is present on the agent — it must not be forwarded.
		(agent as unknown as { bearerToken?: string }).bearerToken =
			"sk-secret-bearer";
		await executeTool(
			agent,
			makeAsyncTool(),
			{ x: 1 },
			{
				adapterScope: "primary",
				resultStrategy: "merge",
				clientSupportsTasks: true,
			},
		);

		expect(createGenericTaskMock).toHaveBeenCalledTimes(1);
		const [callArg] = createGenericTaskMock.mock.calls[0] as unknown as [
			{ caller?: Record<string, unknown> },
		];
		const caller = callArg.caller;
		expect(caller).toMatchObject({
			authType: "oauth",
			userId: "user-uuid",
			tediId: "tedi-uuid",
			organizationId: "org-uuid",
			clientId: "oauth-client-id",
			connectionLabel: "promptwatch",
		});
		// Negative: identity-only — no token/scopes/credentialMode captured.
		expect(caller).not.toHaveProperty("scopes");
		expect(caller).not.toHaveProperty("credentialMode");
		expect(caller).not.toHaveProperty("token");
		expect(caller).not.toHaveProperty("bearerToken");
		// The bearer token never appears anywhere in the create input.
		expect(JSON.stringify(callArg)).not.toContain("sk-secret-bearer");
	});

	it("degrades the captured caller to a bare service caller when callerIdentity is undefined", async () => {
		const agent = makeAsyncAgent();
		(agent as unknown as { callerIdentity?: unknown }).callerIdentity =
			undefined;
		await executeTool(
			agent,
			makeAsyncTool(),
			{ x: 1 },
			{
				adapterScope: "primary",
				resultStrategy: "merge",
				clientSupportsTasks: true,
			},
		);

		expect(createGenericTaskMock).toHaveBeenCalledTimes(1);
		const [callArg] = createGenericTaskMock.mock.calls[0] as unknown as [
			{ caller?: Record<string, unknown> },
		];
		// App-only org resolves (agent.app.organizationId) under a service caller.
		expect(callArg.caller).toEqual({
			authType: "service",
			organizationId: "org-uuid",
		});
	});

	it("does NOT defer a destructive tool (runs synchronously) absent the opt-in", async () => {
		const agent = makeAsyncAgent();
		const destructiveTool: AppTool = {
			...makeAsyncTool(),
			annotations: { destructiveHint: true },
		};
		const result = await executeTool(
			agent,
			destructiveTool,
			{ x: 1 },
			{
				adapterScope: "primary",
				resultStrategy: "merge",
				clientSupportsTasks: true,
			},
		);

		// Destructive default: no deferral, no task created, synchronous output.
		expect(
			(result._meta as Record<string, unknown>)["tedix/genericTask"],
		).toBeUndefined();
		expect(createGenericTaskMock).not.toHaveBeenCalled();
		expect(result.content[0]?.text).toBe("ok");
	});

	it("DOES defer a destructive tool when allowDestructiveAsync opt-in is set", async () => {
		const agent = makeAsyncAgent();
		const destructiveOptIn: AppTool = {
			...makeAsyncTool(),
			annotations: { destructiveHint: true },
			config: {
				transport: "rpc",
				endpoint: "jobs/run",
				_asyncTask: true,
				allowDestructiveAsync: true,
			},
		};
		const result = await executeTool(
			agent,
			destructiveOptIn,
			{ x: 1 },
			{
				adapterScope: "primary",
				resultStrategy: "merge",
				clientSupportsTasks: true,
			},
		);

		const marker = (result._meta as Record<string, unknown>)[
			"tedix/genericTask"
		];
		expect(marker).toBeDefined();
		expect(createGenericTaskMock).toHaveBeenCalledTimes(1);
	});

	it("does NOT defer an external-transport tool (Workflow can't inject the credential)", async () => {
		const agent = makeAsyncAgent();
		const externalTool: AppTool = {
			...makeAsyncTool(),
			config: {
				transport: "external",
				endpoint: "jobs/run",
				_asyncTask: true,
			},
		};
		const result = await executeTool(
			agent,
			externalTool,
			{ x: 1 },
			{
				adapterScope: "primary",
				resultStrategy: "merge",
				clientSupportsTasks: true,
			},
		);

		// External transport: deferral refused, runs synchronously, no task row.
		expect(
			(result._meta as Record<string, unknown>)["tedix/genericTask"],
		).toBeUndefined();
		expect(createGenericTaskMock).not.toHaveBeenCalled();
	});

	it("does NOT defer a caller-auth-forwarding tool (Workflow can't replay user authority)", async () => {
		const agent = makeAsyncAgent();
		const forwardAuthTool: AppTool = {
			...makeAsyncTool(),
			config: {
				transport: "rpc",
				endpoint: "jobs/run",
				_asyncTask: true,
				_forwardCallerAuth: true,
			},
		};
		const result = await executeTool(
			agent,
			forwardAuthTool,
			{ x: 1 },
			{
				adapterScope: "primary",
				resultStrategy: "merge",
				clientSupportsTasks: true,
			},
		);

		// Forwarded caller auth: deferral refused, runs synchronously under live
		// authority, no task row.
		expect(
			(result._meta as Record<string, unknown>)["tedix/genericTask"],
		).toBeUndefined();
		expect(createGenericTaskMock).not.toHaveBeenCalled();
	});
});
