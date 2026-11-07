import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { resetPersonalDataRedactionCaches } from "./personal-data-redaction";
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

const CUSTOMER = {
	id: "cust_1",
	name: "Jane Doe",
	email: "jane@example.com",
	phone: "+1 (415) 555-0132",
	ssn: "123-45-6789",
	notes: "callback on 415-555-0132 or jane@example.com",
};

function makeTool(patch: Partial<AppTool> = {}): AppTool {
	return {
		id: "tool-row-id",
		toolId: "get_customer",
		title: "Get customer",
		description: "Reads one customer record",
		toolTypeId: "rpc",
		inputSchema: { type: "object", properties: {} },
		outputSchema: null,
		config: { transport: "rpc", endpoint: "crm/customer" },
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
		sensitiveData: true,
		...patch,
	};
}

function makeAgent(
	data: Record<string, unknown>,
	governance: Record<string, unknown> = {},
): ServerContext {
	const toolHandler = {
		execute: vi.fn(async () => ({ status: 200, data })),
		buildStructuredContent: vi.fn(
			(r: { data: Record<string, unknown> }) => r.data,
		),
		buildTextContent: vi.fn((r: { data: Record<string, unknown> }) =>
			JSON.stringify(r.data),
		),
	};
	return {
		env: { ENVIRONMENT: "test" },
		ctx: { waitUntil: vi.fn() },
		server: { server: { elicitInput: vi.fn() } },
		appId: "app-uuid",
		appSlug: "crm",
		app: { id: "app-uuid", slug: "crm", organizationId: "org-1" },
		appMetadata: null,
		appCapabilities: {},
		apiClient: {
			mcpGovernance: {
				latchRunSensitiveData: vi.fn(async () => ({
					known: true,
					latch: null,
				})),
				...governance,
			},
		},
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

beforeEach(() => resetPersonalDataRedactionCaches());

describe("personal-data redaction on sensitive tool results", () => {
	it("masks emails, phones and national identifiers when the org turned it on", async () => {
		const agent = makeAgent(CUSTOMER, {
			resolvePersonalDataRedaction: vi.fn(async () => ({ enabled: true })),
		});
		const result = await executeTool(agent, makeTool(), {}, OPTIONS);
		expect(result.isError).toBeUndefined();
		const structured = result.structuredContent as Record<string, unknown>;
		expect(structured.id).toBe("cust_1");
		expect(structured.name).toBe("Jane Doe");
		expect(structured.email).toBe("[REDACTED]");
		expect(structured.phone).toBe("[REDACTED]");
		expect(structured.ssn).toBe("[REDACTED]");
		expect(structured.notes).toBe("callback on [REDACTED] or [REDACTED]");
		expect(result.content[0]?.text).not.toContain("jane@example.com");
		expect(result._meta?.["tedix/personalDataRedaction"]).toEqual({
			masked: true,
		});
	});

	it("changes nothing when the org has it off", async () => {
		const agent = makeAgent(CUSTOMER, {
			resolvePersonalDataRedaction: vi.fn(async () => ({ enabled: false })),
		});
		const result = await executeTool(agent, makeTool(), {}, OPTIONS);
		expect(result.structuredContent).toMatchObject(CUSTOMER);
		expect(result._meta?.["tedix/personalDataRedaction"]).toBeUndefined();
	});

	it("does not mask a tool that is not declared sensitive", async () => {
		const resolvePersonalDataRedaction = vi.fn(async () => ({
			enabled: true,
		}));
		const agent = makeAgent(CUSTOMER, { resolvePersonalDataRedaction });
		const result = await executeTool(
			agent,
			makeTool({ sensitiveData: false }),
			{},
			OPTIONS,
		);
		expect(result.structuredContent).toMatchObject(CUSTOMER);
		expect(resolvePersonalDataRedaction).not.toHaveBeenCalled();
	});

	it("stays off when the gateway cannot reach the setting", async () => {
		// The resolver is absent (older API) — redaction is strictly opt-in.
		const agent = makeAgent(CUSTOMER);
		const result = await executeTool(agent, makeTool(), {}, OPTIONS);
		expect(result.structuredContent).toMatchObject(CUSTOMER);
	});
});
