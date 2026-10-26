import { contentUpdateBody, calendarQuery } from "emdash/api/schemas";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	getCmsSiteOverview,
	pluginRegistrySignalSummary,
	registryStatus,
} from "./cms-proxy-inspection";
import { type CmsProxyContext } from "./cms-proxy-runtime";
import {
	callCmsRest,
	callCmsTransferRest,
	menuSetItems,
} from "./cms-proxy-rest";
import { clearTenantMcpEras } from "./cms-proxy-tenant-mcp";
import { registerCmsProxyTools } from "./cms-proxy-tools";

import {
	baseContext,
	emdashMcpHandshake,
	EMDASH_HANDSHAKE,
} from "./__tests__/cms-proxy-fixtures";

// Each test starts without a remembered tenant MCP era, so the first native
// call pays the discover probe exactly as a cold isolate does.
beforeEach(() => clearTenantMcpEras());

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
