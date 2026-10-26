import { beforeEach, describe, expect, it } from "vite-plus/test";
import { callSandboxFreeCmsProxyTool } from "./cms-proxy";
import { type CmsProxyContext } from "./cms-proxy-runtime";
import { callCmsRest } from "./cms-proxy-rest";
import {
	clearTenantMcpEras,
	shouldForwardCmsRestToTenantMcp,
} from "./cms-proxy-tenant-mcp";
import { registerCmsProxyTools } from "./cms-proxy-tools";
import { encodeCmsHumanIdentity } from "./cms-human-auth";

import {
	baseContext,
	emdashMcpHandshake,
	EMDASH_HANDSHAKE,
} from "./__tests__/cms-proxy-fixtures";

// Each test starts without a remembered tenant MCP era, so the first native
// call pays the discover probe exactly as a cold isolate does.
beforeEach(() => clearTenantMcpEras());

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
