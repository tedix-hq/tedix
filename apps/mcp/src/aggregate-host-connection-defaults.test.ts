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
		getApiClient: vi.fn(() => ({
			apps: {
				getByDomain,
				getBySlugWithTools,
			},
		})),
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

vi.mock("./lib/api-client", () => ({
	getApiClient,
}));

vi.mock("@tedix/mcp-shared/transport", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tedix/mcp-shared/transport")>();
	return {
		...actual,
		mountMcp,
	};
});

vi.mock("./mcp/server-factory", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./mcp/server-factory")>();
	return {
		...actual,
		buildMcpServer,
	};
});

import worker, {
	aggregateSurfaceCacheKey,
	applyHostConnectionDefaultsToAggregateEntries,
} from "./index";

describe("aggregate surface cache fingerprint", () => {
	it("isolates account slots in durable aggregate snapshots", () => {
		const entry = {
			slug: "outlook",
			connectionProviderId: "microsoft",
			connectionInstanceId: "11111111-1111-4111-8111-111111111111",
		};
		expect(aggregateSurfaceCacheKey([entry], "sha")).not.toBe(
			aggregateSurfaceCacheKey(
				[
					{
						...entry,
						connectionInstanceId: "22222222-2222-4222-8222-222222222222",
					},
				],
				"sha",
			),
		);
		expect(
			applyHostConnectionDefaultsToAggregateEntries([{ slug: "outlook" }], {
				connectionProviderId: "microsoft",
				connectionInstanceId: entry.connectionInstanceId,
			})[0],
		).toMatchObject({ connectionInstanceId: entry.connectionInstanceId });
	});

	it("keeps an inherited account selector paired with its tenant scope", () => {
		const slot = "11111111-1111-4111-8111-111111111111";
		expect(
			applyHostConnectionDefaultsToAggregateEntries(
				[{ slug: "calendar", connectionScope: "user" }],
				{
					connectionProviderId: "calendar",
					connectionInstanceId: slot,
					connectionScope: "tenant",
				},
			)[0],
		).toMatchObject({ connectionInstanceId: slot, connectionScope: "tenant" });
		expect(
			applyHostConnectionDefaultsToAggregateEntries(
				[
					{
						slug: "calendar",
						connectionInstanceId: "22222222-2222-4222-8222-222222222222",
						connectionScope: "user",
					},
				],
				{
					connectionProviderId: "calendar",
					connectionInstanceId: slot,
					connectionScope: "tenant",
				},
			)[0],
		).toMatchObject({
			connectionInstanceId: "22222222-2222-4222-8222-222222222222",
			connectionScope: "user",
		});
	});

	it("does not inherit a host account across a different provider", () => {
		expect(
			applyHostConnectionDefaultsToAggregateEntries(
				[
					{
						slug: "mail",
						connectionProviderId: "microsoft",
						connectionScope: "user",
					},
				],
				{
					connectionProviderId: "google",
					connectionInstanceId: "11111111-1111-4111-8111-111111111111",
					connectionScope: "tenant",
				},
			)[0],
		).toEqual({
			slug: "mail",
			connectionProviderId: "microsoft",
			connectionScope: "user",
		});
	});
	it("rolls durable cache keys across Worker deployments", () => {
		expect(aggregateSurfaceCacheKey([], "sha-a")).not.toBe(
			aggregateSurfaceCacheKey([], "sha-b"),
		);
		expect(aggregateSurfaceCacheKey([], "sha-a")).toBe(
			aggregateSurfaceCacheKey([], "sha-a"),
		);
	});

	it("rolls durable cache keys when tool projection activates", () => {
		expect(aggregateSurfaceCacheKey([], "sha-a", "epoch-a")).not.toBe(
			aggregateSurfaceCacheKey([], "sha-a", "epoch-b"),
		);
	});
});

function createExecutionContext() {
	return {
		waitUntil: vi.fn((promise: Promise<unknown>) => {
			promise.catch(() => {});
		}),
		passThroughOnException: vi.fn(),
	} as unknown as ExecutionContext;
}

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
		API_SERVICE: {
			fetch: vi.fn(),
		},
	} as unknown as CloudflareEnv;
}

interface AppFixture {
	slug: string;
	mcpConfig?: Record<string, unknown>;
	tools?: Array<Record<string, unknown>>;
	catalogResources?: Array<Record<string, unknown>>;
	catalogResourceTemplates?: Array<Record<string, unknown>>;
	catalogPrompts?: Array<Record<string, unknown>>;
}

/** Build a getBySlugWithTools response in the shape resolution.ts /
 *  resolveUpstreamToolsInternally consume. */
function appResponse({
	slug,
	mcpConfig,
	tools,
	catalogResources,
	catalogResourceTemplates,
	catalogPrompts,
}: AppFixture) {
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
		tools: tools ?? [],
		catalogMcp: null,
		catalogResources: catalogResources ?? [],
		catalogResourceTemplates: catalogResourceTemplates ?? [],
		catalogPrompts: catalogPrompts ?? [],
	};
}

