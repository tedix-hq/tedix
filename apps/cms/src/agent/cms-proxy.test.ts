import { contentUpdateBody, calendarQuery } from "emdash/api/schemas";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { callSandboxFreeCmsProxyTool } from "./cms-proxy";
import {
	getCmsSiteOverview,
	pluginRegistrySignalSummary,
	registryStatus,
} from "./cms-proxy-inspection";
import { mediaToFieldValue, mediaUpload } from "./cms-proxy-media";
import {
	buildCmsAuthHeaderCandidates,
	type CmsProxyContext,
	callCmsRest,
	callCmsTransferRest,
	callCmsFormsTool,
	completeExistingCmsSetup,
	callTenantMcpTool,
	clearTenantMcpEras,
	isJwt,
	menuSetItems,
	listTenantMcpTools,
	shouldForwardCmsRestToTenantMcp,
} from "./cms-proxy-runtime";
import { registerCmsProxyTools } from "./cms-proxy-tools";
import { encodeCmsHumanIdentity } from "./cms-human-auth";

const baseContext: CmsProxyContext = {
	orgSlug: "tedix",
	forwardedAuth: undefined,
	serviceApiKey: undefined,
	internalAuthToken: undefined,
	environment: "production",
};

const buildCmsAuthHeaders = (ctx: CmsProxyContext) =>
	buildCmsAuthHeaderCandidates(ctx)[0]?.headers ?? null;

// Each test starts without a remembered tenant MCP era, so the first native
// call pays the discover probe exactly as a cold isolate does.
beforeEach(() => clearTenantMcpEras());

/**
 * The connection handshake of a released (2025-era, stateless) Emdash MCP
 * endpoint, as its official SDK WebStandardStreamableHTTPServerTransport
 * answers it: the 2026 `server/discover` probe is rejected with HTTP 400,
 * `initialize` succeeds, `notifications/initialized` is accepted. Returns
 * undefined for anything else (`tools/call`), which the test answers.
 * `tenant-mcp-emdash.test.ts` drives the real route end to end.
 */
function emdashMcpHandshake(body: {
	id?: unknown;
	method?: unknown;
}): Response | undefined {
	if (body.method === "server/discover") {
		return Response.json(
			{
				jsonrpc: "2.0",
				error: {
					code: -32000,
					message:
						"Bad Request: Unsupported protocol version: 2026-07-28 (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)",
				},
				id: null,
			},
			{ status: 400 },
		);
	}
	if (body.method === "initialize") {
		return Response.json({
			jsonrpc: "2.0",
			id: body.id,
			result: {
				protocolVersion: "2025-11-25",
				capabilities: { tools: {} },
				serverInfo: { name: "emdash", version: "1.0.1" },
			},
		});
	}
	if (body.method === "notifications/initialized") {
		return new Response(null, { status: 202 });
	}
	return undefined;
}

const EMDASH_HANDSHAKE = [
	"server/discover",
	"initialize",
	"notifications/initialized",
] as const;

describe("native search configuration proxy", () => {
	it("uses native configuration validation and marks the mutation for confirmation", () => {
		const tools = new Map<string, any>();
		registerCmsProxyTools(
			{
				registerTool: (name: string, definition: any) =>
					tools.set(name, definition),
			} as any,
			baseContext,
		);
		const tool = tools.get("configure_search");
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
		});
		expect(
			tool.inputSchema.parse({
				collection: "use_cases",
				enabled: true,
				weights: { title: 2 },
			}),
		).toEqual({
			collection: "use_cases",
			enabled: true,
			weights: { title: 2 },
		});
		expect(
			tool.inputSchema.safeParse({ collection: "use_cases", enabled: "yes" })
				.success,
		).toBe(false);
		expect(
			tool.inputSchema.safeParse({
				collection: "use_cases",
				enabled: true,
				tokenize: "invented tokenizer",
			}).success,
		).toBe(false);
	});
	it("forwards enable and disable to the native endpoint without changing content", async () => {
		const requests: unknown[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const body = await request.json();
					requests.push({
						method: request.method,
						path: new URL(request.url).pathname,
						body,
					});
					return Response.json({
						success: true,
						data: {
							collection: "use_cases",
							enabled: (body as any).enabled,
							indexed: 15,
						},
					});
				},
			} as Fetcher,
		};
		for (const enabled of [true, false]) {
			const result = await callSandboxFreeCmsProxyTool(
				ctx,
				"configure_search",
				{ collection: "use_cases", enabled, weights: { title: 2 } },
			);
			expect(result?.isError).toBeUndefined();
		}
		expect(requests).toEqual(
			[true, false].map((enabled) => ({
				method: "POST",
				path: "/_emdash/api/search/enable",
				body: { collection: "use_cases", enabled, weights: { title: 2 } },
			})),
		);
	});
	it("preserves native permission failures", async () => {
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (_request: Request) =>
					Response.json(
						{
							success: false,
							error: { code: "FORBIDDEN", message: "search:manage required" },
						},
						{ status: 403 },
					),
			} as Fetcher,
		};
		const result = await callCmsRest(ctx, "configure_search", {
			collection: "use_cases",
			enabled: true,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("search:manage required");
	});
});

describe("Emdash taxonomy and translation proxy", () => {
	function registered() {
		const tools = new Map<
			string,
			{
				inputSchema: { safeParse(value: unknown): { success: boolean } };
				outputSchema?: { safeParse(value: unknown): { success: boolean } };
				annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
			}
		>();
		registerCmsProxyTools(
			{
				registerTool: (name: string, definition: any) => {
					tools.set(name, definition);
				},
			} as any,
			baseContext,
		);
		return tools;
	}

	it("publishes definition CRUD, translation reads, and locale-aware term inputs", () => {
		const tools = registered();
		for (const name of [
			"taxonomy_get",
			"taxonomy_translations",
			"taxonomy_term_translations",
			"menu_translations",
		]) {
			expect(tools.get(name)?.annotations?.readOnlyHint, name).toBe(true);
		}
		expect(tools.get("taxonomy_delete")?.annotations?.destructiveHint).toBe(
			true,
		);
		expect(
			tools.get("taxonomy_create")?.inputSchema.safeParse({
				name: "topics",
				label: "Themen",
				collections: ["posts"],
				locale: "de",
				translationOf: "definition_en",
			}).success,
		).toBe(true);
		expect(
			tools.get("taxonomy_create_term")?.inputSchema.safeParse({
				taxonomy: "topics",
				label: "Klima",
				locale: "de",
				translationOf: "term_en",
			}).success,
		).toBe(true);
		expect(
			tools.get("taxonomy_update_term")?.inputSchema.safeParse({
				taxonomy: "topics",
				termSlug: "climate",
				locale: "de",
				label: "Klima",
			}).success,
		).toBe(true);
		expect(
			tools.get("taxonomy_delete_term")?.inputSchema.safeParse({
				taxonomy: "topics",
				termSlug: "climate",
				locale: "de",
			}).success,
		).toBe(true);
		expect(
			tools.get("taxonomy_list_terms")?.inputSchema.safeParse({
				taxonomy: "topics",
				locale: "de",
				includeCounts: false,
				resolveFallback: true,
			}).success,
		).toBe(true);
		expect(
			tools.get("taxonomy_list_terms")?.inputSchema.safeParse({
				taxonomy: "topics",
				limit: 10,
			}).success,
		).toBe(false);
		expect(
			tools.get("taxonomy_update_term")?.inputSchema.safeParse({
				taxonomy: "topics",
				termSlug: "climate",
				locale: "",
				label: "Klima",
			}).success,
		).toBe(false);
	});

	it("describes the upstream translation response envelopes", () => {
		const tools = registered();
		const responses: Array<[string, unknown]> = [
			[
				"taxonomy_translations",
				{
					data: {
						translationGroup: "group_1",
						translations: [
							{
								id: "taxonomy_de",
								name: "topics",
								label: "Themen",
								locale: "de",
							},
						],
					},
				},
			],
			[
				"taxonomy_term_translations",
				{
					data: {
						translationGroup: "group_2",
						translations: [
							{ id: "term_de", slug: "klima", label: "Klima", locale: "de" },
						],
					},
				},
			],
			[
				"menu_translations",
				{
					data: {
						translationGroup: "group_3",
						translations: [
							{
								id: "menu_de",
								name: "primary",
								label: "Navigation",
								locale: "de",
								updatedAt: "2026-09-28T00:00:00Z",
							},
						],
					},
				},
			],
		];
		for (const [name, response] of responses) {
			expect(
				tools.get(name)?.outputSchema?.safeParse(response).success,
				name,
			).toBe(true);
		}
	});

	it("describes the upstream taxonomy list, get, and term tree envelopes", () => {
		const tools = registered();
		const responses: Array<[string, unknown]> = [
			[
				"taxonomy_list",
				{
					success: true,
					data: {
						taxonomies: [{ id: "def_en", name: "topics", label: "Topics" }],
					},
				},
			],
			[
				"taxonomy_get",
				{
					success: true,
					data: { taxonomy: { id: "def_en", name: "topics", label: "Topics" } },
				},
			],
			[
				"taxonomy_list_terms",
				{
					success: true,
					data: {
						terms: [
							{
								id: "term_en",
								slug: "climate",
								label: "Climate",
								children: [],
							},
						],
					},
				},
			],
		];
		for (const [name, response] of responses) {
			expect(
				tools.get(name)?.outputSchema?.safeParse(response).success,
				name,
			).toBe(true);
		}
		expect(
			tools.get("taxonomy_get")?.outputSchema?.safeParse({
				success: true,
				data: { item: { id: "def_en", name: "topics" } },
			}).success,
		).toBe(false);
	});

	it("encodes term slugs as one REST path segment", async () => {
		let path = "";
		const ctx: CmsProxyContext = {
			...baseContext,
			forwardedAuth: "aaa.bbb.ccc",
			cmsDispatch: {
				fetch: async (request: Request) => {
					path = new URL(request.url).pathname;
					return Response.json({
						success: true,
						data: { translationGroup: "g", translations: [] },
					});
				},
			} as Fetcher,
		};
		await callCmsRest(ctx, "taxonomy_term_translations", {
			taxonomy: "topics",
			termSlug: "energy?future",
			locale: "en",
		});
		expect(path).toBe(
			"/_emdash/api/taxonomies/topics/terms/energy%3Ffuture/translations",
		);
	});

	it("preserves human attribution and every locale, body, and query field over Emdash REST", async () => {
		const requests: Array<{
			method: string;
			path: string;
			query: string;
			body: unknown;
			cookie: string | null;
			authorization: string | null;
		}> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			forwardedAuth: "aaa.bbb.ccc",
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					requests.push({
						method: request.method,
						path: url.pathname,
						query: url.search,
						body: request.body ? await request.json() : undefined,
						cookie: request.headers.get("cookie"),
						authorization: request.headers.get("authorization"),
					});
					return Response.json({ success: true, data: {} });
				},
			} as Fetcher,
		};
		const calls: Array<
			[string, Record<string, unknown>, string, string, string, unknown]
		> = [
			[
				"taxonomy_list",
				{ locale: "de" },
				"GET",
				"/taxonomies",
				"?locale=de",
				undefined,
			],
			[
				"taxonomy_get",
				{ name: "topics", locale: "de" },
				"GET",
				"/taxonomies/topics",
				"?locale=de",
				undefined,
			],
			[
				"taxonomy_translations",
				{ name: "topics", locale: "de" },
				"GET",
				"/taxonomies/topics/translations",
				"?locale=de",
				undefined,
			],
			[
				"taxonomy_create",
				{
					name: "topics",
					label: "Themen",
					locale: "de",
					translationOf: "definition_en",
					collections: ["posts"],
				},
				"POST",
				"/taxonomies",
				"",
				{
					name: "topics",
					label: "Themen",
					locale: "de",
					translationOf: "definition_en",
					collections: ["posts"],
				},
			],
			[
				"taxonomy_update",
				{ name: "topics", locale: "de", label: "Themen" },
				"PUT",
				"/taxonomies/topics",
				"?locale=de",
				{ label: "Themen" },
			],
			[
				"taxonomy_delete",
				{ name: "topics" },
				"DELETE",
				"/taxonomies/topics",
				"",
				undefined,
			],
			[
				"taxonomy_list_terms",
				{
					taxonomy: "topics",
					locale: "de",
					includeCounts: false,
					resolveFallback: true,
				},
				"GET",
				"/taxonomies/topics/terms",
				"?locale=de&includeCounts=false&resolveFallback=true",
				undefined,
			],
			[
				"taxonomy_term_translations",
				{ taxonomy: "topics", termSlug: "climate", locale: "de" },
				"GET",
				"/taxonomies/topics/terms/climate/translations",
				"?locale=de",
				undefined,
			],
			[
				"taxonomy_create_term",
				{
					taxonomy: "topics",
					label: "Klima",
					locale: "de",
					translationOf: "term_en",
				},
				"POST",
				"/taxonomies/topics/terms",
				"",
				{ label: "Klima", locale: "de", translationOf: "term_en" },
			],
			[
				"taxonomy_update_term",
				{
					taxonomy: "topics",
					termSlug: "climate",
					locale: "de",
					label: "Klima",
				},
				"PUT",
				"/taxonomies/topics/terms/climate",
				"?locale=de",
				{ label: "Klima" },
			],
			[
				"taxonomy_delete_term",
				{ taxonomy: "topics", termSlug: "climate", locale: "de" },
				"DELETE",
				"/taxonomies/topics/terms/climate",
				"?locale=de",
				undefined,
			],
			[
				"menu_translations",
				{ name: "primary", locale: "de" },
				"GET",
				"/menus/primary/translations",
				"?locale=de",
				undefined,
			],
		];
		for (const [name, args, method, path, query, body] of calls) {
			const result = await callCmsRest(ctx, name, args);
			expect(result.isError, name).toBeUndefined();
			expect(requests.at(-1), name).toEqual({
				method,
				path: `/_emdash/api${path}`,
				query,
				body,
				cookie: "DS=aaa.bbb.ccc",
				authorization: null,
			});
		}
	});
});

describe("Emdash site transfer control tools", () => {
	type Tool = {
		inputSchema: { safeParse(value: unknown): { success: boolean } };
		annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
		call: (
			args: Record<string, unknown>,
		) => Promise<{ content: Array<{ text: string }>; isError?: true }>;
	};
	function registered(ctx: CmsProxyContext): Map<string, Tool> {
		const tools = new Map<string, Tool>();
		registerCmsProxyTools(
			{
				registerTool: (name: string, definition: Tool, call: Tool["call"]) => {
					tools.set(name, { ...definition, call });
				},
			} as any,
			ctx,
		);
		return tools;
	}

	it("exposes registry verification and signed-record consent in the tool schema", () => {
		const tools = registered(baseContext);
		expect(tools.get("plugin_verify")?.annotations?.readOnlyHint).toBe(true);
		expect(
			tools.get("plugin_verify")?.inputSchema.safeParse({
				did: "did:plc:publisher",
				slug: "seo-helper",
			}).success,
		).toBe(true);
		expect(
			tools.get("plugin_install")?.inputSchema.safeParse({
				did: "did:plc:publisher",
				slug: "seo-helper",
				acknowledgedProfileCid: "profile",
				acknowledgedReleaseCid: "release",
			}).success,
		).toBe(true);
	});

	it("advertises the bounded same-org binary bridge", () => {
		const tools = registered(baseContext);
		expect(
			tools.get("site_transfer_prepare_export")?.annotations?.readOnlyHint,
		).toBe(true);
		expect(
			tools.get("site_transfer_prepare_export")?.inputSchema.safeParse({
				sourceSlug: "source",
				targetSlug: "target",
				exportOperationId: "export_1",
			}).success,
		).toBe(true);
		expect(
			tools.get("site_transfer_create_import")?.inputSchema.safeParse({
				sourceSlug: "source",
				targetSlug: "target",
				exportOperationId: "export_1",
				limit: 3,
			}).success,
		).toBe(false);
	});

	it("advertises the eight upstream 0.41 tools with digest and decision validation", () => {
		const tools = registered(baseContext);
		for (const name of [
			"site_transfer_capabilities",
			"site_export_start",
			"site_export_status",
			"site_import_analyze",
			"site_import_start",
			"site_import_status",
			"site_import_resume",
			"site_import_receipt",
		]) {
			expect(tools.has(name)).toBe(true);
		}
		expect(
			tools.get("site_transfer_capabilities")?.annotations?.readOnlyHint,
		).toBe(true);
		expect(tools.get("site_import_start")?.annotations?.destructiveHint).toBe(
			true,
		);
		expect(
			tools.get("site_import_start")?.inputSchema.safeParse({
				operationId: "import_1",
				packageDigest: "sha256:bad",
				planDigest: "sha256:bad",
			}).success,
		).toBe(false);
		expect(
			tools.get("site_import_analyze")?.inputSchema.safeParse({
				operationId: "import_1",
				decisions: {
					principalMappings: { source_1: null },
					siteTitle: "target",
				},
			}).success,
		).toBe(true);
	});

	it("rejects non-admin and missing-PAT calls before tenant dispatch", async () => {
		let requests = 0;
		const cmsDispatch = {
			fetch: async () => {
				requests++;
				throw new Error("unexpected dispatch");
			},
		} as unknown as Fetcher;
		const member = registered({
			...baseContext,
			cmsDispatch,
			serviceApiKey: "ec_pat_secret",
		});
		const forbidden = await member
			.get("site_export_start")!
			.call({ comments: true });
		expect(forbidden.isError).toBe(true);
		expect(forbidden.content[0]?.text).toContain("Platform admin required");
		const admin = registered({
			...baseContext,
			cmsDispatch,
			isPlatformAdmin: true,
		});
		const unauthorized = await admin
			.get("site_transfer_capabilities")!
			.call({});
		expect(unauthorized.isError).toBe(true);
		expect(unauthorized.content[0]?.text).toContain("service PAT");
		expect(requests).toBe(0);
	});

	it("uses native transfer REST for verified humans without substituting a stored PAT", async () => {
		const identity = {
			siteId: "site-one",
			slug: "tedix",
			bundleEtag: "bundle-one",
			tenantId: "tenant-one",
			subject: "human-one",
			email: "human@example.com",
			name: "Human",
			role: 50 as const,
		};
		const calls: Array<{ method: string; path: string; body: unknown }> = [];
		const tools = registered({
			...baseContext,
			isPlatformAdmin: true,
			humanAuthRequired: true,
			humanIdentity: identity,
			serviceApiKey: "ec_pat_do_not_use",
			internalAuthToken: "trusted",
			cmsDispatch: {
				fetch: async (request: Request) => {
					expect(request.headers.get("X-Tedix-CMS-Human-Identity")).toBe(
						encodeCmsHumanIdentity(identity),
					);
					expect(request.headers.has("authorization")).toBe(false);
					expect(request.headers.has("X-Tedix-CMS-Internal-Auth")).toBe(false);
					calls.push({
						method: request.method,
						path: new URL(request.url).pathname,
						body: request.body ? await request.json() : undefined,
					});
					return Response.json({
						success: true,
						data: { operation: { id: "op_1", state: "complete" } },
					});
				},
			} as Fetcher,
		});
		const digest = `sha256:${"a".repeat(64)}`;
		for (const [name, args] of [
			["site_transfer_capabilities", {}],
			["site_export_start", { comments: false }],
			["site_export_status", { operationId: "op_1" }],
			["site_export_status", { operationId: "op_1", advance: false }],
			[
				"site_import_analyze",
				{ operationId: "op_1", decisions: { siteTitle: "target" } },
			],
			[
				"site_import_start",
				{ operationId: "op_1", packageDigest: digest, planDigest: digest },
			],
			["site_import_status", { operationId: "op_1" }],
			["site_import_resume", { operationId: "op_1" }],
			["site_import_receipt", { operationId: "op_1" }],
		] as const)
			expect((await tools.get(name)!.call(args)).isError).toBeUndefined();
		expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
			"GET /_emdash/api/admin/transfer/capabilities",
			"POST /_emdash/api/admin/transfer/exports",
			"POST /_emdash/api/admin/transfer/exports/op_1/advance",
			"GET /_emdash/api/admin/transfer/exports/op_1",
			"POST /_emdash/api/admin/transfer/imports/op_1/analyze",
			"POST /_emdash/api/admin/transfer/imports/op_1/execute",
			"GET /_emdash/api/admin/transfer/imports/op_1",
			"POST /_emdash/api/admin/transfer/imports/op_1/advance",
			"GET /_emdash/api/admin/transfer/imports/op_1/receipt",
		]);
		expect(calls[1]?.body).toEqual({ comments: false });
		expect(calls[4]?.body).toEqual({ decisions: { siteTitle: "target" } });
		expect(calls[5]?.body).toEqual({
			packageDigest: digest,
			planDigest: digest,
		});
	});
	it("fails closed on missing human identity and native transfer permission denial", async () => {
		let count = 0;
		const identity = {
			siteId: "site-one",
			slug: "tedix",
			bundleEtag: "bundle-one",
			tenantId: "tenant-one",
			subject: "human-one",
			email: "human@example.com",
			name: "Human",
			role: 40 as const,
		};
		const ctx = {
			...baseContext,
			isPlatformAdmin: true,
			humanAuthRequired: true,
			serviceApiKey: "ec_pat_do_not_use",
			internalAuthToken: "trusted",
			cmsDispatch: {
				fetch: async () => {
					count++;
					return Response.json(
						{
							error: { code: "FORBIDDEN", message: "Missing transfer:export" },
						},
						{ status: 403 },
					);
				},
			} as unknown as Fetcher,
		};
		expect(
			(await registered(ctx).get("site_export_start")!.call({})).isError,
		).toBe(true);
		expect(count).toBe(0);
		expect(
			(
				await registered({ ...ctx, humanIdentity: identity })
					.get("site_export_start")!
					.call({})
			).isError,
		).toBe(true);
		expect(count).toBe(1);
	});

	it("forwards control arguments only to the authorized tenant native MCP endpoint", async () => {
		const calls: Array<{ name: string; arguments: Record<string, unknown> }> =
			[];
		const paths: string[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			isPlatformAdmin: true,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					paths.push(new URL(request.url).pathname);
					expect(request.headers.get("authorization")).toBe(
						"Bearer ec_pat_secret",
					);
					const body = (await request.json()) as {
						id: number;
						method: string;
						params?: { name: string; arguments: Record<string, unknown> };
					};
					const handshake = emdashMcpHandshake(body);
					if (handshake) return handshake;
					calls.push(body.params!);
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							content: [
								{
									type: "text",
									text: JSON.stringify({ id: "export_1", state: "running" }),
								},
							],
						},
					});
				},
			} as Fetcher,
		};
		const result = await registered(ctx)
			.get("site_export_start")!
			.call({ comments: false });
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
			id: "export_1",
			state: "running",
		});
		expect(calls).toMatchObject([
			{ name: "site_export_start", arguments: { comments: false } },
		]);
		// Handshake plus one tools/call, all on the tenant MCP endpoint.
		expect(paths).toEqual(
			[...EMDASH_HANDSHAKE, "tools/call"].map(() => "/_emdash/api/mcp"),
		);
	});
});

