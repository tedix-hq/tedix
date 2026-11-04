import { describe, expect, it, vi } from "vite-plus/test";
import {
	prepareTenantPolicyMount,
	resolveFreshPolicyMount,
	resolvePolicyMountPath,
	prepareTenantIdentityProfileMount,
	prepareTenantNativePolicyMount,
	acceptsEmptyProfileArguments,
	tenantPolicyLogicalToolDigest,
	tenantPolicyCrossMountDigest,
	tenantPolicyEffectiveToolDigest,
	tenantPolicyMountDescriptor,
} from "./tenant-policy-mount";
import { buildHomeSurfaceTools } from "./home-surface-tools";
import { buildAggregateTediTools } from "./aggregate-tedis";
import type { AppTool } from "./server-context";

const mocks = vi.hoisted(() => ({
	resolve: vi.fn(),
	getApp: vi.fn(),
	listRuntimeMetaBySlugs: vi.fn(),
}));
vi.mock("../aggregate-surface", () => ({
	aggregateAndPrefixTools: mocks.resolve,
}));
vi.mock("../lib/api-client", () => ({
	getApiClient: () => ({
		apps: {
			getByIdWithTools: mocks.getApp,
			getPolicyMountMetadata: mocks.getApp,
		},
		tedis: { listRuntimeMetaBySlugs: mocks.listRuntimeMetaBySlugs },
	}),
}));

const instance = "00000000-0000-4000-8000-000000000001";
const base = {
	id: "tool-row",
	policyMountAppIds: ["root", "source"],
	toolId: "mounted__edit",
	inputSchema: { type: "object", properties: {} },
	annotations: { destructiveHint: true },
	config: {
		transport: "mcp",
		mcpToolName: "edit",
		_sourceAppId: "source",
		_multiOrgOrganizationId: "org",
		auth: {
			type: "connection",
			connectionId: "provider",
			credentialScope: "tenant",
			connectionInstanceId: instance,
		},
	},
} as unknown as AppTool;
const input = {
	organizationId: "org",
	rootAppId: "root",
	sourceAppId: "source",
	sourceToolId: "edit",
	mountAppIds: ["root", "source"],
	tool: base,
};

