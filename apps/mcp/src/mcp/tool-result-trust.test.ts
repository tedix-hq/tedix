import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SensitiveDataLatch } from "@tedix/api-contract/schemas/sensitive-data-latch";
import { TOOL_TRUST_META_KEY } from "@tedix/mcp-shared/content-sanitize";
import {
	callToolResultText,
	requireDestructiveToolApproval,
} from "./governance";
import { resetSensitiveDataLatchCaches } from "./sensitive-data-latch";
import type { AppTool, ServerContext } from "./server-context";
import { executeTool } from "./tool-execution";

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

const OPTIONS = {
	adapterScope: "primary" as const,
	resultStrategy: "merge" as const,
};

function makeTool(patch: Partial<AppTool> = {}): AppTool {
	return {
		id: "tool-row-id",
		toolId: "get_message",
		title: "Get message",
		description: "Reads one email",
		toolTypeId: "rpc",
		inputSchema: { type: "object", properties: {} },
		outputSchema: null,
		config: { transport: "rpc", endpoint: "mail/message" },
		icons: null,
		executionTaskSupport: null,
		annotations: { readOnlyHint: true },
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
		...patch,
	};
}

function makeAgent(
	data: Record<string, unknown>,
	governance: Record<string, unknown> = {},
): ServerContext {
	const mcpGovernance = {
		latchRunSensitiveData: vi.fn(async () => ({
			known: true,
			latch: null,
		})),
		...governance,
	};
	const toolHandler = {
		execute: vi.fn(async () => ({ status: 200, data })),
		buildStructuredContent: vi.fn(
			(r: { data: Record<string, unknown> }) => r.data,
		),
		buildTextContent: vi.fn(() => "ok"),
	};
	return {
		env: { ENVIRONMENT: "test" },
		ctx: { waitUntil: vi.fn() },
		server: { server: { elicitInput: vi.fn() } },
		appId: "app-uuid",
		appSlug: "google-gmail",
		app: { id: "app-uuid", slug: "google-gmail", organizationId: "org-1" },
		appMetadata: null,
		appCapabilities: {},
		apiClient: { mcpGovernance },
		toolHandler,
		callerIdentity: {
			authType: "tedi",
			tediId: "tedi-1",
			skillRunId: "run-1",
			organizationId: "org-1",
			scopes: ["mcp:tools.call"],
		},
		traceId: "trace-1",
		registeredTools: new Map(),
		registeredResources: new Map(),
		registeredResourceTemplates: new Map(),
		registeredPrompts: new Map(),
		registeredWidgetResourceUris: new Set(),
		toolOutputTemplates: new Map(),
	} as unknown as ServerContext;
}

const gmailReadTool = () =>
	makeTool({
		toolTypeId: "mcp",
		config: {
			transport: "mcp",
			mcpServerUrl: "https://gmail.example.com/mcp",
			mcpToolName: "get_message",
		},
	});

beforeEach(() => resetSensitiveDataLatchCaches());