describe("native Emdash collection admin configuration", () => {
	it("preserves native editLocking in create/update REST contracts", async () => {
		const tools = new Map<
			string,
			{ inputSchema: { parse(value: unknown): Record<string, unknown> } }
		>();
		registerCmsProxyTools(
			{
				registerTool: (name: string, definition: any) =>
					tools.set(name, definition),
			} as any,
			baseContext,
		);
		const bodies: unknown[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					bodies.push(await request.json());
					return Response.json({ success: true, data: {} });
				},
			} as Fetcher,
		};
		for (const [name, editLocking] of [
			["schema_create_collection", true],
			["schema_update_collection", false],
		] as const) {
			const args = tools.get(name)!.inputSchema.parse({
				slug: "pages",
				label: "Pages",
				editLocking,
				routable: false,
				group: "Marketing",
				sortOrder: 2,
			});
			expect(args.editLocking).toBe(editLocking);
			await callCmsRest(ctx, name, args);
		}
		expect(bodies).toEqual([
			{
				slug: "pages",
				label: "Pages",
				editLocking: true,
				routable: false,
				group: "Marketing",
				sortOrder: 2,
			},
			{
				label: "Pages",
				editLocking: false,
				routable: false,
				group: "Marketing",
				sortOrder: 2,
			},
		]);
	});

	it("forwards editLocking to native MCP without dropping false", async () => {
		const calls: unknown[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const body = (await request.json()) as any;
					const handshake = emdashMcpHandshake(body);
					if (handshake) return handshake;
					calls.push(body.params);
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: { content: [{ type: "text", text: "{}" }] },
					});
				},
			} as Fetcher,
		};
		await callCmsRest(ctx, "schema_update_collection", {
			slug: "pages",
			editLocking: false,
			routable: false,
			group: null,
			titleField: "name",
		});
		expect(calls).toEqual([
			{
				name: "schema_update_collection",
				arguments: {
					slug: "pages",
					editLocking: false,
					routable: false,
					group: null,
					titleField: "name",
				},
			},
		]);
	});

	it("merges partial admin updates and forwards collection visibility", async () => {
		type Tool = {
			inputSchema: { safeParse(value: unknown): { success: boolean } };
			call: (args: Record<string, unknown>) => Promise<{ isError?: true }>;
		};
		const tools = new Map<string, Tool>();
		const requests: Array<{ method: string; path: string; body?: unknown }> =
			[];
		let directGetEnvelope = false;
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (input: Request) => {
					requests.push({
						method: input.method,
						path: new URL(input.url).pathname,
						...(input.method === "PUT" ? { body: await input.json() } : {}),
					});
					const collection = {
						slug: "pages",
						icon: "file-text",
						admin: { listColumns: ["title"], quickCreate: true },
					};
					return Response.json({
						success: true,
						data:
							input.method === "GET" && directGetEnvelope
								? collection
								: { item: collection },
					});
				},
			} as Fetcher,
		};
		registerCmsProxyTools(
			{
				registerTool: (name: string, definition: Tool, call: Tool["call"]) =>
					tools.set(name, { ...definition, call }),
			} as any,
			ctx,
		);
		const tool = tools.get("schema_update_collection")!;
		expect(
			tool.inputSchema.safeParse({
				slug: "pages",
				hidden: true,
				admin: { quickCreate: false },
			}).success,
		).toBe(true);
		expect(
			tool.inputSchema.safeParse({ slug: "pages", hidden: "yes" }).success,
		).toBe(false);
		expect(
			tool.inputSchema.safeParse({
				slug: "pages",
				admin: { quickCreate: "no" },
			}).success,
		).toBe(false);
		expect(
			tool.inputSchema.safeParse({ slug: "pages", admin: { listColumns: [] } })
				.success,
		).toBe(true);
		expect(
			tool.inputSchema.safeParse({
				slug: "pages",
				admin: { listColumns: ["invalid-slug"] },
			}).success,
		).toBe(false);
		expect(
			tool.inputSchema.safeParse({
				slug: "pages",
				admin: { listColumns: ["a", "b", "c", "d", "e"] },
			}).success,
		).toBe(false);

		const result = await tool.call({
			slug: "pages",
			admin: { listColumns: [] },
		});
		expect(result.isError).toBeUndefined();
		expect(requests).toEqual([
			{ method: "GET", path: "/_emdash/api/schema/collections/pages" },
			{
				method: "PUT",
				path: "/_emdash/api/schema/collections/pages",
				body: { admin: { listColumns: [], quickCreate: true } },
			},
		]);
		requests.length = 0;
		directGetEnvelope = true;

		const visibility = await tool.call({
			slug: "pages",
			hidden: true,
			admin: { quickCreate: false },
		});
		expect(visibility.isError).toBeUndefined();
		expect(requests).toEqual([
			{ method: "GET", path: "/_emdash/api/schema/collections/pages" },
			{
				method: "PUT",
				path: "/_emdash/api/schema/collections/pages",
				body: {
					hidden: true,
					admin: { listColumns: ["title"], quickCreate: false },
				},
			},
		]);
	});
});

describe("native Emdash relations proxy", () => {
	it("accepts native repeater URL and image subfields for create and update", () => {
		const tools = new Map<string, any>();
		registerCmsProxyTools(
			{
				registerTool: (name: string, definition: any) =>
					tools.set(name, definition),
			} as any,
			baseContext,
		);
		const validation = {
			subFields: [
				{
					slug: "destination",
					label: "Destination",
					type: "url",
					required: true,
				},
				{ slug: "image", label: "Image", type: "image" },
			],
		};
		for (const [name, identity] of [
			["schema_create_field", { slug: "links", label: "Links" }],
			["update_schema_field", { fieldSlug: "links" }],
		] as const) {
			const schema = tools.get(name).inputSchema;
			expect(
				schema.parse({
					collection: "pages",
					...identity,
					type: "repeater",
					validation,
				}).validation,
			).toEqual(validation);
			expect(
				schema.safeParse({
					collection: "pages",
					...identity,
					type: "repeater",
					validation: {
						subFields: [{ slug: "bad", label: "Bad", type: "reference" }],
					},
				}).success,
			).toBe(false);
		}
	});

	it("exposes relation and in-place field tools with reference validation", () => {
		type ToolDefinition = {
			inputSchema: {
				safeParse(value: unknown): { success: boolean; data?: unknown };
			};
		};
		const tools = new Map<string, ToolDefinition>();
		registerCmsProxyTools(
			{
				registerTool: (name: string, definition: ToolDefinition) => {
					tools.set(name, definition);
				},
			} as any,
			baseContext,
		);
		for (const name of [
			"list_relations",
			"get_relation",
			"create_relation",
			"update_relation",
			"delete_relation",
			"update_schema_field",
		]) {
			expect(tools.has(name)).toBe(true);
		}
		expect(
			tools.get("content_create")?.inputSchema.safeParse({
				collection: "posts",
				data: { title: "One" },
				references: { related_posts: ["post_2"] },
			}).success,
		).toBe(true);
		expect(
			tools.get("content_update")?.inputSchema.safeParse({
				collection: "posts",
				id: "post_1",
				data: { content: [{ _key: "hero-1", _version: 2 }] },
				migrateBlocks: true,
				replaceBlocks: false,
				_rev: "rev_1",
			}).data,
		).toMatchObject({ migrateBlocks: true, replaceBlocks: false });
		expect(
			tools.get("schema_create_field")?.inputSchema.safeParse({
				collection: "posts",
				slug: "related_posts",
				label: "Related posts",
				type: "reference",
				validation: {
					targetCollection: "posts",
					relation: "related_posts",
					relationSide: "parent",
					multiple: true,
				},
			}).success,
		).toBe(true);
	});

	it("forwards relation, field, and reference writes to the native REST contract", async () => {
		const requests: Array<{ method: string; path: string; body: unknown }> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					requests.push({
						method: request.method,
						path: new URL(request.url).pathname,
						body: request.body ? await request.json() : undefined,
					});
					return Response.json({ success: true, data: { id: "relation_1" } });
				},
			} as Fetcher,
		};
		await callCmsRest(ctx, "relation_create", {
			slug: "related_posts",
			parentCollection: "posts",
			childCollection: "posts",
			parentLabel: "Related posts",
			childLabel: "Related to",
		});
		await callCmsRest(ctx, "schema_update_field", {
			collection: "posts",
			fieldSlug: "related_posts",
			validation: { relation: "related_posts", relationSide: "parent" },
		});
		await callCmsRest(ctx, "content_update", {
			collection: "posts",
			id: "post_1",
			references: { related_posts: ["post_2"] },
			migrateBlocks: true,
			replaceBlocks: false,
			_rev: "rev_1",
		});
		expect(requests).toMatchObject([
			{
				method: "POST",
				path: "/_emdash/api/relations",
				body: { slug: "related_posts", parentCollection: "posts" },
			},
			{
				method: "PUT",
				path: "/_emdash/api/schema/collections/posts/fields/related_posts",
				body: {
					validation: { relation: "related_posts", relationSide: "parent" },
				},
			},
			{
				method: "PUT",
				path: "/_emdash/api/content/posts/post_1",
				body: {
					references: { related_posts: ["post_2"] },
					migrateBlocks: true,
					replaceBlocks: false,
					_rev: "rev_1",
				},
			},
		]);
	});
});

describe("native Emdash media usage maintenance", () => {
	it("lists a bounded read-only page of collection deletions for platform admins", async () => {
		type RegisteredTool = {
			definition: {
				inputSchema: { safeParse(value: unknown): { success: boolean } };
				outputSchema?: { safeParse(value: unknown): { success: boolean } };
				annotations?: { readOnlyHint?: boolean };
			};
			call: (
				args: Record<string, unknown>,
			) => Promise<{ content: Array<{ text: string }>; isError?: true }>;
		};
		const tools = new Map<string, RegisteredTool>();
		const requests: Request[] = [];
		registerCmsProxyTools(
			{
				registerTool: (
					name: string,
					definition: RegisteredTool["definition"],
					call: RegisteredTool["call"],
				) => tools.set(name, { definition, call }),
			} as any,
			{
				...baseContext,
				isPlatformAdmin: true,
				forwardedAuth: "aaa.bbb.ccc",
				cmsDispatch: {
					fetch: async (request: Request) => {
						requests.push(request);
						return Response.json({
							success: true,
							data: {
								items: [
									{
										collectionId: "collection-1",
										collectionSlug: "posts",
										state: "leased",
										phase: "registry",
										attemptCount: 3,
										nextAttemptAt: "2026-09-28T12:00:00Z",
										leaseExpiresAt: "2026-09-28T12:05:00Z",
										lastErrorCode: "REGISTRY_LOCKED",
										updatedAt: "2026-09-28T11:59:00Z",
									},
								],
								nextCursor: "next",
							},
						});
					},
				} as Fetcher,
			},
		);
		const tool = tools.get("list_collection_deletions");
		expect(tool?.definition.annotations?.readOnlyHint).toBe(true);
		expect(
			tool?.definition.inputSchema.safeParse({
				state: "leased",
				limit: 100,
				cursor: "page",
			}).success,
		).toBe(true);
		expect(
			tool?.definition.inputSchema.safeParse({ state: "complete" }).success,
		).toBe(false);
		expect(tool?.definition.inputSchema.safeParse({ limit: 101 }).success).toBe(
			false,
		);
		const response = await tool?.call({
			state: "leased",
			limit: 20,
			cursor: "page",
		});
		expect(response?.isError).toBeUndefined();
		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("GET");
		expect(new URL(requests[0]!.url).pathname).toBe(
			"/_emdash/api/admin/media-usage/collection-deletions",
		);
		expect(new URL(requests[0]!.url).search).toBe(
			"?state=leased&limit=20&cursor=page",
		);
		expect(requests[0]?.headers.get("cookie")).toBe("DS=aaa.bbb.ccc");
		const result = JSON.parse(response!.content[0]!.text);
		expect(tool?.definition.outputSchema?.safeParse(result).success).toBe(true);
		expect(result.data.items[0]).toMatchObject({
			attemptCount: 3,
			leaseExpiresAt: "2026-09-28T12:05:00Z",
			lastErrorCode: "REGISTRY_LOCKED",
		});
	});

	it("forwards coverage-aware media reads and paged usage details to Emdash REST", async () => {
		type RegisteredTool = {
			definition: {
				inputSchema: { safeParse(value: unknown): { success: boolean } };
				outputSchema?: { safeParse(value: unknown): { success: boolean } };
				annotations?: { readOnlyHint?: boolean };
			};
			call: (args: Record<string, unknown>) => Promise<unknown>;
		};
		const tools = new Map<string, RegisteredTool>();
		const requests: Request[] = [];
		registerCmsProxyTools(
			{
				registerTool: (
					name: string,
					definition: RegisteredTool["definition"],
					call: RegisteredTool["call"],
				) => tools.set(name, { definition, call }),
			} as any,
			{
				...baseContext,
				mediaMaintenanceAuthorized: true,
				forwardedAuth: "aaa.bbb.ccc",
				internalAuthToken: "internal_secret",
				cmsDispatch: {
					fetch: async (request: Request) => {
						requests.push(request);
						return Response.json({ success: true, data: { items: [] } });
					},
				} as Fetcher,
			},
		);
		const usage = tools.get("get_media_usage");
		expect(usage?.definition.annotations?.readOnlyHint).toBe(true);
		expect(
			usage?.definition.inputSchema.safeParse({ id: "media-1", limit: 101 })
				.success,
		).toBe(false);
		expect(
			usage?.definition.outputSchema?.safeParse({
				success: true,
				data: {
					items: [
						{
							collection: "posts",
							contentId: "post-1",
							title: "Post",
							slug: "post",
							locale: "de",
							status: "draft",
							scheduledAt: null,
							deletedAt: null,
							sources: [{ variant: "draft_overlay", occurrences: [] }],
						},
					],
					siteSettings: [],
					coverage: { scope: "all_content_collections", status: "stale" },
				},
			}).success,
		).toBe(true);
		await tools.get("media_list")?.call({
			folderId: "unfiled",
			includeUsage: true,
			limit: 20,
		});
		await tools.get("media_get")?.call({ id: "media-1", includeUsage: true });
		await usage?.call({ id: "media-1", limit: 10, cursor: "opaque" });
		expect(
			requests.map((request) => [
				request.method,
				new URL(request.url).pathname,
				new URL(request.url).search,
			]),
		).toEqual([
			[
				"GET",
				"/_emdash/api/media",
				"?folderId=unfiled&includeUsage=1&limit=20",
			],
			["GET", "/_emdash/api/media/media-1", "?includeUsage=1"],
			["GET", "/_emdash/api/media/media-1/usage", "?limit=10&cursor=opaque"],
		]);
		for (const request of requests) {
			expect(request.headers.get("cookie")).toBe("DS=aaa.bbb.ccc");
			expect(request.headers.has("authorization")).toBe(false);
		}
	});

	it("denies usage details to a tenant member without maintenance authority", async () => {
		let usage:
			| ((args: Record<string, unknown>) => Promise<unknown>)
			| undefined;
		registerCmsProxyTools(
			{
				registerTool: (
					name: string,
					_definition: unknown,
					call: (args: Record<string, unknown>) => Promise<unknown>,
				) => {
					if (name === "get_media_usage") usage = call;
				},
			} as any,
			{
				...baseContext,
				serviceApiKey: "ec_pat_service",
				cmsDispatch: {
					fetch: () => {
						throw new Error("Unauthorized usage read reached CMS");
					},
				} as unknown as Fetcher,
			},
		);
		expect(await usage?.({ id: "media-1" })).toMatchObject({ isError: true });
	});

	it("requires a collection for scoped repair and forwards the operator identity", async () => {
		type RegisteredTool = {
			definition: {
				inputSchema: { safeParse(value: unknown): { success: boolean } };
			};
			handler: (args: Record<string, unknown>) => Promise<unknown>;
		};
		const tools = new Map<string, RegisteredTool>();
		const requests: Request[] = [];
		registerCmsProxyTools(
			{
				registerTool: (
					name: string,
					definition: RegisteredTool["definition"],
					handler: RegisteredTool["handler"],
				) => {
					tools.set(name, { definition, handler });
				},
			} as any,
			{
				...baseContext,
				isPlatformAdmin: true,
				mediaMaintenanceAuthorized: true,
				forwardedAuth: "aaa.bbb.ccc",
				serviceApiKey: "ec_pat_service",
				internalAuthToken: "internal_secret",
				cmsDispatch: {
					fetch: async (request: Request) => {
						requests.push(request);
						return Response.json({
							success: true,
							data: { status: "complete" },
						});
					},
				} as Fetcher,
			},
		);
		const repair = tools.get("repair_media_usage");
		expect(repair).toBeDefined();
		expect(
			repair?.definition.inputSchema.safeParse({ scope: "collection" }).success,
		).toBe(false);
		expect(
			repair?.definition.inputSchema.safeParse({
				scope: "collection",
				collection: "posts",
			}).success,
		).toBe(true);
		const activate = tools.get("activate_media_usage");
		expect(activate?.definition.inputSchema.safeParse({}).success).toBe(false);
		expect(
			activate?.definition.inputSchema.safeParse({ writersDrained: false })
				.success,
		).toBe(false);
		expect(
			activate?.definition.inputSchema.safeParse({ writersDrained: true })
				.success,
		).toBe(true);
		await tools.get("get_media_usage_activation")?.handler({});
		await activate?.handler({ writersDrained: true });
		await tools.get("get_media_usage_progress")?.handler({});
		await tools.get("advance_media_usage_index")?.handler({});
		await repair?.handler({ scope: "collection", collection: "posts" });
		expect(
			requests.map((request) => [
				request.method,
				new URL(request.url).pathname,
			]),
		).toEqual([
			["GET", "/_emdash/api/admin/media-usage/activation"],
			["POST", "/_emdash/api/admin/media-usage/activation"],
			["GET", "/_emdash/api/admin/media-usage/progress"],
			["POST", "/_emdash/api/admin/media-usage/progress"],
			["POST", "/_emdash/api/admin/media-usage/repair"],
		]);
		expect(await requests[1]?.json()).toEqual({ writersDrained: true });
		expect(await requests[4]?.json()).toEqual({
			scope: "collection",
			collection: "posts",
		});
		for (const request of requests) {
			expect(request.headers.get("cookie")).toBe("DS=aaa.bbb.ccc");
			expect(request.headers.has("authorization")).toBe(false);
			expect(request.headers.has("x-tedix-cms-internal-auth")).toBe(false);
		}
	});

	it("blocks activation and index advancement before forwarding without platform admin authority", async () => {
		const tools = new Map<
			string,
			(args: Record<string, unknown>) => Promise<unknown>
		>();
		registerCmsProxyTools(
			{
				registerTool: (
					name: string,
					_definition: unknown,
					handler: (args: Record<string, unknown>) => Promise<unknown>,
				) => tools.set(name, handler),
			} as any,
			{
				...baseContext,
				mediaMaintenanceAuthorized: true,
				serviceApiKey: "ec_pat_service",
				internalAuthToken: "internal_secret",
				cmsDispatch: {
					fetch: () => {
						throw new Error(
							"Non-platform caller must not reach Emdash activation",
						);
					},
				} as unknown as Fetcher,
			},
		);
		for (const [name, args] of [
			["get_media_usage_activation", {}],
			["activate_media_usage", { writersDrained: true }],
			["get_media_usage_progress", {}],
			["advance_media_usage_index", {}],
			["list_collection_deletions", { state: "leased" }],
		] as const) {
			expect(await tools.get(name)?.(args)).toMatchObject({ isError: true });
		}
	});

	it("denies callers without content-admin authority even when a site service credential exists", async () => {
		let repair:
			| ((args: Record<string, unknown>) => Promise<unknown>)
			| undefined;
		registerCmsProxyTools(
			{
				registerTool: (
					name: string,
					_definition: unknown,
					handler: (args: Record<string, unknown>) => Promise<unknown>,
				) => {
					if (name === "repair_media_usage") repair = handler;
				},
			} as any,
			{
				...baseContext,
				serviceApiKey: "ec_pat_service",
				internalAuthToken: "internal_secret",
				cmsDispatch: {
					fetch: () => {
						throw new Error("Non-admin caller must not reach the CMS");
					},
				} as unknown as Fetcher,
			},
		);
		expect(await repair?.({ scope: "all" })).toMatchObject({ isError: true });
	});
});