describe("tenant policy mount descriptor", () => {
	it("compares direct and aggregate source provenance without dropping auth or connection binding", async () => {
		const direct = {
			...base,
			authRequired: true,
			visibility: "private",
			config: {
				transport: "mcp",
				mcpToolName: "edit",
				auth: { type: "connection", connectionId: "provider" },
			},
		} as unknown as AppTool;
		const mounted = {
			...direct,
			toolId: "gateway__edit",
			config: {
				...direct.config,
				_sourceAppId: "source",
				_sourceAuthRequired: true,
				_sourceVisibility: "private",
				_aggregateNamespace: "gateway",
			},
		} as AppTool;
		expect(await tenantPolicyCrossMountDigest(mounted)).toBe(
			await tenantPolicyCrossMountDigest(direct),
		);
		expect(
			await tenantPolicyCrossMountDigest({ ...mounted, authRequired: false }),
		).not.toBe(await tenantPolicyCrossMountDigest(direct));
		expect(
			await tenantPolicyCrossMountDigest({
				...mounted,
				meta: {
					"com.tedix/policy": {
						riskTier: "high_impact_write",
						blastRadius: "tenant",
					},
				},
			}),
		).not.toBe(await tenantPolicyCrossMountDigest(direct));
		expect(
			await tenantPolicyCrossMountDigest({
				...mounted,
				config: {
					...mounted.config,
					_aggregateConnectionLabel: "another-account",
				},
			}),
		).not.toBe(await tenantPolicyCrossMountDigest(direct));
	});
	it("requires a supported schema that accepts an empty input", () => {
		expect(
			acceptsEmptyProfileArguments({
				type: "object",
				properties: {},
				required: [],
			}),
		).toBe(true);
		expect(
			acceptsEmptyProfileArguments({
				$schema: "https://json-schema.org/draft/2020-12/schema",
				type: "object",
				properties: {
					instructions_version: { type: "string" },
					telemetry: {
						type: "object",
						properties: { intent: { type: "string" } },
					},
				},
				additionalProperties: false,
			}),
		).toBe(true);
		expect(
			acceptsEmptyProfileArguments({
				$schema: "https://example.invalid/unknown-dialect",
				type: "object",
			}),
		).toBe(false);
		expect(
			acceptsEmptyProfileArguments({
				$schema: "https://json-schema.org/draft/2020-12/schema",
				type: "object",
				minProperties: 1,
			}),
		).toBe(false);
		expect(
			acceptsEmptyProfileArguments({
				$schema: "https://json-schema.org/draft/2020-12/schema",
				type: "object",
				not: {},
			}),
		).toBe(false);
		expect(
			acceptsEmptyProfileArguments({ type: "object", required: ["x"] }),
		).toBe(false);
		expect(acceptsEmptyProfileArguments({ type: "object", not: {} })).toBe(
			false,
		);
		expect(
			acceptsEmptyProfileArguments({
				type: "object",
				additionalProperties: "invalid",
			}),
		).toBe(false);
	});
	it("binds the actual named account and changes when the effective tool changes", async () => {
		const descriptor = await tenantPolicyMountDescriptor(input);
		expect(descriptor).toMatchObject({
			sourceToolRowId: "tool-row",
			connectionInstanceId: instance,
			credentialScope: "tenant",
		});
		const changed = await tenantPolicyMountDescriptor({
			...input,
			tool: {
				...base,
				inputSchema: {
					type: "object",
					properties: { changed: { type: "string" } },
				},
			},
		});
		expect(changed?.effectiveToolDigest).not.toBe(
			descriptor?.effectiveToolDigest,
		);
	});

	it("rejects mismatched mounted identity and non-exact credential selection", async () => {
		expect(
			await tenantPolicyMountDescriptor({ ...input, sourceAppId: "other" }),
		).toBeNull();
		expect(
			await tenantPolicyMountDescriptor({ ...input, organizationId: "other" }),
		).toBeNull();
		const invalidAuth: Record<string, string>[] = [
			{ type: "connection", connectionId: "provider", scope: "tenant" },
			{
				type: "connection",
				connectionId: "provider",
				connectionInstanceId: instance,
				scope: "hybrid",
			},
		];
		for (const auth of invalidAuth) {
			expect(
				await tenantPolicyMountDescriptor({
					...input,
					tool: { ...base, config: { ...base.config, auth } },
				}),
			).toBeNull();
		}
	});

	it("uses a fresh resolution and rejects source rows outside the selected organization", async () => {
		mocks.getApp.mockReset();
		mocks.resolve.mockReset();
		let sourceOrganization = "org";
		mocks.getApp.mockImplementation(async ({ appId }: { appId: string }) =>
			appId === "root"
				? {
						app: { id: "root", slug: "gateway", organizationId: "org" },
						tools: [],
					}
				: {
						app: { id: "source", organizationId: sourceOrganization },
						tools: [{ id: "tool-row", toolId: "edit" }],
					},
		);
		mocks.resolve.mockResolvedValue({ tools: [base] });
		const request = {
			organizationId: "org",
			rootAppId: "root",
			mountedToolId: base.toolId,
			env: {} as CloudflareEnv,
			ctx: {} as ExecutionContext,
		};
		expect(await prepareTenantPolicyMount(request)).toMatchObject({
			descriptor: { sourceAppId: "source", sourceToolRowId: "tool-row" },
		});
		expect(mocks.resolve.mock.calls[0]?.[5]).toEqual({
			value: "tenant-policy-fresh",
			cacheable: false,
		});
		sourceOrganization = "another-org";
		expect(await prepareTenantPolicyMount(request)).toBeNull();
	});

	it("resolves the canonical generated Home tool without inventing a stored row", async () => {
		const ask = buildHomeSurfaceTools().find((tool) => tool.toolId === "ask")!;
		mocks.getApp.mockResolvedValue({
			app: {
				id: "root",
				slug: "gateway",
				organizationId: "org",
				metadata: { mcpConfig: { aggregateApps: [{ slug: "mounted" }] } },
			},
			tools: [],
		});
		mocks.resolve.mockResolvedValue({ tools: [], degraded: false });
		const request = {
			organizationId: "org",
			rootAppId: "root",
			mountedToolId: "ask",
			env: {} as CloudflareEnv,
		};
		expect(await resolveFreshPolicyMount(request)).toMatchObject({
			tool: ask,
			sourceAppId: "root",
			sourceToolId: "ask",
			mountAppIds: ["root"],
			sourceKind: "home-surface",
		});
		expect(await prepareTenantNativePolicyMount(request)).toMatchObject({
			descriptor: {
				sourceToolRowId: ask.id,
				effectiveToolDigest: await tenantPolicyEffectiveToolDigest(ask),
			},
		});
	});

	it("rejects a generated Home tool that collides with an aggregate tedi", async () => {
		const home = buildHomeSurfaceTools().find(
			(tool) => tool.toolId === "home__respond_home_approval",
		)!;
		mocks.getApp.mockResolvedValue({
			app: {
				id: "root",
				slug: "gateway",
				organizationId: "org",
				metadata: {
					mcpConfig: {
						aggregateApps: [{ slug: "mounted" }],
						aggregateTedis: [{ slug: "ceo", namespace: "home" }],
					},
				},
			},
			tools: [],
		});
		mocks.listRuntimeMetaBySlugs.mockResolvedValue({
			data: [
				{
					slug: "ceo",
					id: "tedi-id",
					organizationId: "org",
					runtimeKind: "agent",
					runtimeState: "active",
					status: "active",
				},
			],
		});
		mocks.resolve.mockResolvedValue({ tools: [], degraded: false });
		expect(
			await resolveFreshPolicyMount({
				organizationId: "org",
				rootAppId: "root",
				mountedToolId: home.toolId,
				env: { MCP_URL: "https://mcp.tedix.dev" } as CloudflareEnv,
			}),
		).toBeNull();
		mocks.listRuntimeMetaBySlugs.mockResolvedValue({ data: [] });
		expect(
			await resolveFreshPolicyMount({
				organizationId: "org",
				rootAppId: "root",
				mountedToolId: home.toolId,
				env: { MCP_URL: "https://mcp.tedix.dev" } as CloudflareEnv,
			}),
		).toBeNull();
		mocks.listRuntimeMetaBySlugs.mockResolvedValue({
			data: [
				{
					slug: "ceo",
					id: "foreign-tedi",
					organizationId: "another-org",
					runtimeKind: "agent",
					runtimeState: "active",
					status: "active",
				},
			],
		});
		expect(
			await resolveFreshPolicyMount({
				organizationId: "org",
				rootAppId: "root",
				mountedToolId: home.toolId,
				env: { MCP_URL: "https://mcp.tedix.dev" } as CloudflareEnv,
			}),
		).toBeNull();
	});

	it("rejects every Home collision in real hydrated and unhydrated tedi projections", async () => {
		const env = { MCP_URL: "https://mcp.tedix.dev" } as CloudflareEnv;
		const entry = { slug: "ceo", namespace: "home" };
		const active = {
			slug: "ceo",
			id: "tedi-id",
			organizationId: "org",
			runtimeKind: "agent" as const,
			runtimeState: "active",
			status: "active",
		};
		const homeIds = new Set(buildHomeSurfaceTools().map((tool) => tool.toolId));
		const unhydrated = buildAggregateTediTools([entry], env);
		const hydrated = buildAggregateTediTools(
			[
				{
					...entry,
					tediId: active.id,
					organizationId: "org",
					runtimeKind: "agent",
				},
			],
			env,
		);
		const unhydratedIds = new Set(unhydrated.map((tool) => tool.toolId));
		const foreignHydrated = buildAggregateTediTools(
			[
				{
					...entry,
					tediId: active.id,
					organizationId: "another-org",
					runtimeKind: "agent",
				},
			],
			env,
		);
		const hydratedOnlyCollisions = hydrated.filter(
			(tool) => homeIds.has(tool.toolId) && !unhydratedIds.has(tool.toolId),
		);
		expect(hydratedOnlyCollisions.map((tool) => tool.toolId)).toContain(
			"home__complete_work_item",
		);
		mocks.getApp.mockResolvedValue({
			app: {
				id: "root",
				slug: "gateway",
				organizationId: "org",
				metadata: { mcpConfig: { aggregateTedis: [entry] } },
			},
			tools: [],
		});
		mocks.resolve.mockResolvedValue({ tools: [], degraded: false });
		for (const [rows, served] of [
			[[active], hydrated],
			[[], unhydrated],
			[[{ ...active, organizationId: "another-org" }], foreignHydrated],
		] as const) {
			mocks.listRuntimeMetaBySlugs.mockResolvedValue({ data: rows });
			const intersections = served.filter((tool) => homeIds.has(tool.toolId));
			expect(intersections.length).toBeGreaterThan(0);
			for (const tool of intersections) {
				expect(
					await resolveFreshPolicyMount({
						organizationId: "org",
						rootAppId: "root",
						mountedToolId: tool.toolId,
						env,
					}),
				).toBeNull();
			}
		}
		for (const rows of [
			[],
			[{ ...active, organizationId: "another-org" }],
			[{ ...active, status: "paused" }],
		]) {
			mocks.listRuntimeMetaBySlugs.mockResolvedValue({ data: rows });
			expect(
				await resolveFreshPolicyMount({
					organizationId: "org",
					rootAppId: "root",
					mountedToolId: "home__complete_work_item",
					env,
				}),
			).toBeNull();
		}
		mocks.listRuntimeMetaBySlugs.mockRejectedValueOnce(
			new Error("unavailable"),
		);
		await expect(
			resolveFreshPolicyMount({
				organizationId: "org",
				rootAppId: "root",
				mountedToolId: "home__complete_work_item",
				env,
			}),
		).rejects.toThrow("unavailable");
	});

	it("rechecks generated Home exposure and refuses stored-row shadows", async () => {
		const ask = buildHomeSurfaceTools().find((tool) => tool.toolId === "ask")!;
		const root = {
			id: "root",
			slug: "gateway",
			organizationId: "org",
			metadata: { mcpConfig: { aggregateApps: [{ slug: "mounted" }] } },
		};
		const request = {
			organizationId: "org",
			rootAppId: "root",
			mountedToolId: "ask",
			env: {} as CloudflareEnv,
		};
		mocks.resolve.mockResolvedValue({ tools: [], degraded: false });
		mocks.getApp.mockResolvedValue({ app: root, tools: [] });
		expect(await resolveFreshPolicyMount(request)).not.toBeNull();
		mocks.getApp.mockResolvedValue({
			app: { ...root, metadata: { mcpConfig: { aggregateApps: [] } } },
			tools: [],
		});
		expect(await resolveFreshPolicyMount(request)).toBeNull();
		mocks.getApp.mockResolvedValue({
			app: { ...root, metadata: { mcpConfig: { aggregateApps: [] } } },
			tools: [ask],
		});
		expect(await resolveFreshPolicyMount(request)).toBeNull();
		mocks.getApp.mockResolvedValue({
			app: { ...root, organizationId: "another-org" },
			tools: [],
		});
		expect(await resolveFreshPolicyMount(request)).toBeNull();
		mocks.getApp.mockResolvedValue({ app: null, tools: [] });
		expect(await resolveFreshPolicyMount(request)).toBeNull();
		for (const stored of [
			{ ...ask, id: "stored-row" },
			{ ...ask, toolId: "stored_name" },
			ask,
		]) {
			mocks.getApp.mockResolvedValue({ app: root, tools: [stored] });
			expect(await resolveFreshPolicyMount(request)).toBeNull();
		}
		mocks.getApp.mockRejectedValue(new Error("fresh root unavailable"));
		await expect(resolveFreshPolicyMount(request)).rejects.toThrow(
			"fresh root unavailable",
		);
	});

	it("rebuilds an aggregate tedi mount from the active organization tedi", async () => {
		const entry = { slug: "ceo", namespace: "ceo" };
		const env = { MCP_URL: "https://mcp.tedix.dev" } as CloudflareEnv;
		const generated = buildAggregateTediTools(
			[
				{
					...entry,
					tediId: "tedi-id",
					organizationId: "org",
					runtimeKind: "agent",
				},
			],
			env,
		).find((tool) => tool.toolId === "ceo__work_item_get")!;
		const root = {
			id: "root",
			slug: "gateway",
			organizationId: "org",
			metadata: {
				mcpConfig: {
					aggregateApps: [{ slug: "mounted" }],
					aggregateTedis: [entry],
				},
			},
		};
		mocks.getApp.mockResolvedValue({ app: root, tools: [] });
		mocks.listRuntimeMetaBySlugs.mockResolvedValue({
			data: [
				{
					slug: "ceo",
					id: "tedi-id",
					organizationId: "org",
					runtimeKind: "agent",
					runtimeState: "active",
					status: "active",
				},
			],
		});
		mocks.resolve.mockResolvedValue({ tools: [], degraded: false });
		const request = {
			organizationId: "org",
			rootAppId: "root",
			mountedToolId: generated.toolId,
			env,
		};
		expect(await resolveFreshPolicyMount(request)).toMatchObject({
			tool: generated,
			sourceAppId: "root",
			sourceToolId: generated.toolId,
			mountAppIds: ["root"],
			sourceKind: "aggregate-tedi",
		});
		expect(await prepareTenantNativePolicyMount(request)).toMatchObject({
			descriptor: {
				sourceToolRowId: generated.id,
				effectiveToolDigest: await tenantPolicyEffectiveToolDigest(generated),
			},
		});

		mocks.resolve.mockResolvedValue({ tools: [], degraded: true });
		expect(await resolveFreshPolicyMount(request)).toBeNull();
		mocks.resolve.mockResolvedValue({ tools: [generated], degraded: false });
		expect(await resolveFreshPolicyMount(request)).toBeNull();
		mocks.resolve.mockImplementation(async (entries) =>
			entries[0]?.organizationMount
				? { tools: [], degraded: false }
				: { tools: [generated], degraded: false },
		);
		expect(await resolveFreshPolicyMount(request)).toBeNull();
		mocks.resolve.mockResolvedValue({ tools: [], degraded: false });

		mocks.listRuntimeMetaBySlugs.mockResolvedValue({ data: [] });
		expect(await resolveFreshPolicyMount(request)).toBeNull();
		mocks.listRuntimeMetaBySlugs.mockResolvedValue({
			data: [
				{
					slug: "ceo",
					id: "tedi-id",
					organizationId: "org",
					runtimeKind: "agent",
					runtimeState: "active",
					status: "paused",
				},
			],
		});
		expect(await resolveFreshPolicyMount(request)).toBeNull();
		mocks.getApp.mockResolvedValue({
			app: {
				...root,
				metadata: {
					mcpConfig: {
						aggregateApps: [{ slug: "mounted" }],
						aggregateTedis: [entry, { ...entry }],
					},
				},
			},
			tools: [],
		});
		mocks.listRuntimeMetaBySlugs.mockResolvedValue({
			data: [
				{
					slug: "ceo",
					id: "tedi-id",
					organizationId: "org",
					runtimeKind: "agent",
					runtimeState: "active",
					status: "active",
				},
			],
		});
		expect(await resolveFreshPolicyMount(request)).toBeNull();
		mocks.getApp.mockResolvedValue({ app: root, tools: [] });
		mocks.listRuntimeMetaBySlugs.mockResolvedValue({
			data: [
				{
					slug: "ceo",
					id: "tedi-id",
					organizationId: "another-org",
					runtimeKind: "agent",
					runtimeState: "active",
					status: "active",
				},
			],
		});
		expect(await resolveFreshPolicyMount(request)).toBeNull();
	});

	it("rejects an unresolved tedi alias that collides with an active tedi mount", async () => {
		const env = { MCP_URL: "https://mcp.tedix.dev" } as CloudflareEnv;
		const entries = [
			{ slug: "ceo", namespace: "team", surface: "collaboration" as const },
			{ slug: "cto", namespace: "team", surface: "collaboration" as const },
		] as const;
		const active = {
			slug: "ceo",
			id: "ceo-id",
			organizationId: "org",
			runtimeKind: "agent" as const,
			runtimeState: "active",
			status: "active",
		};
		const foreign = {
			...active,
			slug: "cto",
			id: "foreign-id",
			organizationId: "other-org",
		};
		mocks.getApp.mockResolvedValue({
			app: {
				id: "root",
				slug: "gateway",
				organizationId: "org",
				metadata: { mcpConfig: { aggregateTedis: entries } },
			},
			tools: [],
		});
		mocks.resolve.mockResolvedValue({ tools: [], degraded: false });
		for (const rows of [[active], [active, foreign]]) {
			const liveEntries = [
				{
					...entries[0],
					tediId: active.id,
					organizationId: active.organizationId,
					runtimeKind: "agent" as const,
				},
				...(rows.length === 1
					? [entries[1]!]
					: [
							{
								...entries[1],
								tediId: foreign.id,
								organizationId: foreign.organizationId,
								runtimeKind: "agent" as const,
							},
						]),
			];
			expect(
				buildAggregateTediTools(liveEntries, env).filter(
					(tool) => tool.toolId === "team__ask",
				),
			).toHaveLength(2);
			mocks.listRuntimeMetaBySlugs.mockResolvedValue({ data: rows });
			expect(
				await resolveFreshPolicyMount({
					organizationId: "org",
					rootAppId: "root",
					mountedToolId: "team__ask",
					env,
				}),
			).toBeNull();
		}
	});

	it("resolves the direct gateway layout with fresh host defaults and rejects degraded or ambiguous mounts", async () => {
		let sourceOrganization = "org";
		mocks.getApp.mockImplementation(async ({ appId }: { appId: string }) =>
			appId === "root"
				? {
						app: {
							id: "root",
							slug: "gateway",
							organizationId: "org",
							metadata: {
								mcpConfig: {
									aggregateApps: [{ slug: "mounted", appId: "source" }],
									connectionProviderId: "provider",
									connectionScope: "tenant",
								},
							},
						},
						tools: [],
					}
				: sourceVisible
					? {
							app: { id: "source", organizationId: sourceOrganization },
							tools: [{ id: "tool-row", toolId: "edit" }],
						}
					: { app: null, tools: [] },
		);
		let degraded = false,
			duplicate = false,
			sourceVisible = true;
		mocks.resolve.mockImplementation(async (entries) =>
			entries[0]?.organizationMount
				? { tools: [{ ...base, toolId: "gateway__mounted__edit" }] }
				: {
						degraded,
						tools: Array(duplicate ? 2 : 1).fill({
							...base,
							policyMountAppIds: ["source"],
						}),
					},
		);
		const request = {
			organizationId: "org",
			rootAppId: "root",
			mountedToolId: base.toolId,
			env: {} as CloudflareEnv,
		};
		expect(await resolveFreshPolicyMount(request)).toMatchObject({
			sourceAppId: "source",
			sourceToolId: "edit",
			mountAppIds: ["root", "source"],
		});
		expect(mocks.resolve.mock.lastCall?.[0]).toEqual([
			expect.objectContaining({
				slug: "mounted",
				appId: "source",
				hostOrganizationId: "org",
				connectionProviderId: "provider",
				connectionScope: "tenant",
			}),
		]);
		expect(mocks.resolve.mock.lastCall?.[5]).toEqual({
			value: "tenant-policy-fresh",
			cacheable: false,
		});
		degraded = true;
		expect(await resolveFreshPolicyMount(request)).toBeNull();
		degraded = false;
		duplicate = true;
		expect(await resolveFreshPolicyMount(request)).toBeNull();
		duplicate = false;
		sourceOrganization = "other-org";
		expect(await resolveFreshPolicyMount(request)).toBeNull();
		expect(await resolvePolicyMountPath(request)).toBeNull();
		sourceVisible = false;
		expect(await resolveFreshPolicyMount(request)).toBeNull();
		expect(await resolvePolicyMountPath(request)).toMatchObject({
			sourceAppId: "source",
			mountAppIds: ["root", "source"],
			sourceKind: "foreign-source",
		});
	});

	it("prepares only an enabled RPC mount from the selected organization", async () => {
		mocks.getApp.mockImplementation(async ({ appId }: { appId: string }) =>
			appId === "root"
				? {
						app: { id: "root", slug: "gateway", organizationId: "org" },
						tools: [],
					}
				: {
						app: { id: "source", organizationId: "org" },
						tools: [{ id: "tool-row", toolId: "edit" }],
					},
		);
		const rpc = {
			...base,
			config: {
				transport: "rpc",
				endpoint: "tools/example",
				_sourceAppId: "source",
			},
		};
		mocks.resolve.mockResolvedValue({ tools: [rpc] });
		const request = {
			organizationId: "org",
			rootAppId: "root",
			mountedToolId: base.toolId,
			env: {} as CloudflareEnv,
		};
		expect(await prepareTenantNativePolicyMount(request)).toMatchObject({
			descriptor: {
				sourceAppId: "source",
				sourceToolRowId: "tool-row",
				endpoint: "tools/example",
				transport: "rpc",
			},
		});
		mocks.resolve.mockResolvedValue({ tools: [{ ...rpc, enabled: false }] });
		expect(await prepareTenantNativePolicyMount(request)).toBeNull();
	});

	it("binds a replay to the same source, arguments schema and verified account across mount aliases", async () => {
		const credential = {
			organizationId: "org",
			providerId: "provider",
			scope: "tenant" as const,
			connectionInstanceId: instance,
		};
		const call = {
			organizationId: "org",
			sourceAppId: "source",
			sourceToolId: "edit",
			tool: base,
			credential,
			accountRevisionDigest: "a".repeat(64),
		};
		const initial = await tenantPolicyLogicalToolDigest(call);
		const replay = {
			...base,
			toolId: "other__edit",
			config: {
				...base.config,
				_aggregateNamespace: "different",
				_multiOrgOrganizationId: "org",
			},
		};
		expect(await tenantPolicyLogicalToolDigest({ ...call, tool: replay })).toBe(
			initial,
		);
		expect(
			await tenantPolicyLogicalToolDigest({
				...call,
				credential: {
					...credential,
					connectionInstanceId: "00000000-0000-4000-8000-000000000002",
				},
			}),
		).not.toBe(initial);
		expect(
			await tenantPolicyLogicalToolDigest({
				...call,
				credential: { ...credential, connectionInstanceId: undefined },
			}),
		).toBeNull();
		expect(
			await tenantPolicyLogicalToolDigest({ ...call, sourceAppId: "other" }),
		).toBeNull();
	});

	it("prepares a hybrid profile snapshot without disclosing its endpoint or granting policy authority", async () => {
		mocks.getApp.mockImplementation(async ({ appId }: { appId: string }) =>
			appId === "root"
				? {
						app: { id: "root", slug: "gateway", organizationId: "org" },
						tools: [],
					}
				: {
						app: { id: "source", organizationId: "org" },
						tools: [{ id: "tool-row", toolId: "edit" }],
					},
		);
		const hybrid = {
			...base,
			config: {
				...base.config,
				mcpServerUrl: "https://private.example/mcp?secret=sample",
				auth: {
					type: "connection",
					connectionId: "provider",
					credentialScope: "hybrid",
					credentialPreference: "user-first",
				},
			},
		};
		mocks.resolve.mockResolvedValue({ tools: [hybrid] });
		const request = {
			organizationId: "org",
			rootAppId: "root",
			mountedToolId: base.toolId,
			env: {} as CloudflareEnv,
		};
		const prepared = await prepareTenantIdentityProfileMount(request);
		expect(prepared?.descriptor).toMatchObject({
			connectionScope: "hybrid",
			credentialPreference: "user-first",
			sourceToolId: "edit",
		});
		expect(JSON.stringify(prepared)).not.toContain("private.example");
		expect(await prepareTenantPolicyMount(request)).toBeNull();
	});
});