function connectionTool(toolId: string, connectionId: string) {
	return {
		id: `tool-${toolId}`,
		toolId,
		title: toolId,
		description: null,
		toolTypeId: "external",
		inputSchema: { type: "object", properties: {} },
		outputSchema: null,
		config: {
			endpoint: `https://upstream.example/${toolId}`,
			auth: { type: "connection", connectionId },
		},
		enabled: true,
		visibility: "public",
		authRequired: false,
	};
}

function installFixtures(fixtures: AppFixture[]) {
	const bySlug = new Map(fixtures.map((f) => [f.slug, appResponse(f)]));
	getBySlugWithTools.mockImplementation(async ({ slug }: { slug: string }) => {
		return bySlug.get(slug) ?? { app: null, tools: [] };
	});
}

async function serveAndCaptureTools(hostSlug: string) {
	const env = createEnv();
	const response = await worker.fetch(
		new Request(`https://${hostSlug}.mcp.tedix.tech/mcp`),
		env,
		createExecutionContext(),
	);
	expect(response.status).toBe(200);
	expect(buildMcpServer).toHaveBeenCalledOnce();
	const cachedData = (buildMcpServer.mock.calls[0] as unknown[])[0] as {
		tools: Array<{
			toolId: string;
			config: Record<string, unknown> | null;
		}>;
	};
	return cachedData.tools;
}

async function postMcp(
	hostSlug: string,
	body: unknown,
	headers?: Record<string, string>,
) {
	const modernMeta = {
		"io.modelcontextprotocol/protocolVersion": "2026-07-28",
		"io.modelcontextprotocol/clientCapabilities": { extensions: {} },
	};
	const bindMeta = (entry: unknown) =>
		typeof entry === "object" && entry !== null && "method" in entry
			? {
					...(entry as Record<string, unknown>),
					params: {
						...(typeof (entry as Record<string, unknown>).params === "object" &&
						(entry as Record<string, unknown>).params !== null
							? ((entry as Record<string, unknown>).params as Record<
									string,
									unknown
								>)
							: {}),
						_meta: modernMeta,
					},
				}
			: entry;
	const boundBody = Array.isArray(body) ? body.map(bindMeta) : bindMeta(body);
	const envelope = Array.isArray(boundBody) ? boundBody[0] : boundBody;
	const method =
		typeof envelope === "object" && envelope !== null && "method" in envelope
			? String(envelope.method)
			: "";
	const name =
		typeof envelope === "object" &&
		envelope !== null &&
		"params" in envelope &&
		typeof envelope.params === "object" &&
		envelope.params !== null &&
		"name" in envelope.params
			? String(envelope.params.name)
			: "";
	return worker.fetch(
		new Request(`https://${hostSlug}.mcp.tedix.tech/mcp`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"MCP-Protocol-Version": "2026-07-28",
				...(method ? { "Mcp-Method": method } : {}),
				...(name ? { "Mcp-Name": name } : {}),
				...headers,
			},
			body: JSON.stringify(boundBody),
		}),
		createEnv(),
		createExecutionContext(),
	);
}

describe("applyHostConnectionDefaultsToAggregateEntries (unit)", () => {
	it("defaults entry connection fields from the host mcpConfig when the host declares connectionProviderId", () => {
		const result = applyHostConnectionDefaultsToAggregateEntries(
			[{ slug: "promptwatch" }],
			{
				connectionProviderId: "promptwatch-tedix",
				connectionLabel: "tedix",
				connectionScope: "tenant",
				connectionScopes: ["projects:read"],
			},
		);
		expect(result).toEqual([
			{
				slug: "promptwatch",
				connectionProviderId: "promptwatch-tedix",
				connectionLabel: "tedix",
				connectionScope: "tenant",
				connectionScopes: ["projects:read"],
			},
		]);
	});

	it("keeps explicit per-entry values as highest precedence", () => {
		const result = applyHostConnectionDefaultsToAggregateEntries(
			[
				{
					slug: "promptwatch",
					connectionProviderId: "entry-provider",
					connectionLabel: "entry-label",
					connectionScope: "user",
					connectionScopes: ["entry:scope"],
				},
			],
			{
				connectionProviderId: "host-provider",
				connectionLabel: "host-label",
				connectionScope: "tenant",
				connectionScopes: ["host:scope"],
			},
		);
		expect(result).toEqual([
			{
				slug: "promptwatch",
				connectionProviderId: "entry-provider",
				connectionLabel: "entry-label",
				connectionScope: "user",
				connectionScopes: ["entry:scope"],
			},
		]);
	});

	it("returns entries unchanged when the host has no connectionProviderId (even with bare scope/label)", () => {
		const entries = [{ slug: "google-gmail-tedix" }, { slug: "promptwatch" }];
		// tedix-unified shape: host-level connectionScope without a host provider
		// id must not leak into entries (it would corrupt user-scoped nested apps).
		const result = applyHostConnectionDefaultsToAggregateEntries(entries, {
			connectionScope: "tenant",
			connectionLabel: "tedix",
		});
		expect(result).toBe(entries);
		expect(result).toEqual([
			{ slug: "google-gmail-tedix" },
			{ slug: "promptwatch" },
		]);
	});

	it("returns entries unchanged for missing/empty/invalid host config values", () => {
		const entries = [{ slug: "base" }];
		expect(applyHostConnectionDefaultsToAggregateEntries(entries, null)).toBe(
			entries,
		);
		expect(
			applyHostConnectionDefaultsToAggregateEntries(entries, {
				connectionProviderId: "",
			}),
		).toBe(entries);
		expect(
			applyHostConnectionDefaultsToAggregateEntries(entries, {
				connectionProviderId: 42,
			}),
		).toBe(entries);
	});

	it("ignores invalid host scope values and empty scopes arrays while still applying the provider id", () => {
		const result = applyHostConnectionDefaultsToAggregateEntries(
			[{ slug: "base" }],
			{
				connectionProviderId: "host-provider",
				connectionScope: "bogus",
				connectionScopes: [],
			},
		);
		expect(result).toEqual([
			{
				slug: "base",
				connectionProviderId: "host-provider",
				connectionLabel: undefined,
				connectionScope: undefined,
				connectionScopes: undefined,
			},
		]);
	});
});