describe("native Emdash media folders", () => {
	it("forwards folder CRUD and media moves over REST", async () => {
		type RegisteredTool = {
			definition: {
				inputSchema: { safeParse(value: unknown): { success: boolean } };
			};
			call: (args: Record<string, unknown>) => Promise<unknown>;
		};
		const tools = new Map<string, RegisteredTool>();
		const requests: Request[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			forwardedAuth: "aaa.bbb.ccc",
			serviceApiKey: "ec_pat_service",
			cmsDispatch: {
				fetch: async (request: Request) => {
					requests.push(request);
					return Response.json({
						success: true,
						data: { item: { id: "folder-1", name: "Assets" }, items: [] },
					});
				},
			} as Fetcher,
		};
		registerCmsProxyTools(
			{
				registerTool: (
					name: string,
					definition: RegisteredTool["definition"],
					call: RegisteredTool["call"],
				) => tools.set(name, { definition, call }),
			} as any,
			ctx,
		);
		expect(
			tools
				.get("create_media_folder")
				?.definition.inputSchema.safeParse({ name: "  " }).success,
		).toBe(false);
		expect(
			tools
				.get("media_update")
				?.definition.inputSchema.safeParse({ id: "media-1", folderId: null })
				.success,
		).toBe(true);
		expect(
			shouldForwardCmsRestToTenantMcp(ctx, "media_update", {
				id: "media-1",
				folderId: "folder-1",
			}),
		).toBe(false);
		await tools.get("list_media_folders")?.call({ limit: 10, q: "Assets" });
		await tools.get("get_media_folder")?.call({ id: "folder-1" });
		await tools.get("create_media_folder")?.call({ name: "Assets" });
		await tools
			.get("rename_media_folder")
			?.call({ id: "folder-1", name: "Images" });
		await tools
			.get("media_update")
			?.call({ id: "media-1", folderId: "folder-1" });
		await tools.get("delete_media_folder")?.call({ id: "folder-1" });
		expect(
			requests.map((request) => [
				request.method,
				new URL(request.url).pathname,
				new URL(request.url).search,
			]),
		).toEqual([
			["GET", "/_emdash/api/media/folders", "?limit=10&q=Assets"],
			["GET", "/_emdash/api/media/folders/folder-1", ""],
			["POST", "/_emdash/api/media/folders", ""],
			["PUT", "/_emdash/api/media/folders/folder-1", ""],
			["PUT", "/_emdash/api/media/media-1", ""],
			["DELETE", "/_emdash/api/media/folders/folder-1", ""],
		]);
		expect(await requests[2]?.json()).toEqual({ name: "Assets" });
		expect(await requests[3]?.json()).toEqual({ name: "Images" });
		expect(await requests[4]?.json()).toEqual({ folderId: "folder-1" });
	});
});

describe("isJwt", () => {
	it("accepts a compact JWT shape", () => {
		expect(isJwt("aaa.bbb.ccc")).toBe(true);
	});

	it("rejects Emdash token formats", () => {
		expect(isJwt("ec_pat_secret")).toBe(false);
		expect(isJwt("ec_oat_secret")).toBe(false);
	});
});

describe("versioned block schema proxy", () => {
	const blockField = { slug: "heading", label: "Heading", type: "string" };
	const blockType = {
		id: "block_1",
		slug: "hero",
		label: "Hero",
		currentVersion: 1,
		source: "user",
		versions: [
			{
				id: "version_1",
				blockTypeId: "block_1",
				version: 1,
				fields: [blockField],
				fingerprint: "fingerprint_1",
				active: true,
				createdAt: "2026-09-26T00:00:00Z",
				updatedAt: "2026-09-26T00:00:00Z",
			},
		],
		createdAt: "2026-09-26T00:00:00Z",
		updatedAt: "2026-09-26T00:00:00Z",
	};

	it("advertises five block tools and validates their versioned contracts", () => {
		type ToolDefinition = {
			inputSchema: { safeParse(value: unknown): { success: boolean } };
			outputSchema?: { safeParse(value: unknown): { success: boolean } };
			annotations?: { readOnlyHint?: boolean };
		};
		const tools = new Map<string, ToolDefinition>();
		registerCmsProxyTools(
			{
				registerTool: (name: string, definition: ToolDefinition) => {
					tools.set(name, definition);
				},
			} as any,
			baseContext,
		);

		for (const name of [
			"schema_list_block_types",
			"schema_get_block_type",
			"schema_create_block_type",
			"schema_update_block_type",
			"schema_activate_block_type_version",
		])
			expect(tools.get(name), name).toBeDefined();
		expect(
			tools.get("schema_list_block_types")?.annotations?.readOnlyHint,
		).toBe(true);
		expect(tools.get("schema_get_block_type")?.annotations?.readOnlyHint).toBe(
			true,
		);
		expect(
			tools.get("schema_list_block_types")?.outputSchema?.safeParse({
				success: true,
				data: { items: [blockType] },
			}).success,
		).toBe(true);
		expect(
			tools.get("schema_get_block_type")?.outputSchema?.safeParse({
				success: true,
				data: { item: blockType },
			}).success,
		).toBe(true);
		expect(
			tools.get("schema_create_block_type")?.inputSchema.safeParse({
				slug: "hero",
				label: "Hero",
				fields: [blockField],
			}).success,
		).toBe(true);
		expect(
			tools.get("schema_create_block_type")?.inputSchema.safeParse({
				slug: "Bad Slug",
				label: "Hero",
				fields: [blockField],
			}).success,
		).toBe(false);
		expect(
			tools.get("schema_create_block_type")?.inputSchema.safeParse({
				slug: "hero",
				label: "Hero",
				fields: [{ ...blockField, type: "reference" }],
			}).success,
		).toBe(false);
		expect(
			tools.get("schema_update_block_type")?.inputSchema.safeParse({
				slug: "hero",
				expectedFingerprint: "",
				breaking: true,
			}).success,
		).toBe(false);
		expect(
			tools.get("schema_activate_block_type_version")?.inputSchema.safeParse({
				slug: "hero",
				version: 0,
				expectedFingerprint: "fingerprint_1",
			}).success,
		).toBe(false);
		expect(
			tools.get("schema_activate_block_type_version")?.inputSchema.safeParse({
				slug: "hero",
				version: 2,
				expectedFingerprint: "fingerprint_1",
			}).success,
		).toBe(true);
		expect(
			tools.get("schema_create_field")?.inputSchema.safeParse({
				collection: "pages",
				slug: "sections",
				label: "Sections",
				type: "blocks",
				validation: { allowedTypes: ["hero"], retiredTypes: ["old_hero"] },
			}).success,
		).toBe(true);
	});

	it("maps all five tools to Emdash REST with human JWT attribution", async () => {
		const requests: Array<{
			method: string;
			path: string;
			body: unknown;
			cookie: string | null;
			authorization: string | null;
		}> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			forwardedAuth: "aaa.bbb.ccc",
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					requests.push({
						method: request.method,
						path: new URL(request.url).pathname,
						body: request.body ? await request.json() : undefined,
						cookie: request.headers.get("cookie"),
						authorization: request.headers.get("authorization"),
					});
					return Response.json({
						success: true,
						data:
							request.method === "GET" &&
							new URL(request.url).pathname.endsWith("/block-types")
								? { items: [blockType] }
								: { item: blockType },
					});
				},
			} as Fetcher,
		};
		const cases = [
			[
				"schema_list_block_types",
				{},
				"GET",
				"/_emdash/api/schema/block-types",
				undefined,
			],
			[
				"schema_get_block_type",
				{ slug: "hero" },
				"GET",
				"/_emdash/api/schema/block-types/hero",
				undefined,
			],
			[
				"schema_create_block_type",
				{ slug: "hero", label: "Hero", fields: [blockField] },
				"POST",
				"/_emdash/api/schema/block-types",
				{ slug: "hero", label: "Hero", fields: [blockField] },
			],
			[
				"schema_update_block_type",
				{
					slug: "hero",
					expectedFingerprint: "fingerprint_1",
					fields: [blockField],
					breaking: true,
				},
				"PUT",
				"/_emdash/api/schema/block-types/hero",
				{
					expectedFingerprint: "fingerprint_1",
					fields: [blockField],
					breaking: true,
				},
			],
			[
				"schema_activate_block_type_version",
				{ slug: "hero", version: 2, expectedFingerprint: "fingerprint_1" },
				"POST",
				"/_emdash/api/schema/block-types/hero/versions/2/activate",
				{ expectedFingerprint: "fingerprint_1" },
			],
		] as const;
		for (const [name, args, method, path, body] of cases) {
			const result = await callCmsRest(ctx, name, args);
			expect(result.isError, name).toBeUndefined();
			expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
				success: true,
				data:
					name === "schema_list_block_types"
						? { items: [blockType] }
						: { item: blockType },
			});
			expect(requests.at(-1)).toEqual({
				method,
				path,
				body,
				cookie: "DS=aaa.bbb.ccc",
				authorization: null,
			});
		}
		expect(requests).toHaveLength(cases.length);
	});

	it("passes blocks field allowlists to the collection schema route", async () => {
		let sent: unknown;
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					expect(request.method).toBe("POST");
					expect(new URL(request.url).pathname).toBe(
						"/_emdash/api/schema/collections/pages/fields",
					);
					sent = await request.json();
					return Response.json({
						success: true,
						data: { item: { slug: "sections" } },
					});
				},
			} as Fetcher,
		};
		const result = await callCmsRest(ctx, "schema_create_field", {
			collection: "pages",
			slug: "sections",
			label: "Sections",
			type: "blocks",
			validation: { allowedTypes: ["hero"], retiredTypes: ["old_hero"] },
		});
		expect(result.isError).toBeUndefined();
		expect(sent).toMatchObject({
			type: "blocks",
			validation: { allowedTypes: ["hero"], retiredTypes: ["old_hero"] },
		});
	});

	it.each(["schema_update_block_type", "schema_activate_block_type_version"])(
		"preserves %s REST conflicts without retrying a write",
		async (name) => {
			let calls = 0;
			// The REST transport (no PAT). The native transport's conflict is
			// proven against real Emdash in tenant-mcp-emdash.test.ts.
			const ctx: CmsProxyContext = {
				...baseContext,
				internalAuthToken: "internal_secret",
				cmsDispatch: {
					fetch: async (_request: Request) => {
						calls++;
						return Response.json(
							{
								success: false,
								error: { code: "CONFLICT", message: "Block type changed" },
							},
							{ status: 409 },
						);
					},
				} as Fetcher,
			};
			const args =
				name === "schema_update_block_type"
					? { slug: "hero", expectedFingerprint: "old" }
					: { slug: "hero", version: 2, expectedFingerprint: "old" };
			const result = await callCmsRest(ctx, name, args);
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("CONFLICT");
			expect(calls).toBe(1);
		},
	);
});

describe("buildCmsAuthHeaderCandidates", () => {
	it("attests a human JWT without granting tenant internal-admin authority", () => {
		const headers =
			buildCmsAuthHeaders({
				...baseContext,
				forwardedAuth: "aaa.bbb.ccc",
				internalAuthToken: "internal_secret",
			}) ?? {};
		expect(headers).toMatchObject({
			Cookie: "DS=aaa.bbb.ccc",
			"X-Tedix-CMS-Forwarded-User-Auth": "internal_secret",
		});
		expect(headers["X-Tedix-CMS-Internal-Auth"]).toBeUndefined();
	});

	it("preserves forwarded user JWTs over stored service PATs", () => {
		expect(
			buildCmsAuthHeaders({
				...baseContext,
				serviceApiKey: "ec_pat_secret",
				forwardedAuth: "aaa.bbb.ccc",
			}),
		).toEqual({
			Accept: "application/json",
			Cookie: "DS=aaa.bbb.ccc",
			"X-EmDash-Request": "1",
		});
	});

	it("never retries a human JWT with a privileged site credential", () => {
		expect(
			buildCmsAuthHeaderCandidates({
				...baseContext,
				serviceApiKey: "ec_pat_secret",
				internalAuthToken: "internal_secret",
				forwardedAuth: "aaa.bbb.ccc",
			}).map((candidate) => candidate.source),
		).toEqual(["jwt"]);
	});

	it("lets a verified platform admin recover from a CMS cookie 401", async () => {
		const seenAuth: string[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			isPlatformAdmin: true,
			forwardedAuth: "aaa.bbb.ccc",
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					seenAuth.push(
						request.headers.get("cookie") ??
							request.headers.get("authorization") ??
							"",
					);
					if (request.headers.has("cookie"))
						return new Response("Authentication failed", { status: 401 });
					return Response.json({ success: true, data: { taxonomies: [] } });
				},
			} as Fetcher,
		};
		const result = await callCmsRest(ctx, "taxonomy_list", {});
		expect(result.isError).toBeUndefined();
		expect(seenAuth).toEqual(["DS=aaa.bbb.ccc", "Bearer ec_pat_secret"]);
	});

	it("fails a human taxonomy delete on 403 without replaying as the site service", async () => {
		const authHeaders: Array<{
			cookie: string | null;
			authorization: string | null;
			internal: string | null;
		}> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			isPlatformAdmin: true,
			forwardedAuth: "aaa.bbb.ccc",
			serviceApiKey: "ec_pat_secret",
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					authHeaders.push({
						cookie: request.headers.get("cookie"),
						authorization: request.headers.get("authorization"),
						internal: request.headers.get("X-Tedix-CMS-Internal-Auth"),
					});
					return Response.json({ error: "Forbidden" }, { status: 403 });
				},
			} as Fetcher,
		};
		const result = await callCmsRest(ctx, "taxonomy_delete", {
			name: "topics",
		});
		expect(result.isError).toBe(true);
		expect(authHeaders).toEqual([
			{ cookie: "DS=aaa.bbb.ccc", authorization: null, internal: null },
		]);
	});

	it("forwards Descope JWTs as the DS cookie", () => {
		expect(
			buildCmsAuthHeaders({
				...baseContext,
				forwardedAuth: "aaa.bbb.ccc",
			}),
		).toEqual({
			Accept: "application/json",
			Cookie: "DS=aaa.bbb.ccc",
			"X-EmDash-Request": "1",
		});
	});

	it("falls back to service PATs as bearer tokens", () => {
		expect(
			buildCmsAuthHeaders({
				...baseContext,
				serviceApiKey: "ec_pat_secret",
			}),
		).toEqual({
			Accept: "application/json",
			Authorization: "Bearer ec_pat_secret",
			"X-EmDash-Request": "1",
		});
	});

	it("does not forward platform API keys as bearer tokens", () => {
		expect(
			buildCmsAuthHeaders({
				...baseContext,
				serviceApiKey: "sk_platform_api_key",
			}),
		).toBeNull();
	});

	it("falls back to the internal Site Builder service-binding header", () => {
		expect(
			buildCmsAuthHeaders({
				...baseContext,
				serviceApiKey: "sk_platform_api_key",
				internalAuthToken: "internal_secret",
			}),
		).toEqual({
			Accept: "application/json",
			"X-Tedix-CMS-Internal-Auth": "internal_secret",
			"X-EmDash-Request": "1",
		});
	});

	it("returns null when no CMS-compatible auth is available", () => {
		expect(
			buildCmsAuthHeaders({
				...baseContext,
				forwardedAuth: "sk_platform_api_key",
			}),
		).toBeNull();
	});
});

describe("mediaToFieldValue", () => {
	it("converts the tenant MCP media_get envelope into a local MediaValue", async () => {
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const body = (await request.json()) as Record<string, any>;
					const handshake = emdashMcpHandshake(body);
					if (handshake) return handshake;
					expect(body.params?.name).toBe("media_get");
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							content: [
								{
									type: "text",
									text: JSON.stringify({
										item: {
											id: "01MEDIA",
											filename: "feature.png",
											mimeType: "image/png",
											storageKey: "feature.png",
										},
									}),
								},
							],
						},
					});
				},
			} as Fetcher,
		};
		const result = await mediaToFieldValue(ctx, { mediaId: "01MEDIA" });
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({
			provider: "local",
			id: "01MEDIA",
			meta: { storageKey: "feature.png" },
		});
		expect(result).toHaveProperty("structuredContent", {
			provider: "local",
			id: "01MEDIA",
			filename: "feature.png",
			mimeType: "image/png",
			meta: { storageKey: "feature.png" },
		});
	});

	it("converts the native media_get envelope into a local MediaValue", async () => {
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					expect(new URL(request.url).pathname).toBe(
						"/_emdash/api/media/01MEDIA",
					);
					return Response.json({
						success: true,
						data: {
							item: {
								id: "01MEDIA",
								filename: "feature.png",
								mimeType: "image/png",
								storageKey: "feature.png",
								width: 1024,
								height: 768,
								focalX: 0,
								focalY: 1,
								blurhash: "LTEST",
								dominantColor: "rgb(10,20,30)",
								alt: "A featured image",
								status: "ready",
							},
						},
					});
				},
			} as Fetcher,
		};
		const result = await mediaToFieldValue(ctx, { mediaId: "01MEDIA" });
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
			provider: "local",
			id: "01MEDIA",
			filename: "feature.png",
			mimeType: "image/png",
			width: 1024,
			height: 768,
			focalX: 0,
			focalY: 1,
			blurhash: "LTEST",
			dominantColor: "rgb(10,20,30)",
			alt: "A featured image",
			meta: { storageKey: "feature.png" },
		});
		expect(result).toHaveProperty("structuredContent", {
			provider: "local",
			id: "01MEDIA",
			filename: "feature.png",
			mimeType: "image/png",
			width: 1024,
			height: 768,
			focalX: 0,
			focalY: 1,
			blurhash: "LTEST",
			dominantColor: "rgb(10,20,30)",
			alt: "A featured image",
			meta: { storageKey: "feature.png" },
		});
	});
});

