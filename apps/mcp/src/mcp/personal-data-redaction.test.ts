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

const enrichment = vi.hoisted(() => ({ invokeTediEnrichment: vi.fn() }));
vi.mock("./tedi-enrichment", async () => {
	const actual =
		await vi.importActual<typeof import("./tedi-enrichment")>(
			"./tedi-enrichment",
		);
	return { ...actual, invokeTediEnrichment: enrichment.invokeTediEnrichment };
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

	it("masks when the setting cannot be confirmed fresh", async () => {
		// No resolver bound: cold isolate with no answer fails closed.
		const cold = await executeTool(
			makeAgent(CUSTOMER),
			makeTool(),
			{},
			OPTIONS,
		);
		expect(JSON.stringify(cold)).not.toContain("jane@example.com");

		// An expired cached "off" is not reused when the API then fails.
		vi.useFakeTimers();
		try {
			const resolvePersonalDataRedaction = vi
				.fn()
				.mockResolvedValueOnce({ enabled: false })
				.mockRejectedValueOnce(new Error("api down"));
			const agent = makeAgent(CUSTOMER, { resolvePersonalDataRedaction });
			const off = await executeTool(agent, makeTool(), {}, OPTIONS);
			expect(off.structuredContent).toMatchObject(CUSTOMER);
			vi.advanceTimersByTime(6 * 60 * 1000);
			const stale = await executeTool(agent, makeTool(), {}, OPTIONS);
			expect((stale.structuredContent as { email: string }).email).toBe(
				"[REDACTED]",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("masks a thrown provider error", async () => {
		const agent = makeAgent(CUSTOMER, {
			resolvePersonalDataRedaction: vi.fn(async () => ({ enabled: true })),
		});
		(
			agent.toolHandler as unknown as { execute: ReturnType<typeof vi.fn> }
		).execute.mockRejectedValueOnce(
			new Error("contact jane@example.com already exists"),
		);
		const result = await executeTool(agent, makeTool(), {}, OPTIONS);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe(
			"Error: contact [REDACTED] already exists",
		);
		expect(JSON.stringify(result)).not.toContain("jane@example.com");
	});

	it("masks the Tedi enrichment output", async () => {
		enrichment.invokeTediEnrichment.mockResolvedValueOnce({
			enrichedData: { summary: "Reach Jane at jane@example.com" },
			textContent: "Jane: +1 (415) 555-0132",
			layoutSpec: { title: "jane@example.com" },
		});
		const agent = makeAgent(CUSTOMER, {
			resolvePersonalDataRedaction: vi.fn(async () => ({ enabled: true })),
		});
		(agent as unknown as { appMetadata: unknown }).appMetadata = {
			mcpConfig: { tediPolicy: { enabled: true, tediId: "tedi-enrich" } },
		};
		const result = await executeTool(agent, makeTool(), {}, OPTIONS);
		expect(enrichment.invokeTediEnrichment).toHaveBeenCalledOnce();
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("jane@example.com");
		expect(serialized).not.toContain("555-0132");
		expect(result.content[0]?.text).toBe("Jane: [REDACTED]");
	});
});