describe("third-party content sanitization", () => {
	it("strips hidden characters and unsafe HTML from an upstream-MCP result and labels it untrusted", async () => {
		const hidden = String.fromCharCode(0x200b, 0x202e, 0x202c, 0x2060);
		const agent = makeAgent({
			id: "msg_1",
			webUrl: "https://mail.example/m/1?a=1&b=2",
			count: 3,
			body: `Hi${hidden}<script>steal()</script>, click <a href="javascript:x">here</a>`,
		});
		const result = await executeTool(agent, gmailReadTool(), {}, OPTIONS);
		expect(result.isError).toBeUndefined();
		const structured = result.structuredContent as Record<string, unknown>;
		expect(structured.id).toBe("msg_1");
		expect(structured.webUrl).toBe("https://mail.example/m/1?a=1&b=2");
		expect(structured.count).toBe(3);
		expect(structured.body).toBe("Hi, click <a>here</a>");
		expect(result._meta?.[TOOL_TRUST_META_KEY]).toEqual({
			integrity: "untrusted",
			confidentiality: "public",
		});
	});

	it("sanitizes thrown upstream errors before returning them to Code Mode", async () => {
		const agent = makeAgent({});
		vi.mocked(agent.toolHandler.execute).mockRejectedValueOnce(
			new Error("&#x202e;Failed<script>steal()</script>"),
		);
		const result = await executeTool(
			agent,
			gmailReadTool(),
			{},
			{
				...OPTIONS,
				executionId: "execution-1",
			},
		);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({ error: "Failed" });
		expect(result.content).toEqual([{ type: "text", text: "Error: Failed" }]);
		expect(result._meta?.[TOOL_TRUST_META_KEY]).toEqual({
			integrity: "untrusted",
			confidentiality: "public",
		});
	});

	it("leaves first-party transport results untouched and labels them trusted", async () => {
		const dirty = `id${String.fromCharCode(0x200b)}`;
		const agent = makeAgent({ id: dirty });
		const result = await executeTool(agent, makeTool(), {}, OPTIONS);
		expect(result.structuredContent).toMatchObject({ id: dirty });
		expect(result._meta?.[TOOL_TRUST_META_KEY]).toEqual({
			integrity: "trusted",
			confidentiality: "public",
		});
	});

	it("labels a declared sensitive tool private", async () => {
		const agent = makeAgent({});
		const result = await executeTool(
			agent,
			makeTool({ sensitiveData: true }),
			{},
			OPTIONS,
		);
		expect(result._meta?.[TOOL_TRUST_META_KEY]).toMatchObject({
			confidentiality: "private",
		});
	});
});

describe("untrusted reads and the sensitive-data latch", () => {
	const LATCH: SensitiveDataLatch = {
		version: 1,
		latchedAt: "2026-11-05T10:00:00.000Z",
		source: {
			appSlug: "google-gmail",
			toolId: "get_message",
			connectionProviderId: null,
			reason: "untrusted_source",
		},
	};

	it("latches the run so a later public-egress tool needs approval", async () => {
		const latchRunSensitiveData = vi.fn(async () => ({
			known: true,
			latch: LATCH,
		}));
		const agent = makeAgent({ body: "hello" }, { latchRunSensitiveData });
		await executeTool(agent, gmailReadTool(), {}, OPTIONS);
		expect(latchRunSensitiveData).toHaveBeenCalledWith(
			expect.objectContaining({
				runRef: { kind: "skill_run", id: "run-1" },
				source: expect.objectContaining({
					toolDeclaredSensitive: false,
					untrustedSource: true,
				}),
			}),
		);

		const resolveRunSensitiveDataLatch = vi.fn(async () => ({
			known: true,
			latch: LATCH,
		}));
		const latched = {
			...agent,
			apiClient: {
				mcpGovernance: { resolveRunSensitiveDataLatch },
			},
		} as unknown as ServerContext;
		const refused = await requireDestructiveToolApproval(
			latched,
			{
				toolId: "slack_post",
				title: "Post to Slack",
				publicEgress: true,
				config: { transport: "rpc", endpoint: "slack/post" },
			},
			{ readOnlyHint: false },
		);
		expect(refused?.isError).toBe(true);
		expect(callToolResultText(refused!)).toContain(
			"read data marked sensitive",
		);
	});

	it("does not latch a first-party read or an untrusted write", async () => {
		const latchRunSensitiveData = vi.fn(async () => ({
			known: true,
			latch: LATCH,
		}));
		const rpcRead = await executeTool(
			makeAgent({ ok: true }, { latchRunSensitiveData }),
			makeTool(),
			{},
			OPTIONS,
		);
		expect(rpcRead.isError).toBeUndefined();
		const untrustedWrite = await executeTool(
			makeAgent({ ok: true }, { latchRunSensitiveData }),
			makeTool({
				toolId: "post_comment",
				toolTypeId: "mcp",
				annotations: { readOnlyHint: false },
				config: {
					transport: "mcp",
					mcpServerUrl: "https://gmail.example.com/mcp",
					mcpToolName: "post_comment",
				},
			}),
			{},
			OPTIONS,
		);
		expect(untrustedWrite.isError).toBeUndefined();
		expect(latchRunSensitiveData).not.toHaveBeenCalled();
	});
});