describe("mediaUpload", () => {
	it("advertises only the upstream base64 upload contract", () => {
		let uploadSchema:
			| { safeParse(input: unknown): { success: boolean } }
			| undefined;
		registerCmsProxyTools(
			{
				registerTool: (
					name: string,
					definition: { inputSchema: typeof uploadSchema },
				) => {
					if (name === "media_upload") uploadSchema = definition.inputSchema;
				},
			} as any,
			baseContext,
		);
		expect(
			uploadSchema?.safeParse({
				filename: "cover.png",
				mimeType: "image/png",
				dataBase64: btoa("png"),
			}).success,
		).toBe(true);
		expect(
			uploadSchema?.safeParse({
				filename: "cover.png",
				url: "https://cdn.example.test/cover.png",
			}).success,
		).toBe(false);
		expect(
			uploadSchema?.safeParse({
				filename: "cover.png",
				mimeType: "image/png",
				dataBase64: btoa("png"),
				url: "https://cdn.example.test/cover.png",
			}).success,
		).toBe(false);
	});

	it("rejects direct URL upload calls before contacting the tenant", async () => {
		const result = await mediaUpload(baseContext, {
			filename: "remote.png",
			url: "https://cdn.example.test/remote.png",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("URL uploads are unsupported");
	});

	it("uploads through native media_upload with the service PAT and returns the stable success envelope", async () => {
		const calls: Array<{
			authorization: string | null;
			body: Record<string, any>;
			path: string;
		}> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const body = (await request.json()) as Record<string, any>;
					calls.push({
						authorization: request.headers.get("authorization"),
						body,
						path: new URL(request.url).pathname,
					});
					const handshake = emdashMcpHandshake(body);
					if (handshake) return handshake;
					if (body.params?.name === "media_upload") {
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								content: [
									{
										type: "text",
										text: JSON.stringify({
											item: {
												id: "media_1",
												filename: "cover.png",
												storageKey: "01J.png",
												url: "/_emdash/api/media/file/01J.png",
											},
										}),
									},
								],
							},
						});
					}
					throw new Error(`unexpected MCP method ${body.params?.name}`);
				},
			} as Fetcher,
		};

		const result = await mediaUpload(ctx, {
			filename: "cover.png",
			mimeType: "image/png",
			dataBase64: btoa("png"),
			alt: "Cover",
		});

		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
			success: true,
			data: {
				item: {
					id: "media_1",
					filename: "cover.png",
					storageKey: "01J.png",
					url: "/_emdash/api/media/file/01J.png",
				},
			},
		});
		expect(calls.map((call) => call.body.method)).toEqual([
			...EMDASH_HANDSHAKE,
			"tools/call",
		]);
		expect(calls.every((call) => call.path === "/_emdash/api/mcp")).toBe(true);
		expect(
			calls.every((call) => call.authorization === "Bearer ec_pat_secret"),
		).toBe(true);
		expect(calls[3]?.body).toMatchObject({
			method: "tools/call",
			params: {
				name: "media_upload",
				arguments: {
					filename: "cover.png",
					base64: btoa("png"),
					contentType: "image/png",
					alt: "Cover",
				},
			},
		});
	});

	it("updates stale alt and caption after native content-hash deduplication", async () => {
		const toolCalls: Array<Record<string, any>> = [];
		let storedItem: Record<string, unknown> = {
			id: "existing",
			alt: null,
			caption: null,
		};
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const body = (await request.json()) as Record<string, any>;
					const handshake = emdashMcpHandshake(body);
					if (handshake) return handshake;
					toolCalls.push(body);
					const data =
						body.params?.name === "media_upload"
							? {
									item: storedItem,
									deduplicated: true,
								}
							: {
									item: (storedItem = {
										...storedItem,
										...body.params.arguments,
									}),
								};
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							content: [{ type: "text", text: JSON.stringify(data) }],
						},
					});
				},
			} as Fetcher,
		};

		const result = await mediaUpload(ctx, {
			filename: "cover.png",
			mimeType: "image/png",
			dataBase64: btoa("png"),
			alt: "Cover",
			caption: "Credit",
		});

		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
			success: true,
			data: {
				item: { id: "existing", alt: "Cover", caption: "Credit" },
				deduplicated: true,
			},
		});
		expect(toolCalls.map((call) => call.params?.name)).toEqual([
			"media_upload",
			"media_update",
		]);
		expect(toolCalls[1]?.params?.arguments).toEqual({
			id: "existing",
			alt: "Cover",
			caption: "Credit",
		});

		const repeated = await mediaUpload(ctx, {
			filename: "cover.png",
			mimeType: "image/png",
			dataBase64: btoa("png"),
			alt: "Cover",
			caption: "Credit",
		});
		expect(repeated.isError).toBeUndefined();
		expect(toolCalls.map((call) => call.params?.name)).toEqual([
			"media_upload",
			"media_update",
			"media_upload",
		]);
	});

	it("reports a deduplicated alt update denied by upstream ownership rules", async () => {
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const body = (await request.json()) as Record<string, any>;
					const handshake = emdashMcpHandshake(body);
					if (handshake) return handshake;
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result:
							body.params?.name === "media_upload"
								? {
										content: [
											{
												type: "text",
												text: JSON.stringify({
													item: { id: "existing", alt: null },
													deduplicated: true,
												}),
											},
										],
									}
								: {
										content: [{ type: "text", text: "[FORBIDDEN] Not owner" }],
										isError: true,
									},
					});
				},
			} as Fetcher,
		};

		const result = await mediaUpload(ctx, {
			filename: "cover.png",
			mimeType: "image/png",
			dataBase64: btoa("png"),
			alt: "Cover",
		});

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("CMS_PARTIAL_FAILURE");
		expect(result.content[0]?.text).toContain("metadata update failed");
	});

	it("preserves caption on native base64 uploads through media_update", async () => {
		const toolCalls: Array<Record<string, any>> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const body = (await request.json()) as Record<string, any>;
					const handshake = emdashMcpHandshake(body);
					if (handshake) return handshake;
					toolCalls.push(body);
					const data =
						body.params?.name === "media_upload"
							? { item: { id: "media_url", filename: "remote.png" } }
							: { item: { id: "media_url", caption: "Remote caption" } };
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							content: [{ type: "text", text: JSON.stringify(data) }],
						},
					});
				},
			} as Fetcher,
		};

		const result = await mediaUpload(ctx, {
			filename: "remote.png",
			mimeType: "image/png",
			dataBase64: btoa("png"),
			caption: "Remote caption",
		});

		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
			success: true,
			data: { item: { id: "media_url", caption: "Remote caption" } },
		});
		expect(
			toolCalls.map((call) => {
				const { _meta: _requestMeta, ...params } = call.params;
				return params;
			}),
		).toEqual([
			{
				name: "media_upload",
				arguments: {
					filename: "remote.png",
					base64: btoa("png"),
					contentType: "image/png",
				},
			},
			{
				name: "media_update",
				arguments: { id: "media_url", caption: "Remote caption" },
			},
		]);
	});

	it("falls back to the multipart REST route without a PAT and persists alt via media_update", async () => {
		const calls: Array<{
			contentType: string | null;
			filename: string | undefined;
			internalAuth: string | null;
			method: string;
			mimeType: string | undefined;
			path: string;
			text: string | undefined;
			updateBody: Record<string, unknown> | undefined;
		}> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					if (request.method === "PUT") {
						const updateBody = (await request.json()) as Record<
							string,
							unknown
						>;
						calls.push({
							contentType: request.headers.get("content-type"),
							filename: undefined,
							internalAuth: request.headers.get("x-tedix-cms-internal-auth"),
							method: request.method,
							mimeType: undefined,
							path: new URL(request.url).pathname,
							text: undefined,
							updateBody,
						});
						return Response.json({
							success: true,
							data: {
								item: { id: "media_1", filename: "cover.png", alt: "Cover" },
							},
						});
					}
					const body = await request.formData();
					const file = body.get("file");
					calls.push({
						contentType: request.headers.get("content-type"),
						filename: file instanceof File ? file.name : undefined,
						internalAuth: request.headers.get("x-tedix-cms-internal-auth"),
						method: request.method,
						mimeType: file instanceof File ? file.type : undefined,
						path: new URL(request.url).pathname,
						text: file instanceof File ? await file.text() : undefined,
						updateBody: undefined,
					});
					return Response.json({
						success: true,
						data: { item: { id: "media_1", filename: "cover.png" } },
					});
				},
			} as Fetcher,
		};

		const result = await mediaUpload(ctx, {
			filename: "cover.png",
			mimeType: "image/png",
			dataBase64: btoa("png"),
			alt: "Cover",
		});

		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
			success: true,
			data: { item: { id: "media_1", filename: "cover.png", alt: "Cover" } },
		});
		expect(calls).toEqual([
			{
				contentType: expect.stringContaining("multipart/form-data; boundary="),
				filename: "cover.png",
				internalAuth: "internal_secret",
				method: "POST",
				mimeType: "image/png",
				path: "/_emdash/api/media",
				text: "png",
				updateBody: undefined,
			},
			{
				contentType: "application/json",
				filename: undefined,
				internalAuth: "internal_secret",
				method: "PUT",
				mimeType: undefined,
				path: "/_emdash/api/media/media_1",
				text: undefined,
				updateBody: { alt: "Cover" },
			},
		]);
	});

	it("requires base64 bytes and a MIME type", async () => {
		const result = await mediaUpload(
			{ ...baseContext, internalAuthToken: "internal_secret" },
			{ filename: "cover.png", mimeType: "image/png" },
		);

		expect(result).toMatchObject({ isError: true });
		expect(result.content[0]?.text).toContain(
			"dataBase64 and mimeType are required",
		);
	});

	it("rejects invalid base64 before touching the tenant runtime", async () => {
		const result = await mediaUpload(
			{ ...baseContext, internalAuthToken: "internal_secret" },
			{
				filename: "cover.png",
				mimeType: "image/png",
				dataBase64: "%%%not-base64%%%",
			},
		);

		expect(result).toMatchObject({
			isError: true,
		});
		expect(result.content[0]?.text).toContain("not valid base64");
	});

	it("does not replay a rejected human media upload with internal authority", async () => {
		const authAttempts: string[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			forwardedAuth: "header.payload.signature",
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					authAttempts.push(
						request.headers.get("cookie") ??
							request.headers.get("x-tedix-cms-internal-auth") ??
							"missing",
					);
					if (authAttempts.length === 1) {
						return new Response("Authentication failed", { status: 401 });
					}
					return Response.json({
						success: true,
						data: { item: { id: "media_internal" } },
					});
				},
			} as Fetcher,
		};

		const result = await mediaUpload(ctx, {
			filename: "cover.png",
			mimeType: "image/png",
			dataBase64: btoa("png"),
		});

		expect(result.isError).toBe(true);
		expect(authAttempts).toEqual(["DS=header.payload.signature"]);
	});

	it("does not mask a non-auth upload failure with another identity", async () => {
		let attempts = 0;
		const ctx: CmsProxyContext = {
			...baseContext,
			forwardedAuth: "header.payload.signature",
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async () => {
					attempts += 1;
					return new Response("Unsupported media type", { status: 415 });
				},
			} as unknown as Fetcher,
		};

		const result = await mediaUpload(ctx, {
			filename: "cover.exe",
			mimeType: "application/octet-stream",
			dataBase64: btoa("binary"),
		});

		expect(attempts).toBe(1);
		expect(result).toMatchObject({ isError: true });
		expect(result.content[0]?.text).toContain("415, auth=jwt");
	});

	it("fails closed when no tenant MCP bearer credential exists", async () => {
		const result = await callTenantMcpTool(
			{
				...baseContext,
				forwardedAuth: "aaa.bbb.ccc",
				internalAuthToken: "internal_secret",
			},
			"media_upload",
			{ filename: "cover.png", base64: btoa("png"), contentType: "image/png" },
		);

		expect(result).toMatchObject({
			isError: true,
		});
		expect(result.content[0]?.text.startsWith("[UNAUTHORIZED]")).toBe(true);
		expect(result.content[0]?.text).toContain(
			"run cms_provision_service_key first",
		);
	});
});

describe("callSandboxFreeCmsProxyTool", () => {
	it("only handles read-only operator tools", async () => {
		await expect(
			callSandboxFreeCmsProxyTool(baseContext, "theme_read_file", {}),
		).resolves.toBeNull();
	});

	it("routes content_list without a sandbox context", async () => {
		const seen: string[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					seen.push(`${url.pathname}?${url.searchParams.toString()}`);
					return Response.json({
						data: {
							items: [
								{
									id: "post_1",
									slug: "hello",
									status: "published",
									data: { title: "Hello" },
								},
							],
						},
					});
				},
			} as Fetcher,
		};

		const result = await callSandboxFreeCmsProxyTool(ctx, "content_list", {
			collection: "posts",
			status: "published",
			limit: 1,
		});

		expect(result?.isError).toBeUndefined();
		expect(
			JSON.parse(result?.content[0]?.text ?? "{}").data.items[0],
		).toMatchObject({
			id: "post_1",
			status: "published",
		});
		expect(seen).toEqual([
			"/_emdash/api/content/posts?status=published&limit=1",
		]);
	});
});

describe("plugin REST proxy routes", () => {
	it("registers lifecycle and settings tools with their native output shapes", () => {
		const tools = new Map<
			string,
			{
				inputSchema?: { safeParse(value: unknown): { success: boolean } };
				outputSchema?: { safeParse(value: unknown): { success: boolean } };
				annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
			}
		>();
		registerCmsProxyTools(
			{
				registerTool: (name: string, definition: any) =>
					tools.set(name, definition),
			} as any,
			baseContext,
		);
		const maskedSettings = {
			success: true,
			data: {
				schema: { secretKey: { type: "secret", label: "Secret Key" } },
				values: {},
				secretsSet: { secretKey: true },
			},
		};
		expect(tools.get("plugin_settings_get")?.annotations?.readOnlyHint).toBe(
			true,
		);
		expect(
			tools.get("plugin_settings_update")?.annotations?.destructiveHint,
		).toBe(true);
		expect(tools.get("plugin_enable")?.annotations?.destructiveHint).toBe(true);
		expect(tools.get("plugin_disable")?.annotations?.destructiveHint).toBe(
			true,
		);
		expect(
			tools.get("plugin_settings_get")?.outputSchema?.safeParse(maskedSettings)
				.success,
		).toBe(true);
		expect(
			tools
				.get("plugin_settings_update")
				?.outputSchema?.safeParse(maskedSettings).success,
		).toBe(true);
		expect(
			tools
				.get("plugin_settings_update")
				?.inputSchema?.safeParse({ id: "forms", values: { secretKey: null } })
				.success,
		).toBe(true);
		expect(
			tools
				.get("plugin_settings_update")
				?.inputSchema?.safeParse({ id: "forms", secretKey: "oops" }).success,
		).toBe(false);
		expect(
			tools
				.get("byline_delete")
				?.outputSchema?.safeParse({ success: true, data: { deleted: true } })
				.success,
		).toBe(true);
	});

	it("returns schema-valid structured plugin inventory and honest registry status", async () => {
		type RegisteredTool = {
			outputSchema?: { safeParse(value: unknown): { success: boolean } };
			call: (args: Record<string, unknown>) => Promise<{
				content: Array<{ text: string }>;
				structuredContent?: unknown;
			}>;
		};
		const tools = new Map<string, RegisteredTool>();
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const path = new URL(request.url).pathname;
					if (path === "/_emdash/api/manifest")
						return Response.json({ data: { collections: [] } });
					if (path === "/_emdash/api/admin/plugins")
						return Response.json({
							data: {
								items: [
									{ id: "config:seo", source: "config", status: "active" },
									{
										id: "registry:example",
										source: "registry",
										status: "active",
									},
								],
							},
						});
					if (path === "/_emdash/api/admin/plugins/updates")
						return Response.json({ data: { items: [] } });
					throw new Error(`Unexpected CMS route: ${path}`);
				},
			} as Fetcher,
		};
		registerCmsProxyTools(
			{
				registerTool: (
					name: string,
					definition: RegisteredTool,
					call: RegisteredTool["call"],
				) => tools.set(name, { ...definition, call }),
			} as any,
			ctx,
		);

		const list = await tools.get("plugin_list")!.call({ source: "registry" });
		expect(list.structuredContent).toMatchObject({
			items: [{ id: "registry:example" }],
			summary: { total: 1, bySource: { registry: 1 } },
		});
		expect(JSON.parse(list.content[0]!.text)).toEqual(list.structuredContent);
		expect(
			tools.get("plugin_list")!.outputSchema!.safeParse(list.structuredContent)
				.success,
		).toBe(true);

		const status = await tools.get("registry_status")!.call({});
		expect(status.structuredContent).toMatchObject({
			registry: {
				installationState: "unverified",
				reason: expect.stringContaining("parent CMS runtime"),
			},
			plugins: { total: 2, registryInstalled: 1 },
		});
		expect(status.structuredContent).not.toHaveProperty(
			"registry.sandboxAvailable",
		);
		expect(JSON.parse(status.content[0]!.text)).toEqual(
			status.structuredContent,
		);
		expect(
			tools
				.get("registry_status")!
				.outputSchema!.safeParse(status.structuredContent).success,
		).toBe(true);
	});

	it("reports a failed plugin updates lookup without throwing", async () => {
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const path = new URL(request.url).pathname;
					if (path === "/_emdash/api/manifest")
						return Response.json({ data: { collections: [] } });
					if (path === "/_emdash/api/admin/plugins")
						return Response.json({ data: { items: [] } });
					if (path === "/_emdash/api/admin/plugins/updates")
						return Response.json(
							{ error: "UPDATES_UNAVAILABLE" },
							{ status: 503 },
						);
					throw new Error(`Unexpected CMS route: ${path}`);
				},
			} as Fetcher,
		};

		const result = await registryStatus(ctx);
		expect(result.isError).toBeUndefined();
		if (!("structuredContent" in result))
			throw new Error("registry_status omitted structured content");
		expect(result.structuredContent).toMatchObject({
			updates: {
				total: 0,
				items: [],
				warning: expect.stringContaining("UPDATES_UNAVAILABLE"),
			},
		});
		expect(JSON.parse(result.content[0]!.text!)).toEqual(
			result.structuredContent,
		);
	});

	it("summarizes Emdash 0.16 registry compatibility and artifact signals", () => {
		expect(
			pluginRegistrySignalSummary([
				{
					id: "registry:did/seo-helper",
					source: "registry",
					requires: { "env:emdash": ">=0.16.0" },
					artifacts: { icon: { url: "https://example.com/icon.png" } },
					sections: { security: "No network access." },
					sbom: { url: "https://example.com/sbom.json" },
					compatibility: { compatible: true },
				},
				{
					id: "registry:did/old-helper",
					source: "registry",
					envCompatibility: { ok: false, mismatches: ["env:astro"] },
				},
				{
					id: "config:local",
					source: "config",
					requires: { "env:emdash": ">=0.16.0" },
				},
			]),
		).toEqual({
			withRequires: 1,
			withArtifacts: 1,
			withProfileSections: 1,
			withSbom: 1,
			withCompatibilityWarnings: 1,
		});
	});

	it("calls the native Emdash plugin list endpoint", async () => {
		let requestedPath = "";
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					requestedPath = url.pathname;
					return Response.json({ data: { items: [] } });
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "plugin_list", {});

		expect(result.isError).toBeUndefined();
		expect(requestedPath).toBe("/_emdash/api/admin/plugins");
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
			data: { items: [] },
		});
	});

	it("encodes plugin IDs before calling plugin detail", async () => {
		let requestedPath = "";
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					requestedPath = url.pathname;
					return Response.json({
						data: {
							item: { id: "registry:publisher/plugin", status: "active" },
						},
					});
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "plugin_get", {
			id: "registry:publisher/plugin",
		});

		expect(result.isError).toBeUndefined();
		expect(requestedPath).toBe(
			"/_emdash/api/admin/plugins/registry%3Apublisher%2Fplugin",
		);
	});

	it("uses the official plugin lifecycle and settings routes with masked output", async () => {
		const seen: Array<{ method: string; path: string; body: unknown }> = [];
		const id = "registry:publisher/plugin";
		const encoded = "registry%3Apublisher%2Fplugin";
		const settings = {
			success: true,
			data: {
				schema: { siteKey: { type: "string" }, secretKey: { type: "secret" } },
				values: { siteKey: "public" },
				secretsSet: { secretKey: true },
			},
		};
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const path = new URL(request.url).pathname;
					seen.push({
						method: request.method,
						path,
						body: request.body ? await request.json() : undefined,
					});
					return Response.json(
						path.endsWith("/settings")
							? settings
							: {
									success: true,
									data: {
										item: {
											id,
											status: path.endsWith("/enable") ? "active" : "inactive",
										},
									},
								},
					);
				},
			} as Fetcher,
		};

		for (const name of [
			"plugin_enable",
			"plugin_disable",
			"plugin_settings_get",
			"plugin_settings_update",
		]) {
			const result = await callCmsRest(
				ctx,
				name,
				name === "plugin_settings_update"
					? { id, values: { siteKey: "public", secretKey: "write-only" } }
					: { id },
			);
			expect(result.isError, name).toBeUndefined();
			if (name.startsWith("plugin_settings")) {
				expect(JSON.stringify(result)).not.toContain("write-only");
				expect(JSON.parse(result.content[0]!.text)).toEqual(settings);
			}
		}
		expect(seen).toEqual([
			{
				method: "POST",
				path: `/_emdash/api/admin/plugins/${encoded}/enable`,
				body: undefined,
			},
			{
				method: "POST",
				path: `/_emdash/api/admin/plugins/${encoded}/disable`,
				body: undefined,
			},
			{
				method: "GET",
				path: `/_emdash/api/admin/plugins/${encoded}/settings`,
				body: undefined,
			},
			{
				method: "PUT",
				path: `/_emdash/api/admin/plugins/${encoded}/settings`,
				body: { values: { siteKey: "public", secretKey: "write-only" } },
			},
		]);
	});

	it("preserves human permission denial for plugin management", async () => {
		const seen: Array<{
			cookie: string | null;
			authorization: string | null;
			internal: string | null;
		}> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			forwardedAuth: "aaa.bbb.ccc",
			serviceApiKey: "ec_pat_secret",
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					seen.push({
						cookie: request.headers.get("cookie"),
						authorization: request.headers.get("authorization"),
						internal: request.headers.get("x-tedix-cms-internal-auth"),
					});
					return Response.json(
						{ error: { code: "FORBIDDEN" } },
						{ status: 403 },
					);
				},
			} as Fetcher,
		};
		for (const name of [
			"plugin_enable",
			"plugin_disable",
			"plugin_settings_get",
			"plugin_settings_update",
		]) {
			const result = await callCmsRest(
				ctx,
				name,
				name === "plugin_settings_update"
					? { id: "forms", values: {} }
					: { id: "forms" },
			);
			expect(result.isError, name).toBe(true);
			expect(result.content[0]?.text).toContain("403");
		}
		expect(seen).toEqual(
			Array.from({ length: 4 }, () => ({
				cookie: "DS=aaa.bbb.ccc",
				authorization: null,
				internal: null,
			})),
		);
	});

	it("verifies a signed registry release without installing it", async () => {
		let requestedPath = "";
		let requestedBody: unknown;
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					requestedPath = new URL(request.url).pathname;
					requestedBody = await request.json();
					return Response.json({
						data: {
							verification: { profileCid: "profile", releaseCid: "release" },
						},
					});
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "plugin_verify", {
			did: "did:plc:publisher",
			slug: "seo-helper",
			version: "1.2.3",
		});

		expect(result.isError).toBeUndefined();
		expect(requestedPath).toBe("/_emdash/api/admin/plugins/registry/verify");
		expect(requestedBody).toEqual({
			did: "did:plc:publisher",
			slug: "seo-helper",
			version: "1.2.3",
		});
	});

	it("forwards all native Emdash registry consent fields on install", async () => {
		let requestedPath = "";
		let requestedBody: unknown;
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					requestedPath = url.pathname;
					requestedBody = await request.json();
					return Response.json({ data: { id: "registry:did/plugin" } });
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "plugin_install", {
			did: "did:plc:publisher",
			slug: "seo-helper",
			version: "1.2.3",
			acknowledgedDeclaredAccess: { capabilities: ["routes"] },
			acknowledgedMcpTools: [],
			acknowledgedPublicRoutes: ["/contact"],
			acknowledgedProfileCid: "profile",
			acknowledgedReleaseCid: "release",
		});

		expect(result.isError).toBeUndefined();
		expect(requestedPath).toBe("/_emdash/api/admin/plugins/registry/install");
		expect(requestedBody).toEqual({
			did: "did:plc:publisher",
			slug: "seo-helper",
			version: "1.2.3",
			acknowledgedDeclaredAccess: { capabilities: ["routes"] },
			acknowledgedMcpTools: [],
			acknowledgedPublicRoutes: ["/contact"],
			acknowledgedProfileCid: "profile",
			acknowledgedReleaseCid: "release",
		});
	});

	it("routes registry plugin lifecycle calls through registry endpoints", async () => {
		const seen: Array<{ path: string; body: unknown }> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					seen.push({ path: url.pathname, body: await request.json() });
					return Response.json({ data: { ok: true } });
				},
			} as Fetcher,
		};

		await callCmsRest(ctx, "plugin_update", {
			id: "registry:did/plugin",
			confirmCapabilityChanges: true,
		});
		await callCmsRest(ctx, "plugin_uninstall", {
			id: "registry:did/plugin",
			source: "registry",
			deleteData: false,
		});

		expect(seen).toEqual([
			{
				path: "/_emdash/api/admin/plugins/registry/registry%3Adid%2Fplugin/update",
				body: {
					confirmCapabilityChanges: true,
				},
			},
			{
				path: "/_emdash/api/admin/plugins/registry/registry%3Adid%2Fplugin/uninstall",
				body: {
					deleteData: false,
				},
			},
		]);
	});
});