describe("aggregate host connection defaults (integration via worker.fetch)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getByDomain.mockResolvedValue({ app: null });
		getBySlugWithTools.mockResolvedValue({ app: null, tools: [] });
		mountMcp.mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		buildMcpServer.mockResolvedValue({} as unknown);
	});

	it("retains nested filters, readOnly and organization context", async () => {
		installFixtures([
			{
				slug: "restricted-host",
				mcpConfig: {
					authMode: "public",
					aggregateApps: [
						{
							slug: "restricted-parent",
							organizationId: "org-selected",
							readOnly: true,
						},
					],
				},
			},
			{
				slug: "restricted-parent",
				mcpConfig: {
					aggregateApps: [
						{
							slug: "restricted-leaf",
							toolIds: ["read_one"],
							endpointPrefixes: ["work"],
							readOnly: false,
						},
					],
				},
			},
			{
				slug: "restricted-leaf",
				tools: [
					{
						...connectionTool("read_one", "provider"),
						writeCapability: "read",
					},
					{
						...connectionTool("write_one", "provider"),
						writeCapability: "write",
					},
				],
			},
		]);
		const mounted = await serveAndCaptureTools("restricted-host");
		expect(
			mounted
				.filter((tool) => tool.toolId.startsWith("restricted-parent__"))
				.map((tool) => tool.toolId),
		).toEqual(["restricted-parent__read_one"]);
		expect(mounted[0]?.config?._multiOrgOrganizationId).toBe("org-selected");
		expect(
			getBySlugWithTools.mock.calls.some(
				([input]) =>
					input.slug === "restricted-leaf" &&
					input.toolIds?.[0] === "read_one" &&
					input.endpointPrefixes?.[0] === "work",
			),
		).toBe(true);
	});

	it("applies the HOST app's connection overrides to aggregated base-app tools (promptwatch-tedix shape)", async () => {
		// Host is a thin `-{tenant}` aggregator with its own provider binding but
		// a bare aggregateApps entry — exactly the validated production gap.
		installFixtures([
			{
				slug: "pwt-host-a",
				mcpConfig: {
					authMode: "public",
					connectionProviderId: "pwt-provider",
					connectionLabel: "tedix",
					connectionScope: "tenant",
					aggregateApps: [{ slug: "pw-base-a" }],
				},
			},
			{
				slug: "pw-base-a",
				mcpConfig: {
					connectionProviderId: "pw-base-api-key",
					connectionScope: "tenant",
				},
				tools: [connectionTool("list_projects", "pw-base-api-key")],
			},
		]);

		const tools = await serveAndCaptureTools("pwt-host-a");
		const aggregated = tools.find(
			(tool) => tool.toolId === "pw-base-a__list_projects",
		);
		expect(aggregated).toBeDefined();
		const config = aggregated?.config as Record<string, unknown>;
		expect(config.auth).toMatchObject({
			type: "connection",
			connectionId: "pwt-provider",
			credentialScope: "tenant",
		});
		expect(config._aggregateConnectionProviderId).toBe("pwt-provider");
		expect(config._aggregateConnectionLabel).toBe("tedix");
	});

	it("rejects legacy initialize and answers modern discovery/list without hydrating", async () => {
		installFixtures([
			{
				slug: "code-mode-host-a",
				mcpConfig: {
					authMode: "public",
					codeMode: true,
					aggregateApps: [{ slug: "gmail" }, { slug: "todoist" }],
					aggregateTedis: [{ slug: "cpo", namespace: "cpo" }],
				},
			},
			{
				slug: "gmail",
				tools: [connectionTool("messages_list", "gmail-provider")],
			},
			{
				slug: "todoist",
				tools: [connectionTool("tasks_list", "todoist-provider")],
			},
		]);

		const init = await postMcp("code-mode-host-a", {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				clientInfo: { name: "generic-mcp-client", version: "test" },
				capabilities: {},
			},
		});
		expect(init.status).toBe(404);
		expect(await init.json()).toMatchObject({ error: { code: -32601 } });

		const meta = {
			"io.modelcontextprotocol/protocolVersion": "2026-07-28",
			"io.modelcontextprotocol/clientCapabilities": { extensions: {} },
		};
		const discover = await postMcp(
			"code-mode-host-a",
			{
				jsonrpc: "2.0",
				id: 2,
				method: "server/discover",
				params: { _meta: meta },
			},
			{
				"MCP-Protocol-Version": "2026-07-28",
				"Mcp-Method": "server/discover",
			},
		);
		const discovery = (await discover.json()) as {
			result?: {
				supportedVersions?: string[];
				capabilities?: {
					prompts?: unknown;
					extensions?: Record<string, unknown>;
				};
			};
		};
		expect(discovery.result?.supportedVersions).toEqual(["2026-07-28"]);
		expect(discovery.result?.capabilities?.prompts).toBeUndefined();
		expect(
			discovery.result?.capabilities?.extensions?.[
				"io.modelcontextprotocol/tasks"
			],
		).toEqual({});

		const list = await postMcp(
			"code-mode-host-a",
			{ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: meta } },
			{
				"MCP-Protocol-Version": "2026-07-28",
				"Mcp-Method": "tools/list",
			},
		);
		const payload = (await list.json()) as {
			result?: { tools?: Array<{ name: string }> };
		};
		expect(payload.result?.tools?.map((tool) => tool.name)).toEqual([
			"code",
			"get_info",
		]);
		expect(buildMcpServer).not.toHaveBeenCalled();
	});

	it("does not advertise Tasks on a single-purpose compact Code Mode surface", async () => {
		installFixtures([
			{
				slug: "code-mode-single-purpose",
				mcpConfig: { authMode: "public", codeMode: true },
			},
		]);
		const response = await postMcp(
			"code-mode-single-purpose",
			{
				jsonrpc: "2.0",
				id: 4,
				method: "server/discover",
				params: {
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientCapabilities": {
							extensions: {},
						},
					},
				},
			},
			{
				"MCP-Protocol-Version": "2026-07-28",
				"Mcp-Method": "server/discover",
			},
		);
		const payload = (await response.json()) as {
			result?: { capabilities?: { extensions?: Record<string, unknown> } };
		};
		expect(
			payload.result?.capabilities?.extensions?.[
				"io.modelcontextprotocol/tasks"
			],
		).toBeUndefined();
	});

	it("stamps the configured server identity on modern compact fast-path results", async () => {
		installFixtures([
			{
				slug: "code-mode-host-modern",
				mcpConfig: {
					authMode: "public",
					codeMode: true,
					serverName: "Trusted Compact Host",
					serverVersion: "2.0.0",
				},
			},
		]);
		const meta = {
			"io.modelcontextprotocol/protocolVersion": "2026-07-28",
			"io.modelcontextprotocol/clientCapabilities": { extensions: {} },
		};
		const baseHeaders = {
			"MCP-Protocol-Version": "2026-07-28",
		};
		const list = await postMcp(
			"code-mode-host-modern",
			{
				jsonrpc: "2.0",
				id: 20,
				method: "tools/list",
				params: { _meta: meta },
			},
			{ ...baseHeaders, "Mcp-Method": "tools/list" },
		);
		const listPayload = (await list.json()) as {
			result?: { _meta?: Record<string, unknown> };
		};
		expect(
			listPayload.result?._meta?.["io.modelcontextprotocol/serverInfo"],
		).toEqual({ name: "Trusted Compact Host", version: "2.0.0" });

		const call = await postMcp(
			"code-mode-host-modern",
			{
				jsonrpc: "2.0",
				id: 21,
				method: "tools/call",
				params: { name: "get_info", arguments: {}, _meta: meta },
			},
			{
				...baseHeaders,
				"Mcp-Method": "tools/call",
				"Mcp-Name": "get_info",
			},
		);
		const callPayload = (await call.json()) as {
			result?: { _meta?: Record<string, unknown> };
		};
		expect(
			callPayload.result?._meta?.["io.modelcontextprotocol/serverInfo"],
		).toEqual({ name: "Trusted Compact Host", version: "2.0.0" });
		expect(buildMcpServer).not.toHaveBeenCalled();
	});

	it("answers single-item batch get_info without hydrating the aggregate surface", async () => {
		installFixtures([
			{
				slug: "code-mode-host-info",
				mcpConfig: {
					authMode: "public",
					codeMode: true,
					aggregateApps: [{ slug: "gmail" }],
					aggregateTedis: [{ slug: "cpo", namespace: "cpo" }],
				},
			},
			{
				slug: "gmail",
				tools: [connectionTool("messages_list", "gmail-provider")],
			},
		]);

		const response = await postMcp("code-mode-host-info", [
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "get_info", arguments: {} },
			},
		]);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as Array<{
			result?: { structuredContent?: { fastPath?: string } };
		}>;
		expect(payload[0]?.result?.structuredContent?.fastPath).toBe("bootstrap");
		expect(buildMcpServer).not.toHaveBeenCalled();
	});

	it("hydrates only directly called Code Mode aggregate namespaces", async () => {
		installFixtures([
			{
				slug: "code-mode-host-b",
				mcpConfig: {
					authMode: "public",
					codeMode: true,
					aggregateApps: [{ slug: "gmail" }, { slug: "todoist" }],
					codeModeNamespaces: { gmail: "mail" },
					aggregateTedis: [
						{ slug: "cpo", namespace: "cpo", runtimeKind: "agent" },
						{ slug: "cto", namespace: "cto", runtimeKind: "agent" },
					],
				},
			},
			{
				slug: "gmail",
				tools: [connectionTool("messages_list", "gmail-provider")],
			},
			{
				slug: "todoist",
				tools: [connectionTool("tasks_list", "todoist-provider")],
			},
		]);

		await postMcp("code-mode-host-b", {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: 'async () => ({ run: await home.read_home_run({ homeRunId: "run_1" }), status: await cpo.exec({ command: "git status" }) })',
				},
			},
		});

		expect(buildMcpServer).toHaveBeenCalledOnce();
		const cachedData = (buildMcpServer.mock.calls[0] as unknown[])[0] as {
			tools: Array<{ toolId: string }>;
		};
		const toolIds = cachedData.tools.map((tool) => tool.toolId);
		expect(toolIds).toContain("home__read_home_run");
		expect(toolIds).toContain("cpo__exec");
		expect(toolIds).not.toContain("cto__messages_read");
		expect(toolIds).not.toContain("gmail__messages_list");
		expect(toolIds).not.toContain("todoist__tasks_list");
	});

	it("rebuilds a transiently degraded selectively requested namespace before executing Code Mode", async () => {
		const host = {
			slug: "selective-recovery-host",
			mcpConfig: {
				authMode: "public",
				codeMode: true,
				aggregateApps: [{ slug: "selective-recovery-app" }],
			},
		};
		const source = {
			slug: "selective-recovery-app",
			tools: [connectionTool("records_list", "recovery-provider")],
		};
		let sourceReads = 0;
		getBySlugWithTools.mockImplementation(
			async ({ slug }: { slug: string }) => {
				if (slug === host.slug) return appResponse(host);
				if (slug === source.slug) {
					sourceReads += 1;
					if (sourceReads === 1) throw new Error("transient apps/api flap");
					return appResponse(source);
				}
				return { app: null, tools: [] };
			},
		);

		await postMcp(host.slug, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => selective_recovery_app.records_list({})",
				},
			},
		});

		expect(sourceReads).toBe(2);
		const cachedData = (buildMcpServer.mock.calls[0] as unknown[])[0] as {
			tools: Array<{ toolId: string }>;
		};
		expect(cachedData.tools.map((tool) => tool.toolId)).toContain(
			"selective-recovery-app__records_list",
		);
	});

	it("keeps persistent selective hydration failure degraded and does not poison the next request", async () => {
		const host = {
			slug: "selective-persistent-host",
			mcpConfig: {
				authMode: "public",
				codeMode: true,
				aggregateApps: [{ slug: "selective-persistent-app" }],
			},
		};
		let sourceReads = 0;
		getBySlugWithTools.mockImplementation(
			async ({ slug }: { slug: string }) => {
				if (slug === host.slug) return appResponse(host);
				if (slug === "selective-persistent-app") {
					sourceReads += 1;
					throw new Error("persistent apps/api failure");
				}
				return { app: null, tools: [] };
			},
		);
		const request = {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => selective_persistent_app.records_list({})",
				},
			},
		};

		await postMcp(host.slug, request);
		expect(sourceReads).toBe(2);
		let cachedData = (buildMcpServer.mock.calls[0] as unknown[])[0] as {
			tools: Array<{ toolId: string }>;
		};
		expect(cachedData.tools.map((tool) => tool.toolId)).not.toContain(
			"selective-persistent-app__records_list",
		);

		await postMcp(host.slug, request);
		expect(sourceReads).toBe(4);
		cachedData = (buildMcpServer.mock.calls[1] as unknown[])[0] as {
			tools: Array<{ toolId: string }>;
		};
		expect(cachedData.tools.map((tool) => tool.toolId)).not.toContain(
			"selective-persistent-app__records_list",
		);
	});

	it("hydrates only directly called Code Mode namespaces from a single-item batch", async () => {
		installFixtures([
			{
				slug: "code-mode-host-batch",
				mcpConfig: {
					authMode: "public",
					codeMode: true,
					aggregateApps: [{ slug: "gmail" }, { slug: "todoist" }],
					aggregateTedis: [
						{ slug: "cpo", namespace: "cpo", runtimeKind: "agent" },
						{ slug: "cto", namespace: "cto", runtimeKind: "agent" },
					],
				},
			},
			{
				slug: "gmail",
				tools: [connectionTool("messages_list", "gmail-provider")],
			},
			{
				slug: "todoist",
				tools: [connectionTool("tasks_list", "todoist-provider")],
			},
		]);

		await postMcp("code-mode-host-batch", [
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "code",
					arguments: {
						code: "async () => ({ runtime: await codemode.__runtime(), status: await cpo.exec({ command: 'git status' }) })",
					},
				},
			},
		]);

		expect(buildMcpServer).toHaveBeenCalledOnce();
		const cachedData = (buildMcpServer.mock.calls[0] as unknown[])[0] as {
			tools: Array<{ toolId: string }>;
		};
		const toolIds = cachedData.tools.map((tool) => tool.toolId);
		expect(toolIds).toContain("home__read_home_run");
		expect(toolIds).toContain("cpo__exec");
		expect(toolIds).not.toContain("cto__messages_read");
		expect(toolIds).not.toContain("gmail__messages_list");
		expect(toolIds).not.toContain("todoist__tasks_list");
	});

	it("keeps explicit aggregateApps entry overrides above host-level values", async () => {
		installFixtures([
			{
				slug: "pwt-host-b",
				mcpConfig: {
					authMode: "public",
					connectionProviderId: "host-provider",
					connectionLabel: "host-label",
					aggregateApps: [
						{
							slug: "pw-base-b",
							connectionProviderId: "entry-provider",
							connectionLabel: "entry-label",
						},
					],
				},
			},
			{
				slug: "pw-base-b",
				mcpConfig: { connectionProviderId: "pw-base-api-key" },
				tools: [connectionTool("list_projects", "pw-base-api-key")],
			},
		]);

		const tools = await serveAndCaptureTools("pwt-host-b");
		const aggregated = tools.find(
			(tool) => tool.toolId === "pw-base-b__list_projects",
		);
		expect(aggregated).toBeDefined();
		const config = aggregated?.config as Record<string, unknown>;
		expect(config.auth).toMatchObject({
			type: "connection",
			connectionId: "entry-provider",
		});
		expect(config._aggregateConnectionLabel).toBe("entry-label");
	});

	it("leaves aggregated tools unchanged when the host has no connection overrides (gmail-style variant)", async () => {
		installFixtures([
			{
				slug: "gm-host-c",
				mcpConfig: {
					authMode: "public",
					aggregateApps: [{ slug: "gm-base-c" }],
				},
			},
			{
				slug: "gm-base-c",
				mcpConfig: {
					connectionProviderId: "gm-base-provider",
					connectionScope: "user",
				},
				tools: [connectionTool("send_email", "gm-base-provider")],
			},
		]);

		const tools = await serveAndCaptureTools("gm-host-c");
		const aggregated = tools.find(
			(tool) => tool.toolId === "gm-base-c__send_email",
		);
		expect(aggregated).toBeDefined();
		const config = aggregated?.config as Record<string, unknown>;
		// Same outcome as before the change: the aggregated app's own provider id
		// and user scope win because the host contributes nothing.
		expect(config.auth).toMatchObject({
			type: "connection",
			connectionId: "gm-base-provider",
			credentialScope: "user",
		});
		expect(config._aggregateConnectionLabel).toBeUndefined();
	});

	it("adds connection auth when an aggregate entry explicitly binds a provider", async () => {
		installFixtures([
			{
				slug: "docs-host",
				mcpConfig: {
					authMode: "public",
					aggregateApps: [
						{
							slug: "docs-base",
							connectionProviderId: "github-pat-key",
							connectionScope: "user",
						},
					],
				},
			},
			{
				slug: "docs-base",
				mcpConfig: {},
				tools: [
					{
						...connectionTool("start_docs_build", "unused"),
						config: {
							transport: "mcp",
							mcpServerUrl: "https://docs-admin.tedix.dev/mcp",
							mcpToolName: "start_docs_build",
						},
					},
				],
			},
		]);

		const tools = await serveAndCaptureTools("docs-host");
		const aggregated = tools.find(
			(tool) => tool.toolId === "docs-base__start_docs_build",
		);
		expect(aggregated).toBeDefined();
		expect((aggregated?.config as Record<string, unknown>).auth).toMatchObject({
			type: "connection",
			connectionId: "github-pat-key",
			credentialScope: "user",
		});
	});

	it("hydrates the platform-operator admin app when code directly calls a platform namespace (tedis / workflows)", async () => {
		// The platform-operator admin app ("tedix") stores tools under endpoints like
		// "tedis/list" and "workflows/listRuns", which resolve to Code Mode namespaces
		// "tedis" and "workflows" — not the entry slug "tedix". Without the fix, calling
		// `tedis.list_tedis(...)` in a Code Mode body would filter out the "tedix" entry
		// (slug ≠ "tedis") and the tools would not hydrate.
		//
		// The host uses the PLATFORM_OPERATOR_APP_SLUG ("tedix-unified") so that
		// ensurePlatformOperatorAggregateApps automatically injects { slug: "tedix" }.
		// "gmail" is an additional aggregate app that should not be hydrated.
		installFixtures([
			{
				slug: "tedix-unified",
				mcpConfig: {
					authMode: "public",
					codeMode: true,
					// ensurePlatformOperatorAggregateApps prepends { slug: "tedix" }
					aggregateApps: [{ slug: "gmail-platform-ns-test" }],
				},
			},
			{
				// Platform-admin app: tools with rpc endpoints mapping to namespace "tedis"
				// and "workflows" in Code Mode (endpoint prefix → camelCaseRoot).
				slug: "tedix",
				tools: [
					{
						id: "tool-list-tedis",
						toolId: "list_tedis",
						title: "List Tedis",
						description: null,
						toolTypeId: "rpc",
						inputSchema: { type: "object", properties: {} },
						outputSchema: null,
						config: { endpoint: "tedis/list" },
						enabled: true,
						visibility: "private",
						authRequired: true,
					},
					{
						id: "tool-list-workflow-runs",
						toolId: "list_workflow_runs",
						title: "List Workflow Runs",
						description: null,
						toolTypeId: "rpc",
						inputSchema: { type: "object", properties: {} },
						outputSchema: null,
						config: { endpoint: "workflows/listRuns" },
						enabled: true,
						visibility: "private",
						authRequired: true,
					},
				],
			},
			{
				slug: "gmail-platform-ns-test",
				tools: [connectionTool("messages_list", "gmail-provider")],
			},
		]);

		await postMcp("tedix-unified", {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					// Directly calls "tedis" and "workflows" namespaces — these come from
					// the "tedix" admin app's endpoint-based namespace resolution, not from
					// an aggregate entry slug. The fix ensures "tedix" is included.
					code: "async () => ({ t: await tedis.list_tedis({}), w: await workflows.list_workflow_runs({}) })",
				},
			},
		});

		expect(buildMcpServer).toHaveBeenCalledOnce();
		const cachedData = (buildMcpServer.mock.calls[0] as unknown[])[0] as {
			tools: Array<{ toolId: string }>;
		};
		const toolIds = cachedData.tools.map((tool) => tool.toolId);
		// The "tedix" admin app's tools MUST be hydrated (via endpoint-namespace match)
		expect(toolIds).toContain("tedix__list_tedis");
		expect(toolIds).toContain("tedix__list_workflow_runs");
		// The "gmail" aggregate app must not be hydrated (its namespace is "gmail", not called)
		expect(toolIds).not.toContain("gmail-platform-ns-test__messages_list");
	});

	it("pairs an app account with its scope through stale aggregate scope defaults", async () => {
		const slot = "11111111-1111-4111-8111-111111111111";
		installFixtures([
			{
				slug: "named-org-host",
				mcpConfig: {
					authMode: "public",
					aggregateApps: [
						{ slug: "named-org-wrapper", connectionScope: "user" },
					],
				},
			},
			{
				slug: "named-org-wrapper",
				mcpConfig: {
					connectionProviderId: "named-provider",
					connectionInstanceId: slot,
					connectionScope: "tenant",
					aggregateApps: [{ slug: "named-org-base", connectionScope: "user" }],
				},
			},
			{
				slug: "named-org-base",
				tools: [connectionTool("read_calendar", "named-provider")],
			},
		]);
		const tools = await serveAndCaptureTools("named-org-host");
		expect(
			tools.find((t) => t.toolId === "named-org-wrapper__read_calendar")
				?.config,
		).toMatchObject({
			_aggregateConnectionInstanceId: slot,
			auth: { connectionId: "named-provider", credentialScope: "tenant" },
		});
	});
	it.each(["user", "tenant"] as const)(
		"preserves %s ownership for direct app bindings",
		async (scope) => {
			const slot = "11111111-1111-4111-8111-111111111111";
			const slug = `named-direct-${scope}`;
			installFixtures([
				{
					slug,
					mcpConfig: {
						authMode: "public",
						connectionProviderId: "named-provider",
						connectionInstanceId: slot,
						connectionScope: scope,
					},
					tools: [connectionTool("read_calendar", "named-provider")],
				},
			]);
			const tools = await serveAndCaptureTools(slug);
			expect(
				tools.find((t) => t.toolId === "read_calendar")?.config,
			).toMatchObject({
				auth: { connectionInstanceId: slot, credentialScope: scope },
			});
		},
	);

	it.each([false, true])(
		"does not inherit another provider account through a nested wrapper: %s",
		async (nested) => {
			const suffix = nested ? "nested" : "direct";
			installFixtures([
				{
					slug: `provider-override-host-${suffix}`,
					mcpConfig: {
						authMode: "public",
						aggregateApps: [
							{
								slug: `provider-override-wrapper-${suffix}`,
								connectionProviderId: "microsoft",
								connectionScope: "user",
							},
						],
					},
				},
				{
					slug: `provider-override-wrapper-${suffix}`,
					mcpConfig: {
						connectionProviderId: "google",
						connectionInstanceId: "11111111-1111-4111-8111-111111111111",
						connectionScope: "tenant",
						...(nested
							? {
									aggregateApps: [{ slug: `provider-override-base-${suffix}` }],
								}
							: {}),
					},
					tools: nested ? [] : [connectionTool("read", "google")],
				},
				{
					slug: `provider-override-base-${suffix}`,
					tools: [connectionTool("read", "google")],
				},
			]);
			const tools = await serveAndCaptureTools(
				`provider-override-host-${suffix}`,
			);
			const config = tools.find(
				(t) => t.toolId === `provider-override-wrapper-${suffix}__read`,
			)?.config as Record<string, unknown>;
			expect(config.auth).toMatchObject({
				connectionId: "microsoft",
				credentialScope: "user",
			});
			expect(config._aggregateConnectionInstanceId).toBeUndefined();
		},
	);
	it("does not alter nested aggregation: the intermediate host's app-level values still bind the leaf tools", async () => {
		// tedix-unified shape: outer host has connectionScope but no provider id,
		// aggregating a thin tenant variant (mid) that itself aggregates the base.
		// The mid app's app-level connectionProviderId must bind the leaf tools,
		// and the outer host's bare tenant scope must not leak into the chain.
		installFixtures([
			{
				slug: "uni-host-d",
				mcpConfig: {
					authMode: "public",
					connectionScope: "tenant",
					aggregateApps: [{ slug: "mid-d" }],
				},
			},
			{
				slug: "mid-d",
				mcpConfig: {
					connectionProviderId: "mid-provider",
					connectionLabel: "mid-label",
					connectionScope: "user",
					aggregateApps: [{ slug: "deep-d" }],
				},
			},
			{
				slug: "deep-d",
				mcpConfig: { connectionProviderId: "deep-provider" },
				tools: [connectionTool("list_deep", "deep-provider")],
			},
		]);

		const tools = await serveAndCaptureTools("uni-host-d");
		// Nested fallback keeps the top-level entry slug as the prefix.
		const aggregated = tools.find((tool) => tool.toolId === "mid-d__list_deep");
		expect(aggregated).toBeDefined();
		const config = aggregated?.config as Record<string, unknown>;
		expect(config.auth).toMatchObject({
			type: "connection",
			connectionId: "mid-provider",
			credentialScope: "user",
		});
		expect(config._aggregateConnectionLabel).toBe("mid-label");
	});

	it("recurses through a zero-tool catalog proxy that also exposes resources and prompts", async () => {
		const resource = {
			id: "resource-notion-docs",
			uri: "notion://docs/markdown",
			name: "Markdown",
			title: "Markdown",
			description: null,
			mimeType: "text/plain",
			detectedAt: "2026-09-24T00:00:00.000Z",
			lastSeenAt: "2026-09-24T00:00:00.000Z",
			removedAt: null,
		};
		const prompt = {
			id: "prompt-notion-page",
			promptName: "make-page",
			title: "Make page",
			description: null,
			arguments: null,
			detectedAt: "2026-09-24T00:00:00.000Z",
			lastSeenAt: "2026-09-24T00:00:00.000Z",
			removedAt: null,
		};
		const resourceTemplate = {
			id: "template-globex-document",
			name: "Document",
			title: "Document",
			uriTemplate: "globex://documents/{id}",
			description: null,
			mimeType: "application/json",
			detectedAt: "2026-09-24T00:00:00.000Z",
			lastSeenAt: "2026-09-24T00:00:00.000Z",
			removedAt: null,
		};
		installFixtures([
			{
				slug: "catalog-proxy-host",
				mcpConfig: {
					authMode: "public",
					aggregateApps: [{ slug: "catalog-proxy" }],
				},
			},
			{
				slug: "catalog-proxy",
				mcpConfig: { aggregateApps: [{ slug: "catalog-base" }] },
				catalogResources: [resource],
				catalogResourceTemplates: [resourceTemplate],
				catalogPrompts: [prompt],
			},
			{
				slug: "catalog-base",
				tools: [connectionTool("search", "catalog-provider")],
				catalogResources: [resource],
				catalogResourceTemplates: [resourceTemplate],
				catalogPrompts: [prompt],
			},
		]);

		await serveAndCaptureTools("catalog-proxy-host");
		const cachedData = (buildMcpServer.mock.calls[0] as unknown[])[0] as {
			tools: Array<{ toolId: string }>;
			catalogResources: Array<{ uri: string }>;
			catalogResourceTemplates: Array<{ uriTemplate: string }>;
			catalogPrompts: Array<{ promptName: string }>;
		};
		expect(cachedData.tools.map((tool) => tool.toolId)).toContain(
			"catalog-proxy__search",
		);
		expect(cachedData.catalogResources.map((item) => item.uri)).toEqual([
			"notion://docs/markdown",
		]);
		expect(
			cachedData.catalogResourceTemplates.map((item) => item.uriTemplate),
		).toEqual(["globex://documents/{id}"]);
		expect(cachedData.catalogPrompts.map((item) => item.promptName)).toEqual([
			"catalog-proxy__make-page",
		]);
	});

	it("propagates a tenant-safe forwarded organization query through a proxy aggregate", async () => {
		// Fixture slugs are unique per test on purpose: the internal upstream-tool
		// resolve is memoized in a module-level cache keyed by upstream slug
		// (INTERNAL_TOOL_CACHE_TTL_MS), which outlives vi.clearAllMocks(). Reusing
		// a slug another test already resolved serves that test's tools here.
		installFixtures([
			{
				slug: "fwd-org-host",
				mcpConfig: {
					authMode: "public",
					aggregateApps: [
						{
							slug: "fwd-docs-proxy",
							prefix: "docs",
							forwardedQueryParams: { org: "tenant-a" },
						},
					],
				},
			},
			{
				slug: "fwd-docs-proxy",
				mcpConfig: { aggregateApps: [{ slug: "fwd-docs-base" }] },
			},
			{
				slug: "fwd-docs-base",
				tools: [connectionTool("list_docs_sites", "github")],
			},
		]);

		const tools = await serveAndCaptureTools("fwd-org-host");
		const aggregated = tools.find(
			(tool) => tool.toolId === "docs__list_docs_sites",
		);

		expect(aggregated?.config).toMatchObject({
			_forwardedQueryParams: { org: "tenant-a" },
		});
	});
});
