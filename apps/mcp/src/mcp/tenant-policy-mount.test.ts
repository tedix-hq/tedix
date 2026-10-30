import { describe, expect, it, vi } from "vite-plus/test";
import {
	prepareTenantPolicyMount,
	prepareTenantIdentityProfileMount,
	prepareTenantNativePolicyMount,
	acceptsEmptyProfileArguments,
	tenantPolicyLogicalToolDigest,
	tenantPolicyCrossMountDigest,
	tenantPolicyMountDescriptor,
} from "./tenant-policy-mount";
import type { AppTool } from "./server-context";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), getApp: vi.fn() }));
vi.mock("../aggregate-surface", () => ({
	aggregateAndPrefixTools: mocks.resolve,
}));
vi.mock("../lib/api-client", () => ({
	getApiClient: () => ({ apps: { getByIdWithTools: mocks.getApp } }),
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