describe("get_site_overview", () => {
	it("shows the authenticated site's bundle source and independent live CSS revision", async () => {
		const boundSlugs: string[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			db: {
				prepare(sql: string) {
					return {
						bind(slug: string) {
							boundSlugs.push(slug);
							return {
								first: async () => ({
									templateSlug: "marketing",
									publicUrl: "https://tedix.dev/apps/insights/",
								}),
								all: async () => ({
									results: [
										{
											version: 12,
											isActive: 1,
											sourceRevision: `artifacts-commit:${"a".repeat(40)}`,
										},
									],
								}),
							};
						},
					};
				},
			} as unknown as D1Database,
			bundlesBucket: {
				get: async (key: string) => {
					expect(key).toBe("hot-themes/tedix/manifest.json");
					return {
						json: async () => ({ orgSlug: "tedix", revision: "css-42" }),
					};
				},
			} as unknown as R2Bucket,
			cmsDispatch: {
				fetch: async (request: Request) =>
					Response.json({
						data: new URL(request.url).pathname.endsWith("/schema/collections")
							? { items: [] }
							: {},
					}),
			} as Fetcher,
		};
		const result = await getCmsSiteOverview(ctx, {
			includeMenus: false,
			includeTaxonomies: false,
			includePlugins: false,
		});
		const payload = JSON.parse(result.content[0]?.text ?? "{}");
		expect(boundSlugs).toEqual(["tedix", "tedix"]);
		expect(payload.site).toEqual({
			templateSlug: "marketing",
			publicUrl: "https://tedix.dev/apps/insights/",
			activeBundleVersion: 12,
			sourceRevision: { kind: "artifacts_commit", value: "a".repeat(40) },
			hotCssRevision: "css-42",
		});
		expect(result.content[0]?.text).not.toContain("internal_secret");
		const withoutCss = await getCmsSiteOverview(
			{
				...ctx,
				bundlesBucket: {
					get: async () => null,
				} as unknown as R2Bucket,
			},
			{ includeMenus: false, includeTaxonomies: false, includePlugins: false },
		);
		expect(JSON.parse(withoutCss.content[0]?.text ?? "{}").site).toMatchObject({
			activeBundleVersion: 12,
			hotCssRevision: null,
		});
	});

	it.each(["fields", "empty", "failed", "omitted"])(
		"handles %s collection schemas without inventing empty fields",
		async (mode) => {
			const schemaRequests: string[] = [];
			const ctx: CmsProxyContext = {
				...baseContext,
				internalAuthToken: "internal_secret",
				cmsDispatch: {
					fetch: async (request: Request) => {
						const url = new URL(request.url);
						if (url.pathname.endsWith("/schema/collections"))
							return Response.json({ data: { items: [{ slug: "posts" }] } });
						if (url.pathname.endsWith("/schema/collections/posts")) {
							schemaRequests.push(url.searchParams.get("includeFields") ?? "");
							if (mode === "failed")
								return new Response("schema unavailable", { status: 503 });
							return Response.json({
								data: {
									item: {
										slug: "posts",
										fields:
											mode === "empty"
												? []
												: [
														{ slug: "title", type: "string", required: true },
														{ slug: "content", type: "portableText" },
													],
									},
								},
							});
						}
						return Response.json({ data: {} });
					},
				} as Fetcher,
			};
			const result = await getCmsSiteOverview(ctx, {
				includeMenus: false,
				includeTaxonomies: false,
				includePlugins: false,
				maxFieldsPerCollection: mode === "omitted" ? 0 : 1,
			});
			type OutputSchema = {
				safeParse(value: unknown): {
					success: boolean;
					error?: { issues: unknown[] };
				};
			};
			const tools = new Map<string, { outputSchema?: OutputSchema }>();
			const server = {
				registerTool: (
					name: string,
					definition: { outputSchema?: OutputSchema },
				) => tools.set(name, definition),
			};
			registerCmsProxyTools(server as any, ctx);
			const schemaResult = tools
				.get("get_site_overview")
				?.outputSchema?.safeParse(
					(result as typeof result & { structuredContent?: unknown })
						.structuredContent,
				);
			expect(
				schemaResult?.success,
				JSON.stringify(schemaResult?.error?.issues),
			).toBe(true);
			const payload = JSON.parse(result.content[0]?.text ?? "{}");
			expect(schemaRequests).toEqual(mode === "omitted" ? [] : ["true"]);
			expect(payload.collections[0].fieldCount).toBe(
				mode === "fields" ? 2 : mode === "empty" ? 0 : null,
			);
			expect(payload.collections[0].fields).toEqual(
				mode === "fields"
					? [{ slug: "title", type: "string", required: true }]
					: mode === "empty"
						? []
						: null,
			);
			if (mode === "failed")
				expect(payload.errors.schemas.posts).toContain("schema unavailable");
			else expect(payload.errors).toEqual({});
		},
	);
	it("aggregates operator context without exposing auth secrets", async () => {
		const seen: Array<{ method: string; path: string; query: string }> = [];
		const mcpCalls: Array<{
			name: string;
			arguments: Record<string, unknown>;
		}> = [];
		// With a provisioned PAT and no forwarded human JWT, mapped reads ride
		// the native tenant MCP transport; unmapped rows (plugins) stay REST.
		const nativePayloads: Record<string, unknown> = {
			schema_list_block_types: { items: [] },
			schema_list_collections: {
				items: [
					{
						slug: "posts",
						label: "Posts",
						hasSeo: true,
						urlPattern: "/posts/{slug}",
						fields: [
							{
								slug: "title",
								label: "Title",
								type: "string",
								required: true,
								searchable: true,
							},
						],
					},
				],
			},
			settings_get: {
				title: "Tedix Blog",
				tagline: "Agent-ready CMS",
				social: { linkedin: "https://example.com/tedix" },
			},
			menu_list: {
				items: [
					{
						name: "primary",
						label: "Primary",
						locale: "de",
						items: [{ label: "Home", type: "custom", customUrl: "/" }],
					},
				],
			},
			taxonomy_list: {
				taxonomies: [
					{ name: "category", label: "Categories", hierarchical: true },
				],
			},
			content_list: {
				items: [
					{
						id: "post_1",
						slug: "hello",
						status: "draft",
						locale: "de",
						data: { title: "Hallo" },
					},
				],
			},
		};
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					if (url.pathname === "/_emdash/api/mcp") {
						const body = (await request.json()) as Record<string, any>;
						const handshake = emdashMcpHandshake(body);
						if (handshake) return handshake;
						if (body.method === "tools/list")
							return Response.json({
								jsonrpc: "2.0",
								id: body.id,
								result: {
									tools: [
										{
											name: "content_get",
											inputSchema: { type: "object" },
											annotations: { readOnlyHint: true },
										},
									],
								},
							});
						mcpCalls.push({
							name: body.params?.name,
							arguments: body.params?.arguments ?? {},
						});
						const data = nativePayloads[body.params?.name];
						if (!data) {
							throw new Error(`unexpected native tool ${body.params?.name}`);
						}
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								content: [
									{
										type: "text",
										text: JSON.stringify(data),
									},
								],
							},
						});
					}

					seen.push({
						method: request.method,
						path: url.pathname,
						query: url.searchParams.toString(),
					});
					if (url.pathname === "/_emdash/api/admin/plugins") {
						return Response.json({
							data: {
								items: [
									{
										id: "tedix-seo-aeo",
										source: "config",
										status: "active",
									},
								],
							},
						});
					}

					return new Response("not found", { status: 404 });
				},
			} as Fetcher,
		};

		const result = await getCmsSiteOverview(ctx, {
			locale: "de",
			includeRecentContent: true,
			recentLimit: 3,
		});

		expect(result.isError).toBeUndefined();
		const payload = JSON.parse(result.content[0]?.text ?? "{}");
		const structuredContent = (
			result as typeof result & { structuredContent?: unknown }
		).structuredContent;
		expect(structuredContent).toEqual(payload);
		expect(payload.orgSlug).toBe("tedix");
		expect(payload.authModes).toEqual(["pat", "internal"]);
		expect(payload.settings.title).toBe("Tedix Blog");
		expect(payload.collections[0]).toMatchObject({
			slug: "posts",
			fieldCount: 1,
		});
		expect(payload.menus[0]).toMatchObject({
			name: "primary",
			itemCount: 1,
		});
		expect(payload.taxonomies[0]).toMatchObject({ name: "category" });
		expect(payload.plugins.total).toBe(1);
		expect(payload.databaseRuntime).toMatchObject({
			emdashDurableObjects: "source_configured",
			currentBackend: "durableObjects",
			durableObjectsStatus: "not_inspected",
		});
		expect(payload.mediaRuntime).toMatchObject({
			emdashResponsiveMedia: "source_supported",
			imageService: "unverified",
			responsiveSrcsetStatus: "unverified",
			activeBundleInspection: "not_performed",
		});
		expect(payload.operatorHints).toContain(
			"Run cms:database-architecture:validate after CMS runtime or Emdash adapter changes; durableObjects() is live only when the template, Worker Loader env, EmDashDB binding, and migrations all validate together.",
		);
		expect(payload.operatorHints).toContain(
			"Run cms:responsive-media:validate for the source path, then inspect the active bundle and live image responses before claiming responsive srcsets for this tenant.",
		);
		expect(payload.recentContent.posts[0]).toMatchObject({
			id: "post_1",
			title: "Hallo",
		});
		expect(result.content[0]?.text).not.toContain("ec_pat_secret");
		expect(result.content[0]?.text).not.toContain("internal_secret");
		expect(JSON.stringify(structuredContent)).not.toContain("ec_pat_secret");
		expect(JSON.stringify(structuredContent)).not.toContain("internal_secret");
		// Unmapped plugin listing is the only REST call; mapped reads went native.
		expect(seen).toEqual([
			{ method: "GET", path: "/_emdash/api/admin/plugins", query: "" },
		]);
		expect(mcpCalls).toEqual(
			expect.arrayContaining([
				{ name: "schema_list_collections", arguments: {} },
				{ name: "settings_get", arguments: {} },
				{ name: "menu_list", arguments: { locale: "de" } },
				{ name: "taxonomy_list", arguments: {} },
				{
					name: "content_list",
					arguments: {
						collection: "posts",
						limit: 3,
						orderBy: "updatedAt",
						order: "desc",
						locale: "de",
					},
				},
			]),
		);
		expect(mcpCalls).toHaveLength(6);
		expect(payload.capabilities.nativeTools.status).toBe("observed");
		expect(payload.capabilities.blockSchema.status).toBe("observed");
	});

	it("advertises get_site_overview as read-only", () => {
		const tools = new Map<
			string,
			{ annotations?: { readOnlyHint?: boolean }; outputSchema?: unknown }
		>();
		const server = {
			registerTool: (
				name: string,
				definition: {
					annotations?: { readOnlyHint?: boolean };
					outputSchema?: unknown;
				},
			) => {
				tools.set(name, definition);
			},
		};

		registerCmsProxyTools(server as any, baseContext);

		expect(tools.get("get_site_overview")?.annotations?.readOnlyHint).toBe(
			true,
		);
		expect(tools.get("get_site_overview")?.outputSchema).toBeDefined();
	});

	it("accepts Emdash's nested data.item envelope for content_get", () => {
		type OutputSchema = {
			safeParse(value: unknown): { success: boolean };
		};
		const tools = new Map<string, { outputSchema?: OutputSchema }>();
		const server = {
			registerTool: (
				name: string,
				definition: { outputSchema?: OutputSchema },
			) => tools.set(name, definition),
		};

		registerCmsProxyTools(server as any, baseContext);

		const result = tools.get("content_get")?.outputSchema?.safeParse({
			success: true,
			data: {
				item: {
					id: "01KS7SG49CZ5JW4TKA07MR6VFX",
					slug: "gdpr-ai-automation",
					status: "draft",
				},
				_rev: "revision-token",
			},
		});
		expect(result?.success).toBe(true);
	});

	it("exposes bounded signed draft previews through the tenant REST route", async () => {
		const tools = new Map<
			string,
			{
				inputSchema: { safeParse(value: unknown): { success: boolean } };
				outputSchema?: { safeParse(value: unknown): { success: boolean } };
				annotations?: { readOnlyHint?: boolean };
			}
		>();
		registerCmsProxyTools(
			{
				registerTool: (name: string, definition: any) =>
					tools.set(name, definition),
			} as any,
			baseContext,
		);
		const preview = tools.get("content_preview_url");
		expect(preview?.annotations?.readOnlyHint).not.toBe(true);
		expect(
			preview?.inputSchema.safeParse({
				collection: "pages",
				id: "home",
				expiresIn: "1h",
				pathPattern: "/de/",
			}).success,
		).toBe(true);
		expect(
			preview?.inputSchema.safeParse({
				collection: "pages",
				id: "home",
				expiresIn: "100w",
				pathPattern: "https://outside.example/",
			}).success,
		).toBe(false);

		for (const pathPattern of [
			undefined,
			"/posts/{id}",
			"/{locale}/{collection}/{id}",
			"/posts/concrete-slug",
		]) {
			expect(
				preview?.inputSchema.safeParse({
					collection: "posts",
					id: "entry-id",
					pathPattern,
				}).success,
			).toBe(true);
		}
		for (const pathPattern of [
			"/posts/{slug}",
			"/{year}/{slug}",
			"/posts/{id",
			"/posts/id}",
		]) {
			expect(
				preview?.inputSchema.safeParse({
					collection: "posts",
					id: "entry-id",
					pathPattern,
				}).success,
			).toBe(false);
		}

		const seen: Array<{
			method: string;
			path: string;
			auth: string | null;
			body: unknown;
		}> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					seen.push({
						method: request.method,
						path: new URL(request.url).pathname,
						auth: request.headers.get("x-tedix-cms-internal-auth"),
						body: await request.json(),
					});
					return Response.json({
						success: true,
						data: {
							url: "/de/?_preview=token",
							expiresAt: 2_000_000_000,
						},
					});
				},
			} as Fetcher,
		};
		const result = await callCmsRest(ctx, "content_preview_url", {
			collection: "pages",
			id: "home",
			expiresIn: "1h",
			pathPattern: "/de/",
		});
		expect(result.isError).toBeUndefined();
		expect(seen).toEqual([
			{
				method: "POST",
				path: "/_emdash/api/content/pages/home/preview-url",
				auth: "internal_secret",
				body: { expiresIn: "1h", pathPattern: "/de/" },
			},
		]);
		expect(
			preview?.outputSchema?.safeParse(
				(result as { structuredContent?: unknown }).structuredContent,
			).success,
		).toBe(true);
	});

	it("advertises the canonical content_create output schema", () => {
		type OutputSchema = {
			safeParse(value: unknown): { success: boolean };
		};
		const tools = new Map<string, { outputSchema?: OutputSchema }>();
		const server = {
			registerTool: (
				name: string,
				definition: { outputSchema?: OutputSchema },
			) => tools.set(name, definition),
		};

		registerCmsProxyTools(server as any, baseContext);

		const outputSchema = tools.get("content_create")?.outputSchema;
		const result = outputSchema?.safeParse({
			id: "post_1",
			data: { id: "post_1", slug: null, status: "draft" },
			item: { id: "post_1", slug: null, status: "draft" },
			_rev: "rev_2",
		});
		expect(result?.success).toBe(true);
		expect(
			outputSchema?.safeParse({
				data: { id: "post_1" },
				item: { id: "post_1" },
			}).success,
		).toBe(false);
	});

	it("preserves the native content_get envelope without aliases", async () => {
		const ctx: CmsProxyContext = {
			...baseContext,
			// Internal auth (not a PAT) keeps this on the REST transport whose
			// envelope normalization this test covers.
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async () =>
					Response.json({
						data: {
							item: {
								id: "01KS7SG49CZ5JW4TKA07MR6VFX",
								slug: "gdpr-ai-automation",
								status: "draft",
							},
							_rev: "revision-token",
						},
					}),
			} as unknown as Fetcher,
		};

		const result = await callCmsRest(ctx, "content_get", {
			collection: "posts",
			id: "01KS7SG49CZ5JW4TKA07MR6VFX",
		});
		const structuredContent = (
			result as { structuredContent?: Record<string, unknown> }
		).structuredContent;

		expect(structuredContent).toMatchObject({
			data: {
				item: {
					id: "01KS7SG49CZ5JW4TKA07MR6VFX",
					slug: "gdpr-ai-automation",
					status: "draft",
				},
				_rev: "revision-token",
			},
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining('"item"'),
		});
	});
});

