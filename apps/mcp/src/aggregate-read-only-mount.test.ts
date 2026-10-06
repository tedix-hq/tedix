import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
	getApiClient,
	getByDomain,
	getBySlugWithTools,
	mountMcp,
	buildMcpServer,
} = vi.hoisted(() => {
	const getByDomain = vi.fn();
	const getBySlugWithTools = vi.fn();
	return {
		getByDomain,
		getBySlugWithTools,
		getApiClient: vi.fn(() => ({ apps: { getByDomain, getBySlugWithTools } })),
		mountMcp: vi.fn(
			async () =>
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		),
		buildMcpServer: vi.fn(async () => ({}) as unknown),
	};
});

vi.mock("./lib/api-client", () => ({ getApiClient }));
vi.mock("@tedix/mcp-shared/transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/mcp-shared/transport")>()),
	mountMcp,
}));
vi.mock("./mcp/server-factory", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mcp/server-factory")>()),
	buildMcpServer,
}));

import worker from "./index";

function createEnv() {
	return {
		ENVIRONMENT: "development",
		MCP_URL: "https://mcp.tedix.tech",
		API_URL: "https://api.tedix.tech",
		MCP_UI_URL: "https://mcp-ui.tedix.tech",
		GIT_SHA: "dev",
		DESCOPE_AIH_BASE_URL: "https://api.descope.com",
		DEFAULT_APP_SLUG: "",
		DO_NOT_TRACK: "1",
		API_SERVICE: { fetch: vi.fn() },
	} as unknown as CloudflareEnv;
}

function createExecutionContext() {
	return {
		waitUntil: vi.fn((promise: Promise<unknown>) => {
			promise.catch(() => {});
		}),
		passThroughOnException: vi.fn(),
	} as unknown as ExecutionContext;
}

function tool(toolId: string, writeCapability: string | null) {
	return {
		id: `tool-${toolId}`,
		toolId,
		title: toolId,
		description: null,
		toolTypeId: "external",
		inputSchema: { type: "object", properties: {} },
		outputSchema: null,
		config: { endpoint: `https://upstream.example/${toolId}` },
		enabled: true,
		visibility: "public",
		authRequired: false,
		writeCapability,
	};
}

function appResponse(
	slug: string,
	mcpConfig: Record<string, unknown> | undefined,
	tools: Array<Record<string, unknown>>,
) {
	return {
		app: {
			id: `app-${slug}`,
			slug,
			name: slug,
			domain: null,
			organizationId: `org-${slug}`,
			description: null,
			logoUrl: null,
			customMcpDomain: null,
			openaiChallengeToken: null,
			openaiAppId: null,
			appStoreStatus: null,
			visibility: "public",
			discoveryStatus: null,
			metadata: mcpConfig ? { mcpConfig } : null,
		},
		tools,
		catalogMcp: null,
		catalogResources: [],
		catalogResourceTemplates: [],
		catalogPrompts: [] as Array<Record<string, unknown>>,
	};
}

async function mountedToolIds(hostSlug: string) {
	const response = await worker.fetch(
		new Request(`https://${hostSlug}.mcp.tedix.tech/mcp`),
		createEnv(),
		createExecutionContext(),
	);
	expect(response.status).toBe(200);
	const cached = (buildMcpServer.mock.calls[0] as unknown[])[0] as {
		tools: Array<{ toolId: string }>;
	};
	// Platform built-ins are always present; this asserts the aggregated surface.
	return cached.tools
		.map((entry) => entry.toolId)
		.filter((toolId) => toolId.startsWith("vendor__"));
}

describe("read-only aggregate mounting", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		const source = appResponse("source-app", undefined, [
			tool("read_record", "read"),
			tool("edit_record", "write"),
			tool("delete_record", "destructive"),
			// No recorded capability: unknown is not the same as safe.
			tool("legacy_record", null),
		]);
		getBySlugWithTools.mockImplementation(async ({ slug }: { slug: string }) =>
			slug === "source-app"
				? source
				: slug === "gateway-rule"
					? appResponse(
							"gateway-rule",
							{
								authMode: "public",
								aggregateApps: [
									{ slug: "source-app", prefix: "vendor", readOnly: true },
								],
							},
							[],
						)
					: appResponse(
							"gateway-open",
							{
								authMode: "public",
								aggregateApps: [{ slug: "source-app", prefix: "vendor" }],
							},
							[],
						),
		);
	});

	it("mounts only the source's read tools when the entry declares readOnly", async () => {
		expect(await mountedToolIds("gateway-rule")).toEqual([
			"vendor__read_record",
		]);
	});

	it("mounts everything the source exposes when it does not", async () => {
		expect(await mountedToolIds("gateway-open")).toEqual([
			"vendor__read_record",
			"vendor__edit_record",
			"vendor__delete_record",
			"vendor__legacy_record",
		]);
	});

	it("projects upstream prompts into the aggregate namespace with source metadata", async () => {
		const source = appResponse("prompt-source", undefined, []);
		source.catalogPrompts = [
			{
				id: "source-prompt-1",
				promptName: "summarize_page",
				title: "Summarize page",
				description: "Summarize a source page",
				arguments: [{ name: "pageId", required: true }],
				icons: [{ src: "https://source.example/icon.svg" }],
				meta: { "vendor.example/prompt": "preserved" },
			},
		];
		getBySlugWithTools.mockImplementation(async ({ slug }: { slug: string }) =>
			slug === "prompt-source"
				? source
				: appResponse(
						"gateway-prompts",
						{
							authMode: "public",
							aggregateApps: [{ slug: "prompt-source", prefix: "vendor" }],
						},
						[],
					),
		);

		await worker.fetch(
			new Request("https://gateway-prompts.mcp.tedix.tech/mcp"),
			createEnv(),
			createExecutionContext(),
		);
		const cachedData = (buildMcpServer.mock.calls[0] as unknown[])[0] as {
			catalogPrompts: Array<Record<string, unknown>>;
		};
		expect(cachedData.catalogPrompts).toMatchObject([
			{
				promptName: "vendor__summarize_page",
				upstreamPromptName: "summarize_page",
				sourceAppSlug: "prompt-source",
				title: "Summarize page",
				icons: [{ src: "https://source.example/icon.svg" }],
				meta: { "vendor.example/prompt": "preserved" },
			},
		]);
	});
});