describe("native Emdash search REST proxy routes", () => {
	it("does not switch to the service PAT after a human read fails", async () => {
		const seenAuth: string[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			forwardedAuth: "aaa.bbb.ccc",
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					seenAuth.push(
						request.headers.get("Authorization") ??
							request.headers.get("Cookie") ??
							"",
					);
					if (!request.headers.has("Authorization")) {
						return new Response("", { status: 500 });
					}
					return Response.json({ data: { items: [] } });
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "content_list", {
			collection: "posts",
			limit: 1,
		});

		expect(result.isError).toBe(true);
		expect(seenAuth).toEqual(["DS=aaa.bbb.ccc"]);
	});

	it("does not replay a failed human write with internal authority", async () => {
		const seenAuth: string[] = [];
		let requestedBody: unknown;
		const ctx: CmsProxyContext = {
			...baseContext,
			forwardedAuth: "aaa.bbb.ccc",
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					seenAuth.push(
						request.headers.get("X-Tedix-CMS-Internal-Auth") ??
							request.headers.get("Cookie") ??
							"",
					);
					requestedBody = await request.json();
					if (request.headers.has("Cookie")) {
						throw new Error("simulated forwarded JWT write timeout");
					}
					return Response.json({ data: { id: "item_1" } });
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "content_create", {
			collection: "posts",
			slug: "smoke",
			status: "draft",
			locale: "en",
			data: { title: "Smoke" },
			references: { related_posts: ["post_2"] },
		});

		expect(result.isError).toBe(true);
		expect(seenAuth).toEqual(["DS=aaa.bbb.ccc"]);
		expect(requestedBody).toEqual({
			data: { title: "Smoke" },
			locale: "en",
			slug: "smoke",
			status: "draft",
			translationOf: undefined,
			references: { related_posts: ["post_2"] },
		});
		expect(
			(result as { structuredContent?: unknown }).structuredContent,
		).toBeUndefined();
	});

	it("surfaces a successful create without an id as ambiguous", async () => {
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async () => Response.json({ success: true, data: {} }),
			} as unknown as Fetcher,
		};

		const result = await callCmsRest(ctx, "content_create", {
			collection: "posts",
			slug: "ambiguous-draft",
			locale: "en",
			data: { title: "Ambiguous draft" },
		});

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain(
			"returned no canonical content id",
		);
		expect(result.content[0]?.text).toContain("reconcile the requested slug");
	});

	it("preserves versioned native blocks in a large create request", async () => {
		const requests: Array<{ method: string; body: unknown }> = [];
		const hero = {
			_type: "marketing_hero",
			_version: 2,
			_key: "proof-hero",
			headline: "Native blocks keep their required fields",
			image: {
				id: "media-proof",
				provider: "local",
				filename: "proof.png",
				mimeType: "image/png",
				alt: "Proof image",
			},
		};
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					requests.push({ method: request.method, body: await request.json() });
					return Response.json({
						success: true,
						data: { item: { id: "page_1", slug: "proof", status: "draft" } },
					});
				},
			} as Fetcher,
		};

		const { _version: _activeVersion, ...heroUsingActiveVersion } = hero;
		for (const block of [hero, heroUsingActiveVersion]) {
			const result = await callCmsRest(ctx, "content_create", {
				collection: "pages",
				slug: "proof",
				locale: "fr",
				data: { title: "Preuve de page native", content: [block] },
			});
			expect(result.isError).toBeUndefined();
		}
		expect(requests).toHaveLength(2);
		expect(requests).toEqual([
			{
				method: "POST",
				body: expect.objectContaining({
					data: { title: "Preuve de page native", content: [hero] },
				}),
			},
			{
				method: "POST",
				body: expect.objectContaining({
					data: {
						title: "Preuve de page native",
						content: [heroUsingActiveVersion],
					},
				}),
			},
		]);
	});

	it("creates full rich content and media in one native request with canonical response", async () => {
		const requests: Array<{
			method: string;
			path: string;
			body: Record<string, unknown>;
		}> = [];
		const content = [
			{
				_type: "block",
				_key: "paragraph",
				children: [{ _type: "span", text: "A".repeat(240), marks: [] }],
				markDefs: [],
				style: "normal",
			},
		];
		const image = {
			id: "media-required",
			provider: "local",
			alt: "Native image",
		};
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const body = (await request.json()) as Record<string, unknown>;
					const path = new URL(request.url).pathname;
					requests.push({ method: request.method, path, body });
					if (request.method === "POST") {
						return Response.json({
							success: true,
							data: {
								item: {
									id: "post_1",
									slug: "large-draft",
									status: "draft",
								},
								_rev: "rev_1",
							},
						});
					}
					return Response.json({
						success: true,
						data: { id: "post_1", _rev: "rev_2" },
					});
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "content_create", {
			collection: "posts",
			slug: "large-draft",
			status: "draft",
			data: { title: "Large draft", content, image },
			references: { related_posts: ["post_2"] },
		});

		expect(result.isError).toBeUndefined();
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			method: "POST",
			path: "/_emdash/api/content/posts",
			body: {
				slug: "large-draft",
				status: "draft",
				references: { related_posts: ["post_2"] },
				data: { title: "Large draft", content, image },
			},
		});
		const structuredContent = (
			result as { structuredContent?: Record<string, unknown> }
		).structuredContent;
		expect(structuredContent).toMatchObject({
			success: true,
			id: "post_1",
			data: {
				id: "post_1",
				slug: "large-draft",
				data: { title: "Large draft", content, image },
			},
			item: { id: "post_1", slug: "large-draft" },
			_rev: "rev_1",
		});
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(
			structuredContent,
		);
	});

	it("returns a native create failure without update or deletion", async () => {
		const methods: string[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					methods.push(request.method);
					return Response.json(
						{
							success: false,
							error: { code: "VALIDATION_ERROR", message: "Invalid image" },
						},
						{ status: 400 },
					);
				},
			} as Fetcher,
		};
		const result = await callCmsRest(ctx, "content_create", {
			collection: "posts",
			data: { title: "Long title".repeat(40), image: {} },
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("VALIDATION_ERROR");
		expect(methods).toEqual(["POST"]);
	});

	it("requests collection field definitions", async () => {
		let requestedUrl = "";
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					requestedUrl = request.url;
					return Response.json({
						success: true,
						data: { id: "posts", slug: "posts", fields: [] },
					});
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "schema_get_collection", {
			slug: "posts",
		});

		expect(result.isError).toBeUndefined();
		const url = new URL(requestedUrl);
		expect(url.pathname).toBe("/_emdash/api/schema/collections/posts");
		expect(url.searchParams.get("includeFields")).toBe("true");
	});

	it("passes content_list q through to the native content endpoint", async () => {
		let requestedPath = "";
		let requestedQuery = "";
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					requestedPath = url.pathname;
					requestedQuery = url.searchParams.toString();
					return Response.json({ data: { items: [] } });
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "content_list", {
			collection: "posts",
			q: "vorsorgevollmacht",
			status: "published",
			locale: "de",
			limit: 12,
			authorId: "user_author",
			dateField: "publishedAt",
			dateFrom: "2026-06-01",
			dateTo: "2026-06-30T23:59:59Z",
		});

		expect(result.isError).toBeUndefined();
		expect(requestedPath).toBe("/_emdash/api/content/posts");
		expect(requestedQuery).toBe(
			"q=vorsorgevollmacht&status=published&limit=12&locale=de&authorId=user_author&dateField=publishedAt&dateFrom=2026-06-01&dateTo=2026-06-30T23%3A59%3A59Z",
		);
	});

	it("routes list_content_authors to the native collection authors endpoint", async () => {
		let requestedPath = "";
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					requestedPath = url.pathname;
					return Response.json({
						data: {
							items: [
								{
									id: "user_author",
									name: "Author",
									email: "author@example.com",
									avatarUrl: null,
								},
							],
						},
					});
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "list_content_authors", {
			collection: "posts",
		});

		expect(result.isError).toBeUndefined();
		expect(requestedPath).toBe("/_emdash/api/content/posts/authors");
	});

	it("falls back to content_list author IDs when native authors endpoint is not initialized", async () => {
		const requestedPaths: string[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					requestedPaths.push(`${url.pathname}?${url.searchParams.toString()}`);
					if (url.pathname.endsWith("/authors")) {
						return Response.json(
							{
								error: {
									code: "NOT_CONFIGURED",
									message: "EmDash is not initialized",
								},
							},
							{ status: 500 },
						);
					}
					return Response.json({
						data: {
							items: [
								{
									id: "post_1",
									authorId: "user_author",
									bylines: [
										{
											byline: {
												id: "byline_jordan",
												displayName: "Jordan",
												email: "jordan@example.com",
												avatarStorageKey: "authors/jordan.png",
											},
										},
									],
								},
								{
									id: "post_2",
									authorId: "user_author",
									bylines: [{ byline: { displayName: "Ignored duplicate" } }],
								},
								{
									id: "post_3",
									authorId: "user_editor",
									byline: {
										id: "byline_editor",
										displayName: "Editor",
										avatarMediaId: "media_editor",
									},
								},
								{
									id: "post_4",
									authorId: null,
									byline: {
										id: "byline_guest",
										displayName: "Guest Author",
										image: "https://example.com/guest.png",
									},
								},
							],
						},
					});
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "list_content_authors", {
			collection: "posts",
		});

		expect(result.isError).toBeUndefined();
		expect(requestedPaths).toEqual([
			"/_emdash/api/content/posts/authors?",
			"/_emdash/api/content/posts?limit=100&orderBy=updatedAt&order=desc",
		]);
		const parsed = JSON.parse(result.content[0]?.text ?? "{}");
		expect(parsed.data.items).toEqual([
			{
				id: "user_author",
				name: "Jordan",
				email: "jordan@example.com",
				avatarUrl: "/_emdash/api/media/file/authors/jordan.png",
				filterableByAuthorId: true,
				filterableBylineId: false,
				source: "content_list_authorId_fallback",
			},
			{
				id: "user_editor",
				name: "Editor",
				email: null,
				avatarUrl: "/_emdash/api/media/file/media_editor",
				filterableByAuthorId: true,
				filterableBylineId: false,
				source: "content_list_authorId_fallback",
			},
			{
				id: "byline_guest",
				name: "Guest Author",
				email: null,
				avatarUrl: "https://example.com/guest.png",
				filterableByAuthorId: false,
				filterableBylineId: true,
				bylineId: "byline_guest",
				source: "content_list_byline_fallback",
			},
		]);
		expect((result as any).structuredContent.data._tedix.source).toBe(
			"content_list_authorId_fallback",
		);
	});

	it("resolves translated byline IDs and forwards one native filtered page and its cursor", async () => {
		const paths: string[] = [];
		const page = {
			success: true,
			data: {
				items: [{ id: "secondary-credit" }, { id: "inferred-credit" }],
				nextCursor: "native-next",
			},
		};
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					paths.push(url.pathname + url.search);
					if (url.pathname.endsWith("/bylines/translated-row"))
						return Response.json({
							success: true,
							data: { id: "translated-row", translationGroup: "jordan-group" },
						});
					if (url.pathname.endsWith("/bylines/jordan-group"))
						return Response.json(
							{ error: { code: "NOT_FOUND" } },
							{ status: 404 },
						);
					return Response.json(page);
				},
			} as Fetcher,
		};
		const result = await callCmsRest(ctx, "list_content_byline_entries", {
			collection: "posts",
			bylineId: "translated-row",
			bylineIds: ["jordan-group"],
			includeInferredBylines: true,
			status: "published",
			locale: "de",
			limit: 2,
			cursor: "native-previous",
		});
		expect(result.isError).toBeUndefined();
		expect(paths).toEqual([
			"/_emdash/api/admin/bylines/translated-row",
			"/_emdash/api/admin/bylines/jordan-group",
			"/_emdash/api/content/posts?status=published&limit=2&cursor=native-previous&locale=de&bylines=jordan-group&includeInferredBylines=1",
		]);
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(page);
	});

	it("does not mask failed byline resolution or widen an empty byline filter", async () => {
		let calls = 0;
		const ctx = {
			...baseContext,
			internalAuthToken: "internal",
			cmsDispatch: {
				fetch: async (_request: Request) => {
					calls++;
					return Response.json(
						{ error: { code: "FORBIDDEN" } },
						{ status: 403 },
					);
				},
			} as Fetcher,
		};
		expect(
			(
				await callCmsRest(ctx, "list_content_byline_entries", {
					collection: "posts",
				})
			).isError,
		).toBe(true);
		expect(calls).toBe(0);
		for (const args of [
			{ bylineId: "none" },
			{ bylineIds: Array.from({ length: 26 }, (_, i) => `byline-${i}`) },
		]) {
			expect(
				(
					await callCmsRest(ctx, "list_content_byline_entries", {
						collection: "posts",
						...args,
					})
				).isError,
			).toBe(true);
		}
		expect(calls).toBe(0);
		expect(
			(
				await callCmsRest(ctx, "list_content_byline_entries", {
					collection: "posts",
					bylineId: "restricted",
				})
			).isError,
		).toBe(true);
		expect(calls).toBe(1);
	});

	it.each(["Editor", null])(
		"passes native roleLabel %s without dropping null",
		async (roleLabel) => {
			let saved: unknown;
			const ctx = {
				...baseContext,
				internalAuthToken: "internal",
				cmsDispatch: {
					fetch: async (request: Request) => {
						// Use the installed native write schema that previously stripped role.
						saved = contentUpdateBody.parse(await request.json());
						return Response.json({ success: true, data: saved });
					},
				} as Fetcher,
			};
			const result = await callCmsRest(ctx, "content_update", {
				collection: "posts",
				id: "post",
				_rev: "1",
				bylines: [{ bylineId: "author", roleLabel }],
			});
			expect(result.isError).toBeUndefined();
			expect(saved).toMatchObject({
				bylines: [{ bylineId: "author", roleLabel }],
			});
		},
	);

	it("reads the native calendar with canonical bounds and preserves native permission errors", async () => {
		const paths: string[] = [];
		const page = {
			success: true,
			data: {
				items: [
					{
						collection: "posts",
						id: "scheduled",
						locale: "en",
						title: "Scheduled",
						status: "draft",
						kind: "scheduled",
						at: "2026-10-04T00:00:00.000Z",
					},
				],
				nextCursor: "calendar-next",
			},
		};
		const ctx = {
			...baseContext,
			internalAuthToken: "internal",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					paths.push(url.pathname);
					expect(
						calendarQuery.parse(Object.fromEntries(url.searchParams)),
					).toEqual({
						from: "2026-10-01T00:00:00.000Z",
						to: "2026-11-01T00:00:00.000Z",
						limit: 2,
						cursor: "previous",
					});
					return Response.json(page);
				},
			} as Fetcher,
		};
		const args = {
			from: "2026-10-01T02:00:00+02:00",
			to: "2026-11-01T00:00:00Z",
			limit: 2,
			cursor: "previous",
		};
		const result = await callCmsRest(ctx, "list_calendar_entries", args);
		expect(result.isError).toBeUndefined();
		expect(paths).toEqual(["/_emdash/api/calendar"]);
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(page);
		const denied = await callCmsRest(
			{
				...ctx,
				cmsDispatch: {
					fetch: async (_request: Request) =>
						Response.json(
							{
								error: {
									code: "FORBIDDEN",
									message: "content:read_drafts required",
								},
							},
							{ status: 403 },
						),
				} as Fetcher,
			},
			"list_calendar_entries",
			args,
		);
		expect(denied.isError).toBe(true);
		expect(denied.content[0]?.text).toContain("content:read_drafts");
	});

	it("uses native range validation for calendar discovery and direct calls", async () => {
		const definitions = new Map<string, any>();
		registerCmsProxyTools(
			{
				registerTool: (name: string, definition: any) =>
					definitions.set(name, definition),
			} as any,
			baseContext,
		);
		const calendar = definitions.get("list_calendar_entries");
		expect(calendar.annotations.readOnlyHint).toBe(true);
		const valid = { from: "2026-10-01T00:00:00Z", to: "2026-12-02T00:00:00Z" };
		expect(calendar.inputSchema.safeParse(valid).success).toBe(true);
		for (const args of [
			{ ...valid, to: "2026-12-03T00:00:00Z" },
			{ ...valid, to: valid.from },
			{ ...valid, from: "invalid" },
			{ ...valid, limit: 101 },
		]) {
			expect(calendar.inputSchema.safeParse(args).success).toBe(false);
			const result = await callCmsRest(
				{
					...baseContext,
					internalAuthToken: "internal",
					cmsDispatch: {
						fetch: async (_request: Request): Promise<Response> => {
							throw new Error("Invalid range must not fetch");
						},
					} as Fetcher,
				},
				"list_calendar_entries",
				args,
			);
			expect(result.isError).toBe(true);
		}
		const update = definitions.get("content_update").inputSchema;
		expect(
			update.safeParse({
				collection: "posts",
				id: "post",
				_rev: "1",
				bylines: [{ bylineId: "author", roleLabel: null }],
			}).success,
		).toBe(true);
		expect(
			update.safeParse({
				collection: "posts",
				id: "post",
				_rev: "1",
				bylines: [{ bylineId: "author", role: "Editor" }],
			}).success,
		).toBe(false);
	});

	it.each([
		{
			toolName: "content_delete",
			method: "DELETE",
			path: "/_emdash/api/content/posts/mein-beitrag",
			args: { collection: "posts", id: "mein-beitrag", locale: "de" },
		},
		{
			toolName: "content_publish",
			method: "POST",
			path: "/_emdash/api/content/posts/mein-beitrag/publish",
			args: {
				collection: "posts",
				id: "mein-beitrag",
				locale: "de",
				publishedAt: "2026-06-13T08:00:00Z",
				_rev: "rev_1",
			},
			body: { publishedAt: "2026-06-13T08:00:00Z", _rev: "rev_1" },
		},
		{
			toolName: "content_unpublish",
			method: "POST",
			path: "/_emdash/api/content/posts/mein-beitrag/unpublish",
			args: {
				collection: "posts",
				id: "mein-beitrag",
				locale: "de",
				_rev: "rev_1",
			},
			body: { _rev: "rev_1" },
		},
		{
			toolName: "content_schedule",
			method: "POST",
			path: "/_emdash/api/content/posts/mein-beitrag/schedule",
			args: {
				collection: "posts",
				id: "mein-beitrag",
				locale: "de",
				scheduledAt: "2026-06-14T08:00:00Z",
			},
			body: { scheduledAt: "2026-06-14T08:00:00Z" },
		},
		{
			toolName: "content_unschedule",
			method: "DELETE",
			path: "/_emdash/api/content/posts/mein-beitrag/schedule",
			args: { collection: "posts", id: "mein-beitrag", locale: "de" },
		},
		{
			toolName: "content_compare",
			method: "GET",
			path: "/_emdash/api/content/posts/mein-beitrag/compare",
			args: { collection: "posts", id: "mein-beitrag", locale: "de" },
		},
		{
			toolName: "content_discard_draft",
			method: "POST",
			path: "/_emdash/api/content/posts/mein-beitrag/discard-draft",
			args: {
				collection: "posts",
				id: "mein-beitrag",
				locale: "de",
				_rev: "rev_1",
			},
			body: { _rev: "rev_1" },
		},
	])(
		"passes locale through $toolName for slug-based content actions",
		async ({ toolName, method, path, args, body }) => {
			let requestedMethod = "";
			let requestedPath = "";
			let requestedQuery = "";
			let requestedBody: unknown;
			const ctx: CmsProxyContext = {
				...baseContext,
				serviceApiKey: "ec_pat_secret",
				cmsDispatch: {
					fetch: async (request: Request) => {
						const url = new URL(request.url);
						requestedMethod = request.method;
						requestedPath = url.pathname;
						requestedQuery = url.searchParams.toString();
						if (request.body) requestedBody = await request.json();
						return Response.json({ data: { id: "item_1" } });
					},
				} as Fetcher,
			};

			const result = await callCmsRest(ctx, toolName, args);

			expect(result.isError).toBeUndefined();
			expect(requestedMethod).toBe(method);
			expect(requestedPath).toBe(path);
			expect(requestedQuery).toBe("locale=de");
			expect(requestedBody).toEqual(body);
		},
	);

	it("advertises locale for slug-based content action schemas", () => {
		const tools = new Map<
			string,
			{
				annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
				inputSchema?: unknown;
			}
		>();
		const server = {
			registerTool: (
				name: string,
				definition: {
					annotations?: {
						destructiveHint?: boolean;
						readOnlyHint?: boolean;
					};
					inputSchema?: unknown;
				},
			) => {
				tools.set(name, definition);
			},
		};

		registerCmsProxyTools(server as any, baseContext);

		for (const toolName of [
			"content_delete",
			"content_publish",
			"content_unpublish",
			"content_schedule",
			"content_unschedule",
			"content_compare",
			"content_discard_draft",
		]) {
			const shape = (tools.get(toolName)?.inputSchema as any)?.shape;
			expect(shape?.locale, toolName).toBeDefined();
		}

		for (const toolName of [
			"content_publish",
			"content_unpublish",
			"content_schedule",
			"content_unschedule",
		]) {
			expect(tools.get(toolName)?.annotations, toolName).toEqual({
				readOnlyHint: false,
				destructiveHint: true,
			});
		}
		const publishSchema = tools.get("content_publish")?.inputSchema as any;
		expect(publishSchema?.shape?._rev).toBeDefined();
		expect(
			publishSchema.safeParse({
				collection: "posts",
				id: "post_1",
				_rev: "rev_1",
			}).success,
		).toBe(true);
	});

	it("forwards a REST publish revision without a timestamp and preserves a stale revision conflict", async () => {
		let calls = 0;
		let requestedBody: unknown;
		// The REST transport (no PAT). The native transport's stale-revision
		// conflict is proven against real Emdash in tenant-mcp-emdash.test.ts.
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					calls++;
					requestedBody = await request.json();
					return Response.json(
						{
							success: false,
							error: { code: "CONFLICT", message: "Revision has changed" },
						},
						{ status: 409 },
					);
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "content_publish", {
			collection: "posts",
			id: "post_1",
			_rev: "rev_stale",
		});

		expect(requestedBody).toEqual({ _rev: "rev_stale" });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("409");
		expect(result.content[0]?.text).toContain("CONFLICT");
		expect(result.content[0]?.text).toContain("Revision has changed");
		expect(calls).toBe(1);
	});

	it("routes media_search to native Emdash media q filtering", async () => {
		let requestedPath = "";
		let requestedQuery = "";
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					requestedPath = url.pathname;
					requestedQuery = url.searchParams.toString();
					return Response.json({ data: { items: [] } });
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "media_search", {
			q: "article hero",
			mimeType: "image/",
			limit: 20,
			cursor: "next",
		});

		expect(result.isError).toBeUndefined();
		expect(requestedPath).toBe("/_emdash/api/media");
		expect(requestedQuery).toBe(
			"q=article+hero&mimeType=image%2F&limit=20&cursor=next",
		);
	});
});

describe("byline schema REST proxy routes", () => {
	it("deletes a byline through the native admin route without a body", async () => {
		const seen: Array<{ method: string; path: string; body: boolean }> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					seen.push({
						method: request.method,
						path: new URL(request.url).pathname,
						body: request.body !== null,
					});
					return Response.json({ success: true, data: { deleted: true } });
				},
			} as Fetcher,
		};
		const result = await callCmsRest(ctx, "byline_delete", {
			id: "author/one",
		});
		expect(result.isError).toBeUndefined();
		expect(seen).toEqual([
			{
				method: "DELETE",
				path: "/_emdash/api/admin/bylines/author%2Fone",
				body: false,
			},
		]);
	});

	it("forwards native Emdash 0.17 byline customFields on update", async () => {
		const seen: Array<{ method: string; path: string; body?: unknown }> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					if (request.method === "GET") {
						seen.push({ method: request.method, path: url.pathname });
						return Response.json({
							data: {
								id: "byline_1",
								slug: "christian",
								displayName: "Dr. Christian Probst",
								bio: "Bio",
								websiteUrl: null,
								customFields: {},
							},
						});
					}

					const body = await request.json();
					seen.push({ method: request.method, path: url.pathname, body });
					return Response.json({
						data: { id: "byline_1", ...(body as Record<string, unknown>) },
					});
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "byline_update", {
			id: "byline_1",
			customFields: {
				linkedin_url: "https://www.linkedin.com/in/dr-christian-probst/",
				job_title: "Experte für Vorsorgedokumente",
			},
		});

		expect(result.isError).toBeUndefined();
		expect(seen).toEqual([
			{ method: "GET", path: "/_emdash/api/admin/bylines/byline_1" },
			{
				method: "PUT",
				path: "/_emdash/api/admin/bylines/byline_1",
				body: {
					slug: "christian",
					displayName: "Dr. Christian Probst",
					bio: "Bio",
					websiteUrl: null,
					customFields: {
						linkedin_url: "https://www.linkedin.com/in/dr-christian-probst/",
						job_title: "Experte für Vorsorgedokumente",
					},
				},
			},
		]);
	});

	it("calls the native Emdash byline-field schema endpoints", async () => {
		const seen: Array<{ method: string; path: string; body?: unknown }> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					const body =
						request.method === "GET" || request.method === "DELETE"
							? undefined
							: await request.json();
					seen.push({ method: request.method, path: url.pathname, body });
					return Response.json({ data: { items: [] } });
				},
			} as Fetcher,
		};

		await callCmsRest(ctx, "list_byline_fields", {});
		await callCmsRest(ctx, "create_byline_field", {
			slug: "linkedin_url",
			label: "LinkedIn",
			type: "url",
			translatable: false,
		});
		await callCmsRest(ctx, "update_byline_field", {
			slug: "linkedin_url",
			label: "LinkedIn profile",
		});
		await callCmsRest(ctx, "get_byline_field_usage", {
			slug: "linkedin_url",
		});
		await callCmsRest(ctx, "reorder_byline_fields", {
			slugs: ["job_title", "linkedin_url"],
		});

		expect(seen).toEqual([
			{
				method: "GET",
				path: "/_emdash/api/admin/byline-fields",
				body: undefined,
			},
			{
				method: "POST",
				path: "/_emdash/api/admin/byline-fields",
				body: {
					slug: "linkedin_url",
					label: "LinkedIn",
					type: "url",
					translatable: false,
				},
			},
			{
				method: "PATCH",
				path: "/_emdash/api/admin/byline-fields/linkedin_url",
				body: {
					label: "LinkedIn profile",
				},
			},
			{
				method: "GET",
				path: "/_emdash/api/admin/byline-fields/linkedin_url/usage",
				body: undefined,
			},
			{
				method: "POST",
				path: "/_emdash/api/admin/byline-fields/reorder",
				body: { slugs: ["job_title", "linkedin_url"] },
			},
		]);
	});
});

describe("REST envelope + cold-start hardening", () => {
	it("normalizes bare-array data into { items } for list structured content", async () => {
		const menus = [{ name: "main", locale: null, items: [] }];
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal-token",
			cmsDispatch: {
				fetch: async (_request: Request) =>
					Response.json({ success: true, data: menus }),
			} as Fetcher,
		};
		const result = await callCmsRest(ctx, "menu_list", {});
		expect(result.isError).toBeUndefined();
		// Structured payload matches ListResponseSchema's `{ data: { items } }`…
		expect(
			(result as { structuredContent?: { data?: { items?: unknown } } })
				.structuredContent?.data?.items,
		).toEqual(menus);
		// …while the text block stays byte-faithful to the upstream array.
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
			success: true,
			data: { items: menus },
		});
	});

	it("retries a GET once after a cold-start timeout", async () => {
		let calls = 0;
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal-token",
			cmsDispatch: {
				fetch: async (_request: Request) => {
					calls++;
					if (calls === 1) {
						throw Object.assign(new Error("The operation was aborted"), {
							name: "AbortError",
						});
					}
					return Response.json({ success: true, data: { items: [] } });
				},
			} as Fetcher,
		};
		const result = await callCmsRest(ctx, "menu_list", {});
		expect(result.isError).toBeUndefined();
		expect(calls).toBe(2);
	});

	it("lets native transfer steps outlive ordinary REST without retrying a timed-out write", async () => {
		vi.useFakeTimers();
		try {
			let calls = 0;
			const ctx: CmsProxyContext = {
				...baseContext,
				internalAuthToken: "internal-token",
				cmsDispatch: {
					fetch: async (request: Request) => {
						calls++;
						return await new Promise<Response>((_resolve, reject) => {
							request.signal.addEventListener("abort", () =>
								reject(new DOMException("Aborted", "AbortError")),
							);
						});
					},
				} as Fetcher,
			};
			let completed = false;
			const pending = callCmsTransferRest(ctx, "site_export_status", {
				operationId: "export-1",
				advance: true,
			}).then((result) => {
				completed = true;
				return result;
			});
			await vi.advanceTimersByTimeAsync(15_001);
			expect(completed).toBe(false);
			expect(calls).toBe(1);
			await vi.advanceTimersByTimeAsync(104_999);
			const result = await pending;
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("timed out after 120000ms");
			expect(calls).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("never retries a write after a timeout", async () => {
		let calls = 0;
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal-token",
			cmsDispatch: {
				fetch: async (_request: Request) => {
					calls++;
					throw Object.assign(new Error("The operation was aborted"), {
						name: "AbortError",
					});
				},
			} as unknown as Fetcher,
		};
		const result = await callCmsRest(ctx, "menu_create", { name: "main" });
		expect(result.isError).toBe(true);
		expect(calls).toBe(1);
		expect(result.content[0]?.text).toMatch(/timed out/);
	});
});

describe("menu_set_items", () => {
	it("does not replace menu items after a human read is denied", async () => {
		const seen: Array<{ path: string; auth: string | null }> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			forwardedAuth: "aaa.bbb.ccc",
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					const auth =
						request.headers.get("cookie") ??
						request.headers.get("x-tedix-cms-internal-auth");
					seen.push({ path: url.pathname, auth });

					if (request.headers.get("cookie")) {
						return new Response("jwt denied", { status: 401 });
					}

					if (request.method === "GET") {
						return Response.json({ data: { items: [] } });
					}

					return Response.json({ data: { id: "item_1" } });
				},
			} as Fetcher,
		};

		const result = await menuSetItems(ctx, {
			name: "primary",
			locale: "en",
			items: [{ label: "Home", type: "custom", customUrl: "/" }],
		});

		expect(result.isError).toBe(true);
		expect(seen).toEqual([
			{ path: "/_emdash/api/menus/primary/items", auth: "DS=aaa.bbb.ccc" },
		]);
	});

	it("forwards to the native atomic menu_set_items when a service PAT exists", async () => {
		const calls: Array<{
			authorization: string | null;
			body: Record<string, any>;
			path: string;
		}> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			forwardedAuth: undefined,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const body = (await request.json()) as Record<string, any>;
					calls.push({
						authorization: request.headers.get("authorization"),
						body,
						path: new URL(request.url).pathname,
					});
					const handshake = emdashMcpHandshake(body);
					if (handshake) return handshake;
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							content: [
								{
									type: "text",
									text: JSON.stringify({ name: "primary", itemCount: 2 }),
								},
							],
						},
					});
				},
			} as Fetcher,
		};

		const result = await menuSetItems(ctx, {
			name: "primary",
			locale: "en",
			items: [
				{ label: "Home", type: "custom", customUrl: "/" },
				{ label: "Docs", type: "custom", customUrl: "/docs", parentIndex: 0 },
			],
		});

		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
			success: true,
			data: { name: "primary", itemCount: 2 },
		});
		expect(calls.map((call) => call.body.method)).toEqual([
			...EMDASH_HANDSHAKE,
			"tools/call",
		]);
		expect(calls.every((call) => call.path === "/_emdash/api/mcp")).toBe(true);
		expect(
			calls.every((call) => call.authorization === "Bearer ec_pat_secret"),
		).toBe(true);
		expect(calls[3]?.body).toMatchObject({
			method: "tools/call",
			params: {
				name: "menu_set_items",
				arguments: {
					name: "primary",
					locale: "en",
					items: [
						{ label: "Home", type: "custom", customUrl: "/" },
						{
							label: "Docs",
							type: "custom",
							customUrl: "/docs",
							parentIndex: 0,
						},
					],
				},
			},
		});
	});

	it.each([400, 401])(
		"does not turn discovery or auth errors into decomposed menu writes (%s)",
		async (status) => {
			const paths: string[] = [];
			const ctx: CmsProxyContext = {
				...baseContext,
				serviceApiKey: "ec_pat_secret",
				cmsDispatch: {
					fetch: async (request: Request) => {
						const path = new URL(request.url).pathname;
						paths.push(path);
						expect(request.headers.get("authorization")).toBe(
							"Bearer ec_pat_secret",
						);
						if (path.endsWith("/mcp"))
							return new Response(
								status === 400
									? "Bad Request: Unsupported protocol version: 2026-07-28"
									: "Unauthorized",
								{ status },
							);
						if (request.method === "GET")
							return Response.json({ data: { items: [] } });
						return Response.json({ data: { id: "home" } });
					},
				} as Fetcher,
			};
			const result = await menuSetItems(ctx, {
				name: "primary",
				locale: "en",
				items: [{ label: "Home", type: "custom", customUrl: "/" }],
			});
			expect(result.isError).toBe(true);
			// A non-JSON-RPC 400 on the probe is a legacy signal, so the SDK tries
			// `initialize` (also rejected); a 401 stops at the probe. Either way no
			// request leaves the MCP endpoint for decomposed REST writes.
			expect(paths).toEqual(
				status === 400
					? ["/_emdash/api/mcp", "/_emdash/api/mcp"]
					: ["/_emdash/api/mcp"],
			);
		},
	);

	it("recovers a read through internal REST auth when tenant MCP discovery is unauthorized", async () => {
		const calls: Array<{ path: string; internal: boolean }> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const path = new URL(request.url).pathname;
					const internal =
						request.headers.get("X-Tedix-CMS-Internal-Auth") ===
						"internal_secret";
					calls.push({ path, internal });
					if (!internal)
						return new Response("Not authenticated", { status: 401 });
					return Response.json({ success: true, data: { items: [] } });
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "content_list", {
			collection: "posts",
			status: "published",
		});

		expect(result.isError).toBeUndefined();
		expect(calls).toEqual([
			{ path: "/_emdash/api/mcp", internal: false },
			{ path: "/_emdash/api/content/posts", internal: true },
		]);
	});

	it("replaces a human menu atomically without using the available service PAT", async () => {
		const requests: Request[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			forwardedAuth: "aaa.bbb.ccc",
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					requests.push(request);
					return Response.json({
						success: true,
						data: { name: "primary", itemCount: 1 },
					});
				},
			} as Fetcher,
		};
		const items = [{ label: "Home", type: "custom", customUrl: "/" }];
		const result = await menuSetItems(ctx, {
			name: "primary",
			locale: "de",
			items,
		});
		expect(result.isError).toBeUndefined();
		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("PUT");
		expect(new URL(requests[0]!.url).pathname).toBe(
			"/_emdash/api/menus/primary/items",
		);
		expect(new URL(requests[0]!.url).search).toBe("?locale=de");
		expect(requests[0]?.headers.get("cookie")).toBe("DS=aaa.bbb.ccc");
		expect(requests[0]?.headers.get("authorization")).toBeNull();
		expect(await requests[0]?.json()).toEqual({ items });
	});
});

describe("generic native tenant MCP dispatch", () => {
	/** Fake tenant MCP endpoint: answers discovery, records tools/call. */
	const tenantMcpDispatch = (
		respond: (name: string, args: Record<string, unknown>) => unknown,
		calls: Array<{ name: string; arguments: Record<string, unknown> }>,
		requests?: Array<{
			path: string;
			authorization: string | null;
			protocolVersion: string | null;
		}>,
	) =>
		({
			fetch: async (request: Request) => {
				const body = (await request.json()) as Record<string, any>;
				requests?.push({
					path: new URL(request.url).pathname,
					authorization: request.headers.get("authorization"),
					protocolVersion: request.headers.get("mcp-protocol-version"),
				});
				const handshake = emdashMcpHandshake(body);
				if (handshake) return handshake;
				calls.push({
					name: body.params?.name,
					arguments: body.params?.arguments,
				});
				const data = respond(body.params?.name, body.params?.arguments ?? {});
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						content: [{ type: "text", text: JSON.stringify(data) }],
					},
				});
			},
		}) as Fetcher;

	it("forwards taxonomy definition and term locale fields to native MCP under a service PAT", async () => {
		const calls: Array<{ name: string; arguments: Record<string, unknown> }> =
			[];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: tenantMcpDispatch(() => ({ taxonomy: { id: "x" } }), calls),
		};
		await callCmsRest(ctx, "taxonomy_create", {
			name: "topics",
			label: "Themen",
			locale: "de",
			translationOf: "definition_en",
		});
		await callCmsRest(ctx, "taxonomy_create_term", {
			taxonomy: "topics",
			label: "Klima",
			locale: "de",
			translationOf: "term_en",
		});
		await callCmsRest(ctx, "taxonomy_update_term", {
			taxonomy: "topics",
			termSlug: "climate",
			locale: "de",
			label: "Klima",
		});
		await callCmsRest(ctx, "taxonomy_delete_term", {
			taxonomy: "topics",
			termSlug: "climate",
			locale: "de",
		});
		expect(calls).toEqual([
			{
				name: "taxonomy_create",
				arguments: {
					name: "topics",
					label: "Themen",
					locale: "de",
					translationOf: "definition_en",
				},
			},
			{
				name: "taxonomy_create_term",
				arguments: {
					taxonomy: "topics",
					label: "Klima",
					locale: "de",
					translationOf: "term_en",
				},
			},
			{
				name: "taxonomy_update_term",
				arguments: {
					taxonomy: "topics",
					termSlug: "climate",
					locale: "de",
					label: "Klima",
				},
			},
			{
				name: "taxonomy_delete_term",
				arguments: { taxonomy: "topics", termSlug: "climate", locale: "de" },
			},
		]);
	});

	it("gates native forwarding on mapping, PAT, human JWT, and REST-only args", () => {
		const pat: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
		};
		// mapped + PAT, no human session → native
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "content_get", {
				collection: "posts",
				id: "post_1",
			}),
		).toBe(true);
		// unmapped row → REST
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "content_unpublish", {
				collection: "posts",
				id: "post_1",
			}),
		).toBe(false);
		// the native tool requires _rev; without one the optional-_rev REST
		// contract keeps the call
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "content_publish", {
				collection: "posts",
				id: "post_1",
			}),
		).toBe(false);
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "content_publish", {
				collection: "posts",
				id: "post_1",
				_rev: "rev_1",
			}),
		).toBe(true);
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "content_update", {
				collection: "posts",
				id: "post_1",
				data: { title: "x" },
			}),
		).toBe(false);
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "content_update", {
				collection: "posts",
				id: "post_1",
				data: { title: "x" },
				_rev: "rev_1",
			}),
		).toBe(true);
		for (const restOnly of [{ status: "draft" }, { references: {} }]) {
			expect(
				shouldForwardCmsRestToTenantMcp(pat, "content_update", {
					collection: "posts",
					id: "post_1",
					_rev: "rev_1",
					...restOnly,
				}),
			).toBe(false);
		}
		// locale-scoped slug lookups and REST-only collection settings stay REST
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "content_delete", {
				collection: "posts",
				id: "mein-beitrag",
				locale: "de",
			}),
		).toBe(false);
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "schema_update_collection", {
				slug: "pages",
				admin: { quickCreate: false },
			}),
		).toBe(false);
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "schema_update_collection", {
				slug: "pages",
				label: "Seiten",
			}),
		).toBe(true);
		// no PAT → REST
		expect(
			shouldForwardCmsRestToTenantMcp(
				{ ...baseContext, internalAuthToken: "internal_secret" },
				"content_get",
				{ collection: "posts", id: "post_1" },
			),
		).toBe(false);
		// forwarded human JWT keeps per-user Descope attribution on REST even
		// when the org PAT is provisioned
		expect(
			shouldForwardCmsRestToTenantMcp(
				{ ...pat, forwardedAuth: "aaa.bbb.ccc" },
				"content_get",
				{
					collection: "posts",
					id: "post_1",
				},
			),
		).toBe(false);
		// filters the native tool cannot express stay on REST
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "content_list", {
				collection: "posts",
				q: "vorsorge",
			}),
		).toBe(false);
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "content_list", {
				collection: "posts",
				status: "published",
			}),
		).toBe(true);
	});

	it("forwards a mapped tool natively with the PAT and re-wraps the REST envelope", async () => {
		const calls: Array<{ name: string; arguments: Record<string, unknown> }> =
			[];
		const requests: Array<{
			path: string;
			authorization: string | null;
			protocolVersion: string | null;
		}> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: tenantMcpDispatch(
				() => ({
					item: { id: "post_1", slug: "hello", status: "draft" },
					_rev: "rev_1",
				}),
				calls,
				requests,
			),
		};

		const result = await callCmsRest(ctx, "content_get", {
			collection: "posts",
			id: "post_1",
			locale: "de",
			unknownExtra: "dropped",
		});

		expect(result.isError).toBeUndefined();
		expect(
			requests.every((request) => request.path === "/_emdash/api/mcp"),
		).toBe(true);
		expect(
			requests.every(
				(request) => request.authorization === "Bearer ec_pat_secret",
			),
		).toBe(true);
		// 2026 probe, then the 2025 handshake and call on the negotiated revision.
		expect(requests.map((request) => request.protocolVersion)).toEqual([
			"2026-07-28",
			null,
			"2025-11-25",
			"2025-11-25",
		]);
		expect(calls).toEqual([
			{
				name: "content_get",
				arguments: { collection: "posts", id: "post_1", locale: "de" },
			},
		]);
		// Same envelope the REST transport emits: { success, data } text plus the
		// normalized get-one structuredContent.
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
			success: true,
			data: {
				item: { id: "post_1", slug: "hello", status: "draft" },
				_rev: "rev_1",
			},
		});
		expect(
			(result as { structuredContent?: unknown }).structuredContent,
		).toMatchObject({
			data: {
				item: { id: "post_1", slug: "hello", status: "draft" },
				_rev: "rev_1",
			},
		});
	});

	it("calls a 2026 tenant endpoint sessionlessly and remembers the modern era", async () => {
		const requests: Array<{
			method: string;
			protocolVersion: string | null;
			mcpMethod: string | null;
		}> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const body = (await request.json()) as Record<string, any>;
					requests.push({
						method: body.method,
						protocolVersion: request.headers.get("mcp-protocol-version"),
						mcpMethod: request.headers.get("mcp-method"),
					});
					if (body.method === "server/discover") {
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								resultType: "complete",
								supportedVersions: ["2026-07-28"],
								capabilities: { tools: {} },
								_meta: {
									"io.modelcontextprotocol/serverInfo": {
										name: "emdash",
										version: "2.0.0",
									},
								},
							},
						});
					}
					if (body.method !== "tools/call") {
						throw new Error(`unexpected method ${body.method}`);
					}
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							resultType: "complete",
							content: [{ type: "text", text: body.params.name }],
						},
					});
				},
			} as Fetcher,
		};

		const first = await callTenantMcpTool(ctx, "content_get", { id: "a" });
		const second = await callTenantMcpTool(ctx, "content_list", {});

		expect(first.content[0]?.text).toBe("content_get");
		expect(second.content[0]?.text).toBe("content_list");
		expect(requests).toEqual([
			{
				method: "server/discover",
				protocolVersion: "2026-07-28",
				mcpMethod: "server/discover",
			},
			{
				method: "tools/call",
				protocolVersion: "2026-07-28",
				mcpMethod: "tools/call",
			},
			{
				method: "tools/call",
				protocolVersion: "2026-07-28",
				mcpMethod: "tools/call",
			},
		]);
	});

	it("fails closed when the tenant offers only unsupported 2026+ revisions", async () => {
		let requests = 0;
		const result = await callTenantMcpTool(
			{
				...baseContext,
				serviceApiKey: "ec_pat_secret",
				cmsDispatch: {
					fetch: async (request: Request) => {
						requests += 1;
						const body = (await request.json()) as { id: unknown };
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							error: {
								code: -32022,
								message: "Unsupported protocol version",
								data: { supported: ["2099-01-01"], requested: "2026-07-28" },
							},
						});
					},
				} as unknown as Fetcher,
			},
			"content_get",
			{ collection: "posts", id: "post_1" },
		);

		expect(requests).toBe(1);
		expect(result).toMatchObject({ isError: true });
		expect(result.content[0]?.text).toContain("CMS_MCP_PROTOCOL_UNSUPPORTED");
	});

	it("forgets a remembered era when its handshake fails, then re-probes", async () => {
		const methods: string[] = [];
		let rejectInitialize = false;
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const body = (await request.json()) as Record<string, any>;
					methods.push(body.method);
					if (rejectInitialize && body.method === "initialize") {
						return new Response("Not authenticated", { status: 401 });
					}
					const handshake = emdashMcpHandshake(body);
					if (handshake) return handshake;
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: { content: [{ type: "text", text: "ok" }] },
					});
				},
			} as Fetcher,
		};

		expect((await callTenantMcpTool(ctx, "content_get", {})).isError).toBe(
			undefined,
		);
		rejectInitialize = true;
		const failed = await callTenantMcpTool(ctx, "content_get", {});
		expect(failed.content[0]?.text).toMatch(
			/^\[CMS_MCP_DISCOVERY_FAILED\] Tenant MCP discovery failed \(401\)/,
		);
		rejectInitialize = false;
		await callTenantMcpTool(ctx, "content_get", {});

		expect(methods).toEqual([
			...EMDASH_HANDSHAKE,
			"tools/call",
			// Remembered legacy era: no probe; initialize is refused.
			"initialize",
			// Verdict evicted: the next call probes again.
			...EMDASH_HANDSHAKE,
			"tools/call",
		]);
	});

	it("keeps the same tool on REST when no PAT exists", async () => {
		const seen: Array<{ method: string; path: string; auth: string | null }> =
			[];
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					seen.push({
						method: request.method,
						path: new URL(request.url).pathname,
						auth: request.headers.get("x-tedix-cms-internal-auth"),
					});
					return Response.json({
						success: true,
						data: { item: { id: "post_1" }, _rev: "rev_1" },
					});
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "content_get", {
			collection: "posts",
			id: "post_1",
		});

		expect(result.isError).toBeUndefined();
		expect(seen).toEqual([
			{
				method: "GET",
				path: "/_emdash/api/content/posts/post_1",
				auth: "internal_secret",
			},
		]);
	});

	it("keeps a human session on REST for attribution even when the PAT is provisioned", async () => {
		const seen: Array<{ path: string; cookie: string | null }> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			forwardedAuth: "aaa.bbb.ccc",
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					seen.push({
						path: new URL(request.url).pathname,
						cookie: request.headers.get("cookie"),
					});
					return Response.json({ success: true, data: { items: [] } });
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "byline_list", { limit: 5 });

		expect(result.isError).toBeUndefined();
		expect(seen).toEqual([
			{ path: "/_emdash/api/admin/bylines", cookie: "DS=aaa.bbb.ccc" },
		]);
	});

	it("always routes an unmapped tool over REST, even with the PAT", async () => {
		const seen: Array<{ method: string; path: string; auth: string | null }> =
			[];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					seen.push({
						method: request.method,
						path: new URL(request.url).pathname,
						auth: request.headers.get("authorization"),
					});
					return Response.json({ success: true, data: { id: "post_1" } });
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "content_publish", {
			collection: "posts",
			id: "post_1",
		});

		expect(result.isError).toBeUndefined();
		expect(seen).toEqual([
			{
				method: "POST",
				path: "/_emdash/api/content/posts/post_1/publish",
				auth: "Bearer ec_pat_secret",
			},
		]);
	});

	it("keeps content_list on REST when native-unsupported filters are present", async () => {
		const seen: string[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					seen.push(`${url.pathname}?${url.searchParams.toString()}`);
					return Response.json({ success: true, data: { items: [] } });
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "content_list", {
			collection: "posts",
			q: "vorsorge",
			limit: 5,
		});

		expect(result.isError).toBeUndefined();
		expect(seen).toEqual(["/_emdash/api/content/posts?q=vorsorge&limit=5"]);
	});

	it("projects a native list payload into the REST list envelope", async () => {
		const calls: Array<{ name: string; arguments: Record<string, unknown> }> =
			[];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: tenantMcpDispatch(
				() => ({
					items: [{ id: "post_1", slug: "hello", status: "published" }],
					nextCursor: "cursor_2",
				}),
				calls,
			),
		};

		const result = await callCmsRest(ctx, "content_list", {
			collection: "posts",
			status: "published",
			limit: 1,
		});

		expect(result.isError).toBeUndefined();
		expect(calls).toEqual([
			{
				name: "content_list",
				arguments: { collection: "posts", status: "published", limit: 1 },
			},
		]);
		const parsed = JSON.parse(result.content[0]?.text ?? "{}");
		expect(parsed).toEqual({
			success: true,
			data: {
				items: [{ id: "post_1", slug: "hello", status: "published" }],
				nextCursor: "cursor_2",
			},
		});
		expect(
			(result as { structuredContent?: unknown }).structuredContent,
		).toEqual(parsed);
	});

	it("propagates native tool errors without falling back to REST", async () => {
		const restPaths: string[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					if (url.pathname === "/_emdash/api/mcp") {
						const body = (await request.json()) as Record<string, any>;
						const handshake = emdashMcpHandshake(body);
						if (handshake) return handshake;
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								content: [
									{
										type: "text",
										text: "[NOT_FOUND] Content item not found: x",
									},
								],
								isError: true,
							},
						});
					}
					restPaths.push(url.pathname);
					return Response.json({ success: true, data: {} });
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "content_get", {
			collection: "posts",
			id: "x",
		});

		expect(result).toMatchObject({ isError: true });
		expect(result.content[0]?.text).toBe(
			"[NOT_FOUND] Content item not found: x",
		);
		expect(restPaths).toEqual([]);
	});
});

describe("released Emdash MCP negotiation", () => {
	it.each([false, true])(
		"uses native tools once after official SDK negotiation (tool error=%s)",
		async (toolError) => {
			const methods: string[] = [];
			const ctx: CmsProxyContext = {
				...baseContext,
				serviceApiKey: "ec_pat_secret",
				cmsDispatch: {
					fetch: async (request: Request) => {
						expect(request.headers.get("authorization")).toBe(
							"Bearer ec_pat_secret",
						);
						const body = (await request.json()) as {
							method: string;
							id?: number;
							params?: unknown;
						};
						methods.push(body.method);
						if (body.method === "server/discover")
							return new Response(
								"Unsupported protocol version: 2026-07-28 (supported versions: 2025-11-25)",
								{ status: 400 },
							);
						if (body.method === "initialize")
							return Response.json({
								jsonrpc: "2.0",
								id: body.id,
								result: {
									protocolVersion: "2025-11-25",
									capabilities: { tools: {} },
									serverInfo: { name: "Emdash", version: "0.38.0" },
								},
							});
						if (body.method === "notifications/initialized")
							return new Response(null, { status: 202 });
						if (body.method === "tools/call")
							return Response.json({
								jsonrpc: "2.0",
								id: body.id,
								result: {
									content: [{ type: "text", text: "native result" }],
									...(toolError ? { isError: true } : {}),
								},
							});
						throw Error("unexpected method " + body.method);
					},
				} as Fetcher,
			};
			const r = await callTenantMcpTool(ctx, "media_upload", {
				filename: "cover.png",
				url: "https://example.com/cover.png",
			});
			expect(r.content[0]?.text).toBe("native result");
			expect(Boolean(r.isError)).toBe(toolError);
			expect(methods).toEqual([
				"server/discover",
				"initialize",
				"notifications/initialized",
				"tools/call",
			]);
		},
	);
});

it("preserves native REST error codes and lock details for agents", async () => {
	const ctx: CmsProxyContext = {
		...baseContext,
		internalAuthToken: "internal",
		cmsDispatch: {
			fetch: async () =>
				Response.json(
					{
						success: false,
						error: {
							code: "ENTRY_LOCKED",
							message: "Ada is holding this entry",
							details: { holder: "Ada" },
						},
					},
					{ status: 409 },
				),
		} as unknown as Fetcher,
	};
	const result = await callCmsRest(ctx, "content_update", {
		collection: "pages",
		id: "home",
		_rev: "read-revision",
		data: { title: "Edit" },
	});
	expect(result.isError).toBe(true);
	expect(result._meta).toEqual({
		code: "ENTRY_LOCKED",
		details: { holder: "Ada" },
	});
});

describe("native tenant tool metadata", () => {
	it("returns installed metadata through the shared negotiated tenant session", async () => {
		const methods: string[] = [];
		const tools = [
			{
				name: "content_update",
				inputSchema: { type: "object", required: ["_rev"] },
				annotations: { destructiveHint: false },
			},
		];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					expect(request.headers.get("authorization")).toBe(
						"Bearer ec_pat_secret",
					);
					const body = (await request.json()) as {
						method: string;
						id?: unknown;
					};
					methods.push(body.method);
					return (
						emdashMcpHandshake(body) ??
						Response.json({ jsonrpc: "2.0", id: body.id, result: { tools } })
					);
				},
			} as unknown as Fetcher,
		};
		const result = await listTenantMcpTools(ctx);
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0]!.text)).toEqual({ tools });
		expect(
			(result as { structuredContent?: unknown }).structuredContent,
		).toEqual({ tools });
		expect(methods).toEqual([...EMDASH_HANDSHAKE, "tools/list"]);
	});
	it.each([{ humanAuthRequired: true }, { forwardedAuth: "aaa.bbb.ccc" }])(
		"does not borrow the service PAT for a human metadata read",
		async (human) => {
			let calls = 0;
			const ctx: CmsProxyContext = {
				...baseContext,
				...human,
				serviceApiKey: "ec_pat_secret",
				cmsDispatch: {
					fetch: async () => {
						calls++;
						return Response.json({});
					},
				} as unknown as Fetcher,
			};
			const result = await listTenantMcpTools(ctx);
			expect(result._meta?.code).toBe("CMS_MCP_HUMAN_METADATA_UNAVAILABLE");
			expect(calls).toBe(0);
		},
	);
});

describe("Fixed native Forms forwarding", () => {
	const identity = {
		siteId: "site-one",
		slug: "tedix",
		bundleEtag: "bundle-one",
		tenantId: "tenant-one",
		subject: "editor-one",
		email: "editor@example.com",
		name: "Editor",
		role: 40 as const,
	};
	it("retains human assertions and propagates native REST permission failures without PAT or retry", async () => {
		const calls: string[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			mediaMaintenanceAuthorized: true,
			humanAuthRequired: true,
			humanIdentity: identity,
			internalAuthToken: "trusted",
			serviceApiKey: "ec_pat_must_not_be_used",
			cmsDispatch: {
				fetch: async (request: Request) => {
					expect(request.headers.get("authorization")).toBeNull();
					expect(request.headers.get("X-Tedix-CMS-Forwarded-User-Auth")).toBe(
						"trusted",
					);
					expect(
						request.headers.get("X-Tedix-CMS-Human-Identity"),
					).toBeTruthy();
					expect(request.method).toBe("POST");
					expect(new URL(request.url).pathname).toBe(
						"/_emdash/api/plugins/emdash-forms/submissions/list",
					);
					calls.push("list_form_submissions");
					expect(await request.json()).toEqual({
						formId: "form-one",
						limit: 20,
					});
					return Response.json(
						{
							success: false,
							error: { code: "FORBIDDEN", message: "Native permission denied" },
						},
						{ status: 403 },
					);
				},
			} as unknown as Fetcher,
		};
		const result = await callCmsFormsTool(ctx, "list_form_submissions", {
			formId: "form-one",
			limit: 20,
		});
		expect(calls).toEqual(["list_form_submissions"]);
		expect(result.isError).toBe(true);
		expect(result._meta?.code).toBe("FORBIDDEN");
	});
	it("refuses arbitrary names, missing authority and missing human assertions before dispatch", async () => {
		let calls = 0;
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_service",
			cmsDispatch: {
				fetch: async () => {
					calls++;
					return Response.json({});
				},
			} as unknown as Fetcher,
		};
		expect(
			(
				await callCmsFormsTool(
					{ ...ctx, mediaMaintenanceAuthorized: true },
					"content_publish",
					{},
				)
			).isError,
		).toBe(true);
		expect((await callCmsFormsTool(ctx, "list_forms", {})).isError).toBe(true);
		expect(
			(
				await callCmsFormsTool(
					{ ...ctx, mediaMaintenanceAuthorized: true, humanAuthRequired: true },
					"list_forms",
					{},
				)
			).isError,
		).toBe(true);
		expect(calls).toBe(0);
	});
	it("registers fixed operations and sends narrow consent PUT under human authority", async () => {
		const tools = new Map<
			string,
			{ definition: any; handler: (args: any) => Promise<any> }
		>();
		const requests: Request[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			humanAuthRequired: true,
			humanIdentity: identity,
			internalAuthToken: "trusted",
			serviceApiKey: "ec_pat_unused",
			mediaMaintenanceAuthorized: true,
			cmsDispatch: {
				fetch: async (request: Request) => {
					requests.push(request);
					return Response.json({
						success: true,
						data: { enabled: true, tools: [] },
					});
				},
			} as unknown as Fetcher,
		};
		registerCmsProxyTools(
			{
				registerTool: (name: string, definition: any, handler: any) =>
					tools.set(name, { definition, handler }),
			} as any,
			ctx,
		);
		for (const name of [
			"list_forms",
			"create_form",
			"update_form",
			"list_form_submissions",
			"get_form_submission",
			"set_plugin_mcp",
		])
			expect(tools.has(name)).toBe(true);
		for (const name of [
			"list_forms",
			"list_form_submissions",
			"get_form_submission",
		])
			expect(tools.get(name)!.definition.annotations.readOnlyHint).toBe(true);
		expect(
			[...tools.keys()].filter(
				(name) => name.includes("-") || name.includes("__"),
			),
		).toEqual([]);
		expect(tools.has("import_form_submissions")).toBe(false);
		expect(tools.has("delete_migrated_leads")).toBe(false);
		expect(tools.has("list_legacy_leads")).toBe(false);
		expect(tools.has("call_native_plugin_tool")).toBe(false);
		expect(
			tools.get("set_plugin_mcp")!.definition.inputSchema.safeParse({
				id: "arbitrary-plugin",
				enabled: true,
			}).success,
		).toBe(false);
		await tools
			.get("set_plugin_mcp")!
			.handler({ id: "emdash-forms", enabled: true });
		expect(requests).toHaveLength(1);
		expect(requests[0]!.method).toBe("PUT");
		expect(new URL(requests[0]!.url).pathname).toBe(
			"/_emdash/api/admin/plugins/emdash-forms/mcp",
		);
		expect(requests[0]!.headers.get("authorization")).toBeNull();
		expect(await requests[0]!.json()).toEqual({ enabled: true });
	});
});

it("enforces installed native Forms permissions and token scopes before handler execution", async () => {
	const { dispatchPluginApiRequest } = await import(
		new URL(
			"../../templates/tedix/node_modules/emdash/src/plugins/http-route-dispatch.ts",
			import.meta.url,
		).href
	);
	const { default: forms } = await import(
		new URL(
			"../../templates/tedix/node_modules/@emdash-cms/plugin-forms/src/index.ts",
			import.meta.url,
		).href
	);
	const plugin = forms();
	let dispatched = 0;
	const runtime = {
		getPluginRouteMeta: (_id: string, path: string) =>
			plugin.routes[path.replace(/^\//, "")],
		handlePluginApiRoute: async (...args: any[]) => {
			dispatched++;
			expect(args[4].id).toBe("human-admin");
			return { success: true, data: { items: [] } };
		},
	};
	const request = new Request(
		"https://tedix.cms.tedix.dev/_emdash/api/plugins/emdash-forms/forms/list",
		{ method: "POST", headers: { "X-EmDash-Request": "1" }, body: "{}" },
	);
	const ctx = {
		runtime,
		pluginId: "emdash-forms",
		path: "/forms/list",
		request,
	};
	for (const role of [10, 40]) {
		const response = await dispatchPluginApiRequest({
			...ctx,
			user: { id: "human-viewer", role },
		});
		expect(response.status).toBe(403);
		expect((await response.json()).error.code).toBe("FORBIDDEN");
	}
	const denied = await dispatchPluginApiRequest({
		...ctx,
		user: { id: "service", role: 50 },
		tokenScopes: ["content:read"],
	});
	expect(denied.status).toBe(403);
	expect(dispatched).toBe(0);
	const allowed = await dispatchPluginApiRequest({
		...ctx,
		user: { id: "human-admin", role: 50 },
	});
	expect(allowed.status).toBe(200);
	expect(dispatched).toBe(1);
});

describe("Native existing-site onboarding forwarding", () => {
	it("registers one empty-input REST operation and preserves the human administrator", async () => {
		const tools = new Map<
			string,
			{ definition: any; handler: (args: any) => Promise<any> }
		>();
		const requests: Request[] = [];
		const identity = {
			siteId: "site-one",
			slug: "tedix",
			bundleEtag: "bundle-one",
			tenantId: "tenant-one",
			subject: "owner-one",
			email: "owner@example.com",
			name: "Owner",
			role: 50 as const,
		};
		const ctx: CmsProxyContext = {
			...baseContext,
			mediaMaintenanceAuthorized: true,
			humanAuthRequired: true,
			humanIdentity: identity,
			internalAuthToken: "trusted",
			serviceApiKey: "ec_pat_never_used",
			cmsDispatch: {
				fetch: async (request: Request) => {
					requests.push(request);
					expect(request.headers.get("authorization")).toBeNull();
					expect(request.headers.get("X-Tedix-CMS-Forwarded-User-Auth")).toBe(
						"trusted",
					);
					expect(request.headers.get("X-Tedix-CMS-Human-Identity")).toBe(
						encodeCmsHumanIdentity(identity),
					);
					expect(request.method).toBe("POST");
					expect(new URL(request.url).pathname).toBe(
						"/_emdash/api/tedix/complete-existing-setup",
					);
					expect(await request.json()).toEqual({});
					return Response.json({
						success: true,
						data: { setupComplete: true, alreadyComplete: false },
					});
				},
			} as unknown as Fetcher,
		};
		registerCmsProxyTools(
			{
				registerTool: (name: string, definition: any, handler: any) =>
					tools.set(name, { definition, handler }),
			} as any,
			ctx,
		);
		const operation = tools.get("complete_existing_setup")!;
		expect(operation.definition.annotations.idempotentHint).toBe(true);
		const result = await operation.handler({});
		expect(result.structuredContent).toEqual({
			success: true,
			data: { setupComplete: true, alreadyComplete: false },
		});
		expect(requests).toHaveLength(1);
	});
	it("denies missing platform authority or human identity without dispatch or PAT fallback", async () => {
		let calls = 0;
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_must_not_be_used",
			internalAuthToken: "trusted",
			cmsDispatch: {
				fetch: async () => {
					calls++;
					return Response.json({});
				},
			} as unknown as Fetcher,
		};
		expect((await completeExistingCmsSetup(ctx)).isError).toBe(true);
		expect(
			(
				await completeExistingCmsSetup({
					...ctx,
					mediaMaintenanceAuthorized: true,
					humanAuthRequired: true,
				})
			).isError,
		).toBe(true);
		expect(calls).toBe(0);
	});
	it("preserves native administrator permission failure without retry", async () => {
		let calls = 0;
		const ctx: CmsProxyContext = {
			...baseContext,
			mediaMaintenanceAuthorized: true,
			forwardedAuth: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJlZGl0b3IifQ.sig",
			cmsDispatch: {
				fetch: async () => {
					calls++;
					return Response.json(
						{
							success: false,
							error: {
								code: "FORBIDDEN",
								message: "Site administrator required",
							},
						},
						{ status: 403 },
					);
				},
			} as unknown as Fetcher,
		};
		const result = await completeExistingCmsSetup(ctx);
		expect(result.isError).toBe(true);
		expect(result._meta?.code).toBe("FORBIDDEN");
		expect(calls).toBe(1);
	});
});

describe("native revision restore lock override", () => {
	it("exposes only a boolean and forwards REST override only when explicitly true", async () => {
		const definitions = new Map<string, any>();
		registerCmsProxyTools(
			{
				registerTool: (name: string, definition: any) =>
					definitions.set(name, definition),
			} as any,
			baseContext,
		);
		const schema = definitions.get("revision_restore").inputSchema;
		expect(schema.safeParse({ revisionId: "revision" }).success).toBe(true);
		expect(
			schema.safeParse({ revisionId: "revision", overrideLock: true }).success,
		).toBe(true);
		expect(
			schema.safeParse({ revisionId: "revision", overrideLock: "true" })
				.success,
		).toBe(false);
		const bodies: unknown[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			forwardedAuth: "aaa.bbb.ccc",
			cmsDispatch: {
				fetch: async (request: Request) => {
					expect(new URL(request.url).pathname).toBe(
						"/_emdash/api/revisions/revision/restore",
					);
					bodies.push(await request.json());
					return Response.json({ success: true, data: {} });
				},
			} as Fetcher,
		};
		for (const overrideLock of [undefined, false, true])
			await callCmsRest(ctx, "revision_restore", {
				revisionId: "revision",
				overrideLock,
			});
		expect(bodies).toEqual([{}, {}, { overrideLock: true }]);
	});
});
