import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	setAttribute: vi.fn(),
	getOrganizationByDescopeId: vi.fn(),
	getMemberByUserId: vi.fn(),
	getOrganizationAggregatorGateways: vi.fn(),
	loadByUserId: vi.fn(),
	searchConsents: vi.fn(),
	deleteConsents: vi.fn(),
	searchDescopeMcpServerClients: vi.fn(),
	loadDescopeMcpServer: vi.fn(),
	listMcpConsentSelections: vi.fn(),
	disableMcpConsentSelection: vi.fn(),
	getMcpConsentSelection: vi.fn(),
	getMcpConsentPending: vi.fn(),
	stageMcpConsentPending: vi.fn(),
	promoteMcpConsentPending: vi.fn(),
	replaceMcpConsentSelection: vi.fn(),
	getMcpConsentResource: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
	tracing: {
		enterSpan: async (
			_name: string,
			callback: (span: {
				setAttribute: typeof mocks.setAttribute;
			}) => Promise<unknown>,
		) => callback({ setAttribute: mocks.setAttribute }),
	},
}));

vi.mock("@tedix/db/queries/mcp-consent", () => ({
	listMcpConsentSelections: mocks.listMcpConsentSelections,
	disableMcpConsentSelection: mocks.disableMcpConsentSelection,
	getMcpConsentSelection: mocks.getMcpConsentSelection,
	getMcpConsentPending: mocks.getMcpConsentPending,
	stageMcpConsentPending: mocks.stageMcpConsentPending,
	promoteMcpConsentPending: mocks.promoteMcpConsentPending,
	replaceMcpConsentSelection: mocks.replaceMcpConsentSelection,
	getMcpConsentResource: mocks.getMcpConsentResource,
}));

vi.mock("@tedix/auth/aih-client", () => ({
	searchDescopeMcpServerClients: mocks.searchDescopeMcpServerClients,
	loadDescopeMcpServer: mocks.loadDescopeMcpServer,
}));

vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationByDescopeId: mocks.getOrganizationByDescopeId,
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByUserId: mocks.getMemberByUserId,
	getOrganizationAggregatorGateways: mocks.getOrganizationAggregatorGateways,
}));
vi.mock("@tedix/auth/client", () => ({
	getManagementClient: () => ({
		management: {
			user: { loadByUserId: mocks.loadByUserId },
			inboundApplication: {
				searchConsents: mocks.searchConsents,
				deleteConsents: mocks.deleteConsents,
			},
		},
	}),
}));

const orgIds = [
	"00000000-0000-4000-8000-000000000001",
	"00000000-0000-4000-8000-000000000002",
];
const tenantIds = ["tenant-1", "tenant-2"];
const input = {
	descopeUserId: "user-1",
	resourceUrl: "https://connect.mcp.tedix.dev/mcp",
	selectedTenantIds: tenantIds,
	mcpServerId: "server-1",
	clientId: "client-1",
	consentId: "consent-1",
	consentRevision: "00000000-0000-4000-8000-000000000001",
	tokenScopes: ["mcp:apps.read"],
};
const env = {
	DESCOPE_PROJECT_ID: "project",
	DESCOPE_MANAGEMENT_KEY: "key",
} as CloudflareEnv;

describe("verifyHumanMcpGrant", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.loadDescopeMcpServer.mockResolvedValue({
			id: input.mcpServerId,
			type: "mcp",
			audienceWhitelist: [input.resourceUrl],
			approvedScopes: {
				permissionsScopes: [],
				connectionsScopes: [
					{ name: "mcp:apps.read" },
					{ name: "mcp:work.read" },
				],
			},
		});
		mocks.deleteConsents.mockResolvedValue({ ok: true });
		mocks.getMcpConsentPending.mockResolvedValue(null);
		mocks.getOrganizationByDescopeId.mockImplementation(
			async (_db: unknown, tenantId: string) => ({
				id: orgIds[tenantIds.indexOf(tenantId)],
				descopeTenantId: tenantId,
			}),
		);
		mocks.getMemberByUserId.mockResolvedValue({ status: "active" });
		mocks.getOrganizationAggregatorGateways.mockResolvedValue(
			new Map([
				[orgIds[0], { slug: "org-one-unified" }],
				[orgIds[1], { slug: "org-two-unified" }],
			]),
		);
		mocks.loadByUserId.mockResolvedValue({
			ok: true,
			data: { userTenants: tenantIds.map((tenantId) => ({ tenantId })) },
		});
		mocks.searchDescopeMcpServerClients.mockResolvedValue([
			{
				id: "app-1",
				mcpServerId: input.mcpServerId,
				clientId: input.clientId,
				resourceUrl: input.resourceUrl,
				status: "verified",
			},
		]);
		mocks.getMcpConsentResource.mockResolvedValue({
			appId: "connect-app",
			organizationId: orgIds[0],
			slug: "connect",
			metadata: {
				mcpConfig: {
					multiOrgConsent: true,
					descopeResourceId: input.mcpServerId,
					protectedResourceMetadata: {
						scopes_supported: ["mcp:apps.read", "mcp:work.read"],
					},
				},
			},
		});
		mocks.searchConsents.mockResolvedValue({
			ok: true,
			data: [
				{
					id: input.consentId,
					appId: "app-1",
					userId: input.descopeUserId,
					scopes: input.tokenScopes,
				},
			],
		});
		mocks.getMcpConsentSelection.mockResolvedValue({
			appId: "app-1",
			revision: input.consentRevision,
			status: "active",
			selectedTenantIds: tenantIds,
			approvedScopes: input.tokenScopes,
		});
	});

	it("starts live provider reads before registration returns and traces durations only", async () => {
		const { verifyHumanMcpGrant } = await import("./mcp-grant");
		const server = await mocks.loadDescopeMcpServer();
		mocks.loadDescopeMcpServer.mockClear();
		let resolveServer!: (value: typeof server) => void;
		mocks.loadDescopeMcpServer.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveServer = resolve;
				}),
		);
		const verification = verifyHumanMcpGrant({} as never, env, input);
		await vi.waitFor(() => {
			expect(mocks.loadDescopeMcpServer).toHaveBeenCalledTimes(1);
			expect(mocks.searchDescopeMcpServerClients).toHaveBeenCalledTimes(1);
			expect(mocks.loadByUserId).toHaveBeenCalledTimes(1);
			expect(mocks.searchConsents).toHaveBeenCalledTimes(1);
		});
		resolveServer(server);
		expect((await verification).allowed).toBe(true);
		expect(mocks.setAttribute.mock.calls.map(([name]) => name).sort()).toEqual([
			"tedix.mcp_grant.client_ms",
			"tedix.mcp_grant.consent_ms",
			"tedix.mcp_grant.provider_reads_ms",
			"tedix.mcp_grant.registered_scopes_ms",
			"tedix.mcp_grant.user_ms",
		]);
		for (const [, value] of mocks.setAttribute.mock.calls) {
			expect(typeof value).toBe("number");
			expect(value).toBeGreaterThanOrEqual(0);
		}
	});

	it("retains scope denial precedence when another concurrent provider read rejects", async () => {
		const { verifyHumanMcpGrant } = await import("./mcp-grant");
		mocks.loadDescopeMcpServer.mockResolvedValueOnce({ id: "invalid" });
		mocks.searchConsents.mockRejectedValueOnce(
			new Error("provider unavailable"),
		);
		expect(await verifyHumanMcpGrant({} as never, env, input)).toEqual({
			allowed: false,
			reason: "scope_missing",
			organizations: [],
		});
		expect(mocks.getMcpConsentSelection).not.toHaveBeenCalled();
	});

	it("fails closed when registration rejects during the concurrent wave", async () => {
		const { verifyHumanMcpGrant } = await import("./mcp-grant");
		mocks.loadDescopeMcpServer.mockRejectedValueOnce(
			new Error("provider unavailable"),
		);
		expect(await verifyHumanMcpGrant({} as never, env, input)).toEqual({
			allowed: false,
			reason: "provider_unavailable",
			organizations: [],
		});
		expect(mocks.getMcpConsentSelection).not.toHaveBeenCalled();
	});

	it("cannot authorize when timing instrumentation throws", async () => {
		const { verifyHumanMcpGrant } = await import("./mcp-grant");
		mocks.setAttribute.mockImplementationOnce(() => {
			throw new Error("trace unavailable");
		});
		expect(await verifyHumanMcpGrant({} as never, env, input)).toEqual({
			allowed: false,
			reason: "provider_unavailable",
			organizations: [],
		});
		expect(mocks.getMcpConsentSelection).not.toHaveBeenCalled();
	});

	it("activates an exact pending token only after provider and membership checks", async () => {
		const { verifyHumanMcpGrant } = await import("./mcp-grant");
		const candidate = {
			appId: "app-1",
			revision: input.consentRevision,
			expectedActiveRevision: "old",
			selectedTenantIds: tenantIds,
			approvedScopes: input.tokenScopes,
			expiresAt: "2999-01-01T00:00:00.000Z",
		};
		mocks.getMcpConsentSelection.mockResolvedValueOnce({
			revision: "old",
			status: "active",
		});
		mocks.getMcpConsentPending.mockResolvedValue(candidate);
		mocks.promoteMcpConsentPending.mockResolvedValue(true);
		expect(await verifyHumanMcpGrant({} as never, env, input)).toMatchObject({
			allowed: true,
		});
		expect(mocks.promoteMcpConsentPending).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				expectedActiveRevision: "old",
				revision: input.consentRevision,
				approvedScopes: input.tokenScopes,
			}),
		);
		expect(
			mocks.getMemberByUserId.mock.invocationCallOrder.at(-1),
		).toBeLessThan(mocks.promoteMcpConsentPending.mock.invocationCallOrder[0]!);
		expect(
			mocks.getOrganizationAggregatorGateways.mock.invocationCallOrder.at(-1),
		).toBeLessThan(mocks.promoteMcpConsentPending.mock.invocationCallOrder[0]!);
	});

	it.each([
		"provider",
		"membership",
		"gateway",
		"expired",
		"scopes",
		"organizations",
		"app",
		"cas",
		"revoke",
	])(
		"does not activate/allow a pending token after %s failure",
		async (failure) => {
			const { verifyHumanMcpGrant } = await import("./mcp-grant");
			mocks.getMcpConsentSelection.mockResolvedValue({
				revision: "old",
				status: "active",
			});
			mocks.getMcpConsentPending.mockResolvedValue({
				appId: failure === "app" ? "wrong" : "app-1",
				revision: input.consentRevision,
				expectedActiveRevision: "old",
				selectedTenantIds:
					failure === "organizations" ? [tenantIds[0]] : tenantIds,
				approvedScopes:
					failure === "scopes" ? ["mcp:work.read"] : input.tokenScopes,
				expiresAt:
					failure === "expired"
						? "2000-01-01T00:00:00.000Z"
						: "2999-01-01T00:00:00.000Z",
			});
			if (failure === "provider")
				mocks.searchConsents.mockResolvedValue({ ok: false });
			if (failure === "membership")
				mocks.getMemberByUserId.mockResolvedValue({ status: "inactive" });
			if (failure === "gateway")
				mocks.getOrganizationAggregatorGateways.mockResolvedValue(new Map());
			if (failure === "revoke")
				mocks.getMcpConsentSelection
					.mockResolvedValueOnce({ revision: "old", status: "active" })
					.mockResolvedValue({ revision: "revoked", status: "revoked" });
			expect(await verifyHumanMcpGrant({} as never, env, input)).toMatchObject({
				allowed: false,
			});
			if (failure !== "cas" && failure !== "revoke")
				expect(mocks.promoteMcpConsentPending).not.toHaveBeenCalled();
		},
	);

	it("does not require or reactivate an expired candidate for an already active token", async () => {
		const { verifyHumanMcpGrant } = await import("./mcp-grant");
		expect(await verifyHumanMcpGrant({} as never, env, input)).toMatchObject({
			allowed: true,
		});
		expect(mocks.getMcpConsentPending).not.toHaveBeenCalled();
		expect(mocks.promoteMcpConsentPending).not.toHaveBeenCalled();
	});

	it("binds single-organization stage and issued tokens to the resource's owning organization", async () => {
		mocks.getMcpConsentResource.mockResolvedValue({
			slug: "org-one",
			organizationId: orgIds[0],
			descopeTenantId: tenantIds[0],
			metadata: {
				mcpConfig: {
					descopeResourceId: input.mcpServerId,
					protectedResourceMetadata: { scopes_supported: input.tokenScopes },
				},
			},
		});
		const { stageHumanMcpConsent, verifyHumanMcpGrant } =
			await import("./mcp-grant");
		const stage = {
			resourceUrl: input.resourceUrl,
			clientId: input.clientId,
			approvedScopes: input.tokenScopes,
			selectedTenantIds: [tenantIds[1]!],
		};
		expect(
			await stageHumanMcpConsent({} as never, env, input.descopeUserId, stage),
		).toBeNull();
		expect(mocks.deleteConsents).not.toHaveBeenCalled();
		expect(await verifyHumanMcpGrant({} as never, env, input)).toMatchObject({
			allowed: false,
			reason: "membership_missing",
		});
		mocks.getMcpConsentSelection.mockResolvedValue({
			appId: "app-1",
			revision: input.consentRevision,
			status: "active",
			selectedTenantIds: [tenantIds[0]],
			approvedScopes: input.tokenScopes,
		});
		expect(
			await verifyHumanMcpGrant({} as never, env, {
				...input,
				selectedTenantIds: [tenantIds[0]!],
			}),
		).toMatchObject({
			allowed: true,
			organizations: [{ organizationId: orgIds[0], gatewaySlug: "org-one" }],
		});
		mocks.searchConsents.mockResolvedValue({ ok: true, data: [] });
		expect(
			await verifyHumanMcpGrant({} as never, env, {
				...input,
				selectedTenantIds: [tenantIds[0]!],
			}),
		).toMatchObject({ allowed: false, reason: "consent_missing" });
	});
	it("rejects a resource whose configured resource id differs from the edge", async () => {
		mocks.getMcpConsentResource.mockResolvedValue({
			metadata: {
				mcpConfig: { multiOrgConsent: true, descopeResourceId: "other" },
			},
		});
		const { verifyHumanMcpGrant } = await import("./mcp-grant");
		expect(await verifyHumanMcpGrant({} as never, env, input)).toMatchObject({
			allowed: false,
		});
		expect(mocks.searchConsents).not.toHaveBeenCalled();
	});

	it("stages and verifies a direct resource without a D1 advertised-scope override", async () => {
		const resource = {
			appId: "tenant-app",
			organizationId: orgIds[0],
			slug: "org-one",
			descopeTenantId: tenantIds[0],
			metadata: { mcpConfig: { descopeResourceId: input.mcpServerId } },
		};
		mocks.getMcpConsentResource.mockResolvedValue(resource);
		mocks.getMcpConsentSelection.mockResolvedValue({
			appId: "app-1",
			revision: input.consentRevision,
			status: "active",
			selectedTenantIds: [tenantIds[0]],
			approvedScopes: input.tokenScopes,
		});
		const { stageHumanMcpConsent, verifyHumanMcpGrant } =
			await import("./mcp-grant");
		expect(
			await stageHumanMcpConsent({} as never, env, input.descopeUserId, {
				resourceUrl: input.resourceUrl,
				clientId: input.clientId,
				selectedTenantIds: [tenantIds[0]!],
				approvedScopes: input.tokenScopes,
			}),
		).toMatch(/^[0-9a-f-]{36}$/);
		expect(
			await verifyHumanMcpGrant({} as never, env, {
				...input,
				selectedTenantIds: [tenantIds[0]!],
			}),
		).toMatchObject({ allowed: true });
		expect(mocks.loadDescopeMcpServer).toHaveBeenCalledTimes(2);
	});
	it.each([
		{
			label: "missing requested scope",
			provider: { connectionsScopes: [{ name: "mcp:work.read" }] },
		},
		{ label: "wrong resource id", id: "wrong" },
		{ label: "wrong audience", audience: "https://other.example/mcp" },
		{ label: "wrong resource type", type: "api" },
		{
			label: "malformed scope group",
			provider: { connectionsScopes: "mcp:apps.read" },
		},
		{
			label: "malformed scope name",
			provider: { connectionsScopes: [{ name: 4 }] },
		},
		{
			label: "attribute object is not a capability",
			provider: { attributesScopes: [{ name: "mcp:apps.read" }] },
		},
	])(
		"rejects $label before cleanup or revision replacement",
		async ({ provider, id, audience, type }) => {
			if (audience) {
				const resource = {
					appId: "connect-app",
					organizationId: orgIds[0],
					slug: "connect",
					metadata: {
						mcpConfig: {
							multiOrgConsent: true,
							descopeResourceId: input.mcpServerId,
						},
					},
				};
				mocks.getMcpConsentResource.mockImplementation(async (_db, key) =>
					key.resourceUrl && key.resourceUrl !== input.resourceUrl
						? null
						: resource,
				);
			}
			mocks.loadDescopeMcpServer.mockResolvedValue({
				id: id ?? input.mcpServerId,
				type: type ?? "mcp",
				audienceWhitelist: [audience ?? input.resourceUrl],
				approvedScopes: provider ?? {
					connectionsScopes: [{ name: "mcp:apps.read" }],
				},
			});
			const { stageHumanMcpConsent, verifyHumanMcpGrant } =
				await import("./mcp-grant");
			expect(
				await stageHumanMcpConsent({} as never, env, input.descopeUserId, {
					resourceUrl: input.resourceUrl,
					clientId: input.clientId,
					selectedTenantIds: tenantIds,
					approvedScopes: input.tokenScopes,
				}),
			).toBeNull();
			expect(await verifyHumanMcpGrant({} as never, env, input)).toMatchObject({
				allowed: false,
			});
			expect(mocks.deleteConsents).not.toHaveBeenCalled();
			expect(mocks.replaceMcpConsentSelection).not.toHaveBeenCalled();
		},
	);
	it("fails closed on provider resource outage before deleting existing consent", async () => {
		mocks.loadDescopeMcpServer.mockRejectedValue(
			new Error("Provider resource unavailable"),
		);
		const { stageHumanMcpConsent, verifyHumanMcpGrant } =
			await import("./mcp-grant");
		expect(
			await stageHumanMcpConsent({} as never, env, input.descopeUserId, {
				resourceUrl: input.resourceUrl,
				clientId: input.clientId,
				selectedTenantIds: tenantIds,
				approvedScopes: input.tokenScopes,
			}),
		).toBeNull();
		expect(await verifyHumanMcpGrant({} as never, env, input)).toMatchObject({
			allowed: false,
			reason: "provider_unavailable",
		});
		expect(mocks.deleteConsents).not.toHaveBeenCalled();
		expect(mocks.replaceMcpConsentSelection).not.toHaveBeenCalled();
	});

	it("returns only the two explicitly selected, active organization gateways", async () => {
		const { verifyHumanMcpGrant } = await import("./mcp-grant");
		await expect(verifyHumanMcpGrant({} as never, env, input)).resolves.toEqual(
			{
				allowed: true,
				reason: "active",
				organizations: [
					{
						organizationId: orgIds[0],
						descopeTenantId: tenantIds[0],
						gatewaySlug: "org-one-unified",
					},
					{
						organizationId: orgIds[1],
						descopeTenantId: tenantIds[1],
						gatewaySlug: "org-two-unified",
					},
				],
			},
		);
		expect(mocks.getMcpConsentResource).toHaveBeenCalledWith(
			{},
			{ mcpServerId: input.mcpServerId },
		);
		expect(mocks.searchConsents).toHaveBeenCalledWith({
			userId: input.descopeUserId,
			consentId: input.consentId,
		});
	});

	it("rejects a client not registered to this MCP resource", async () => {
		mocks.searchDescopeMcpServerClients.mockResolvedValue([
			{
				id: "app-1",
				mcpServerId: "different-server",
				clientId: input.clientId,
				resourceUrl: input.resourceUrl,
			},
		]);
		const { verifyHumanMcpGrant } = await import("./mcp-grant");
		await expect(
			verifyHumanMcpGrant({} as never, env, input),
		).resolves.toMatchObject({ allowed: false, reason: "consent_missing" });
		expect(mocks.searchConsents).toHaveBeenCalledWith({
			userId: input.descopeUserId,
			consentId: input.consentId,
		});
	});

	it("rejects a consent issued to another client", async () => {
		mocks.searchConsents.mockResolvedValue({
			ok: true,
			data: [
				{
					id: input.consentId,
					appId: "different-app",
					userId: input.descopeUserId,
					scopes: input.tokenScopes,
				},
			],
		});
		const { verifyHumanMcpGrant } = await import("./mcp-grant");
		await expect(
			verifyHumanMcpGrant({} as never, env, input),
		).resolves.toMatchObject({ allowed: false, reason: "consent_missing" });
	});

	it("rejects the same unexpired token after its consent is revoked", async () => {
		mocks.searchConsents.mockResolvedValue({ ok: true, data: [] });
		const { verifyHumanMcpGrant } = await import("./mcp-grant");
		await expect(verifyHumanMcpGrant({} as never, env, input)).resolves.toEqual(
			{
				allowed: false,
				reason: "consent_missing",
				organizations: [],
			},
		);
	});

	it("rejects an older two-organization token after a one-organization replacement", async () => {
		mocks.getMcpConsentSelection.mockResolvedValue({
			appId: "app-1",
			revision: "00000000-0000-4000-8000-000000000002",
			status: "active",
			selectedTenantIds: [tenantIds[0]],
			approvedScopes: input.tokenScopes,
		});
		const { verifyHumanMcpGrant } = await import("./mcp-grant");
		await expect(verifyHumanMcpGrant({} as never, env, input)).resolves.toEqual(
			{
				allowed: false,
				reason: "selection_replaced",
				organizations: [],
			},
		);
	});

	it("stages only a verified client's exact member organizations and scopes, then revokes them", async () => {
		const { stageHumanMcpConsent, revokeHumanMcpConsent } =
			await import("./mcp-grant");
		const revision = await stageHumanMcpConsent(
			{} as never,
			env,
			input.descopeUserId,
			{
				clientId: input.clientId,
				resourceUrl: input.resourceUrl,
				selectedTenantIds: [...tenantIds],
				approvedScopes: ["mcp:work.read", "mcp:apps.read"],
			},
		);
		expect(revision).toMatch(/^[0-9a-f-]{36}$/);
		expect(mocks.stageMcpConsentPending).toHaveBeenCalledWith(
			expect.anything(),
			{
				descopeUserId: input.descopeUserId,
				mcpServerId: input.mcpServerId,
				clientId: input.clientId,
				appId: "app-1",
				revision,
				expectedActiveRevision: input.consentRevision,
				expiresAt: expect.any(String),
				selectedTenantIds: [...tenantIds].sort(),
				approvedScopes: ["mcp:apps.read", "mcp:work.read"],
			},
		);
		await expect(
			stageHumanMcpConsent({} as never, env, input.descopeUserId, {
				clientId: input.clientId,
				resourceUrl: input.resourceUrl,
				selectedTenantIds: [...tenantIds],
				approvedScopes: ["platform:admin"],
			}),
		).resolves.toBeNull();
		const revoked = await revokeHumanMcpConsent(
			{} as never,
			env,
			input.descopeUserId,
			{ clientId: input.clientId, resourceUrl: input.resourceUrl },
		);
		expect(revoked).not.toBe(revision);
		expect(mocks.replaceMcpConsentSelection).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				status: "revoked",
				selectedTenantIds: [],
				approvedScopes: [],
			}),
		);
	});

	it("stages without deleting provider consent or replacing active access", async () => {
		const { stageHumanMcpConsent, verifyHumanMcpGrant } =
			await import("./mcp-grant");
		const revision = await stageHumanMcpConsent(
			{} as never,
			env,
			input.descopeUserId,
			{
				clientId: input.clientId,
				resourceUrl: input.resourceUrl,
				selectedTenantIds: tenantIds,
				approvedScopes: ["mcp:apps.read"],
			},
		);
		expect(revision).toBeTruthy();
		expect(mocks.searchConsents).not.toHaveBeenCalled();
		expect(mocks.deleteConsents).not.toHaveBeenCalled();
		expect(mocks.replaceMcpConsentSelection).not.toHaveBeenCalled();
		expect(await verifyHumanMcpGrant({} as never, env, input)).toMatchObject({
			allowed: true,
		});
	});

	it("does not stage for forged membership", async () => {
		const { stageHumanMcpConsent } = await import("./mcp-grant");
		expect(
			await stageHumanMcpConsent({} as never, env, input.descopeUserId, {
				clientId: input.clientId,
				resourceUrl: input.resourceUrl,
				selectedTenantIds: ["nonmember"],
				approvedScopes: ["mcp:apps.read"],
			}),
		).toBeNull();
		expect(mocks.stageMcpConsentPending).not.toHaveBeenCalled();
		expect(mocks.deleteConsents).not.toHaveBeenCalled();
	});

	it("resolves a Descope app ID to the verified canonical client before staging or revoking", async () => {
		const { stageHumanMcpConsent, revokeHumanMcpConsent } =
			await import("./mcp-grant");
		mocks.searchDescopeMcpServerClients.mockResolvedValue([
			{
				id: "TPAclient1",
				mcpServerId: input.mcpServerId,
				clientId: input.clientId,
				resourceUrl: input.resourceUrl,
				status: "verified",
			},
		]);
		const revision = await stageHumanMcpConsent(
			{} as never,
			env,
			input.descopeUserId,
			{
				clientId: "TPAclient1",
				resourceUrl: input.resourceUrl,
				selectedTenantIds: [...tenantIds],
				approvedScopes: ["mcp:apps.read"],
			},
		);
		expect(revision).toBeTruthy();
		expect(mocks.searchDescopeMcpServerClients).toHaveBeenCalledWith(env, {
			mcpServerId: input.mcpServerId,
		});
		expect(mocks.stageMcpConsentPending).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				appId: "TPAclient1",
				clientId: input.clientId,
			}),
		);
		await revokeHumanMcpConsent({} as never, env, input.descopeUserId, {
			clientId: "TPAclient1",
			resourceUrl: input.resourceUrl,
		});
		expect(mocks.replaceMcpConsentSelection).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				appId: "TPAclient1",
				clientId: input.clientId,
				status: "revoked",
			}),
		);

		mocks.replaceMcpConsentSelection.mockClear();
		mocks.searchDescopeMcpServerClients.mockResolvedValue([
			{
				id: "TPAclient1",
				mcpServerId: input.mcpServerId,
				clientId: input.clientId,
				resourceUrl: input.resourceUrl,
				status: "unverified",
			},
		]);
		await expect(
			stageHumanMcpConsent({} as never, env, input.descopeUserId, {
				clientId: "TPAclient1",
				resourceUrl: input.resourceUrl,
				selectedTenantIds: [...tenantIds],
				approvedScopes: ["mcp:apps.read"],
			}),
		).resolves.toBeNull();
		expect(mocks.replaceMcpConsentSelection).not.toHaveBeenCalled();
		mocks.searchDescopeMcpServerClients.mockResolvedValue([
			{
				id: "TPAclient1",
				mcpServerId: "other-server",
				clientId: input.clientId,
				resourceUrl: input.resourceUrl,
				status: "verified",
			},
		]);
		await expect(
			stageHumanMcpConsent({} as never, env, input.descopeUserId, {
				clientId: "TPAclient1",
				resourceUrl: input.resourceUrl,
				selectedTenantIds: [...tenantIds],
				approvedScopes: ["mcp:apps.read"],
			}),
		).resolves.toBeNull();
		expect(mocks.replaceMcpConsentSelection).not.toHaveBeenCalled();
	});

	it("rejects a selected tenant lost from Descope or D1 membership", async () => {
		const { verifyHumanMcpGrant } = await import("./mcp-grant");
		mocks.loadByUserId.mockResolvedValue({
			ok: true,
			data: { userTenants: [{ tenantId: tenantIds[0] }] },
		});
		await expect(
			verifyHumanMcpGrant({} as never, env, input),
		).resolves.toMatchObject({
			allowed: false,
			reason: "membership_missing",
		});
		mocks.loadByUserId.mockResolvedValue({
			ok: true,
			data: { userTenants: tenantIds.map((tenantId) => ({ tenantId })) },
		});
		mocks.getMemberByUserId
			.mockResolvedValueOnce({ status: "active" })
			.mockResolvedValueOnce({ status: "inactive" });
		await expect(
			verifyHumanMcpGrant({} as never, env, input),
		).resolves.toMatchObject({
			allowed: false,
			reason: "membership_missing",
		});
	});

	it("rejects scope expansion and provider failure", async () => {
		const { verifyHumanMcpGrant } = await import("./mcp-grant");
		await expect(
			verifyHumanMcpGrant({} as never, env, {
				...input,
				tokenScopes: ["mcp:apps.read", "mcp:apps.write"],
			}),
		).resolves.toMatchObject({ allowed: false, reason: "scope_missing" });
		mocks.searchConsents.mockRejectedValue(new Error("Descope unavailable"));
		await expect(verifyHumanMcpGrant({} as never, env, input)).resolves.toEqual(
			{
				allowed: false,
				reason: "provider_unavailable",
				organizations: [],
			},
		);
	});
});

describe("human authorization management", () => {
	const row = {
		descopeUserId: "user-1",
		mcpServerId: "server-1",
		clientId: "client-1",
		appId: "app-1",
		revision: input.consentRevision,
		status: "active",
		selectedTenantIds: ["tenant-1"],
		approvedScopes: ["mcp:apps.read"],
		updatedAt: "today",
	};
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.getMcpConsentResource.mockResolvedValue({
			metadata: { mcpConfig: { descopeResourceId: "server-1" } },
		});
		mocks.listMcpConsentSelections.mockResolvedValue([row]);
		mocks.searchDescopeMcpServerClients.mockResolvedValue([
			{
				mcpServerId: "server-1",
				clientId: "client-1",
				id: "app-1",
				status: "verified",
				name: "ChatGPT",
			},
		]);
	});
	it("does not call a staged row connected before exact provider consent exists", async () => {
		const { listHumanMcpAuthorizations } = await import("./mcp-grant");
		mocks.searchConsents.mockResolvedValue({
			ok: true,
			data: [{ appId: "app-1", userId: "other", scopes: ["mcp:apps.read"] }],
		});
		expect(
			await listHumanMcpAuthorizations({} as never, env, "user-1", {
				limit: 20,
				offset: 0,
			}),
		).toMatchObject({
			items: [{ providerStatus: "missing", clientName: "ChatGPT" }],
		});
		expect(mocks.listMcpConsentSelections).toHaveBeenCalledWith(
			{},
			{
				descopeUserId: "user-1",
				limit: 21,
				offset: 0,
			},
		);
		mocks.searchConsents.mockResolvedValue({
			ok: true,
			data: [{ appId: "app-1", userId: "user-1", scopes: ["mcp:apps.read"] }],
		});
		expect(
			await listHumanMcpAuthorizations({} as never, env, "user-1", {
				limit: 20,
				offset: 0,
			}),
		).toMatchObject({ items: [{ providerStatus: "present" }] });
		mocks.searchConsents.mockRejectedValue(new Error("down"));
		expect(
			await listHumanMcpAuthorizations({} as never, env, "user-1", {
				limit: 20,
				offset: 0,
			}),
		).toMatchObject({
			items: [{ providerStatus: "unavailable", clientName: "ChatGPT" }],
		});
	});
	it("keeps disabled application identity without consulting provider consent", async () => {
		const { listHumanMcpAuthorizations } = await import("./mcp-grant");
		mocks.listMcpConsentSelections.mockResolvedValue([
			{ ...row, status: "revoked", selectedTenantIds: [], approvedScopes: [] },
		]);
		expect(
			await listHumanMcpAuthorizations({} as never, env, "user-1", {
				limit: 20,
				offset: 0,
			}),
		).toMatchObject({
			items: [
				{
					clientName: "ChatGPT",
					status: "revoked",
					providerStatus: "not_checked",
					selectedTenantIds: [],
					approvedScopes: [],
				},
			],
		});
		expect(mocks.searchDescopeMcpServerClients).toHaveBeenCalledWith(env, {
			mcpServerId: "server-1",
			clientId: "client-1",
		});
		expect(mocks.searchConsents).not.toHaveBeenCalled();
	});
	it.each([
		{ mcpServerId: "other" },
		{ clientId: "other" },
		{ id: "other" },
		{ status: "pending" },
	])(
		"does not label a disabled grant from mismatched registration %j",
		async (mismatch) => {
			const { listHumanMcpAuthorizations } = await import("./mcp-grant");
			mocks.listMcpConsentSelections.mockResolvedValue([
				{
					...row,
					status: "revoked",
					selectedTenantIds: [],
					approvedScopes: [],
				},
			]);
			mocks.searchDescopeMcpServerClients.mockResolvedValue([
				{
					mcpServerId: "server-1",
					clientId: "client-1",
					id: "app-1",
					status: "verified",
					name: "Wrong application",
					...mismatch,
				},
			]);
			expect(
				await listHumanMcpAuthorizations({} as never, env, "user-1", {
					limit: 20,
					offset: 0,
				}),
			).toMatchObject({
				items: [{ clientName: null, providerStatus: "not_checked" }],
			});
			expect(mocks.searchConsents).not.toHaveBeenCalled();
		},
	);
	it("rejects ambiguous disabled names and keeps metadata failures distinct from access", async () => {
		const { listHumanMcpAuthorizations } = await import("./mcp-grant");
		mocks.listMcpConsentSelections.mockResolvedValue([
			{ ...row, status: "revoked", selectedTenantIds: [], approvedScopes: [] },
		]);
		const client = {
			mcpServerId: "server-1",
			clientId: "client-1",
			id: "app-1",
			status: "verified",
			name: "ChatGPT",
		};
		mocks.searchDescopeMcpServerClients.mockResolvedValue([client, client]);
		expect(
			await listHumanMcpAuthorizations({} as never, env, "user-1", {
				limit: 20,
				offset: 0,
			}),
		).toMatchObject({
			items: [{ clientName: null, providerStatus: "not_checked" }],
		});
		mocks.searchDescopeMcpServerClients.mockRejectedValue(
			new Error("metadata down"),
		);
		expect(
			await listHumanMcpAuthorizations({} as never, env, "user-1", {
				limit: 20,
				offset: 0,
			}),
		).toMatchObject({
			items: [
				{
					clientName: null,
					status: "revoked",
					providerStatus: "not_checked",
					selectedTenantIds: [],
					approvedScopes: [],
				},
			],
		});
		expect(mocks.searchConsents).not.toHaveBeenCalled();
	});
	it("disables owned revision without client registration or provider credential deletion", async () => {
		const { disableHumanMcpAuthorization } = await import("./mcp-grant");
		mocks.disableMcpConsentSelection.mockResolvedValue({
			...row,
			revision: "next",
		});
		expect(
			await disableHumanMcpAuthorization({} as never, env, "user-1", {
				mcpServerId: "server-1",
				clientId: "client-1",
				expectedRevision: input.consentRevision,
			}),
		).toBe("next");
		expect(mocks.disableMcpConsentSelection).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				descopeUserId: "user-1",
				expectedRevision: input.consentRevision,
			}),
		);
		expect(mocks.searchDescopeMcpServerClients).not.toHaveBeenCalled();
		expect(mocks.deleteConsents).not.toHaveBeenCalled();
		mocks.disableMcpConsentSelection.mockResolvedValueOnce(null);
		expect(
			await disableHumanMcpAuthorization({} as never, env, "user-1", {
				mcpServerId: "other",
				clientId: "client-1",
				expectedRevision: input.consentRevision,
			}),
		).toBeNull();
	});
});

describe("explicit human platform administration", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.loadDescopeMcpServer.mockResolvedValue({
			id: input.mcpServerId,
			type: "mcp",
			audienceWhitelist: [input.resourceUrl],
			approvedScopes: {
				permissionsScopes: [{ name: "platform:admin" }],
				connectionsScopes: [{ name: "mcp:apps.read" }],
			},
		});
		mocks.getMcpConsentResource.mockResolvedValue({
			appId: "connect-app",
			organizationId: orgIds[0],
			metadata: {
				mcpConfig: {
					multiOrgConsent: true,
					descopeResourceId: input.mcpServerId,
				},
			},
		});
		mocks.searchDescopeMcpServerClients.mockResolvedValue([
			{
				id: "app-1",
				mcpServerId: input.mcpServerId,
				clientId: input.clientId,
				status: "verified",
			},
		]);
		mocks.getOrganizationByDescopeId.mockImplementation(
			async (_db: unknown, tenantId: string) => ({
				id: orgIds[tenantIds.indexOf(tenantId)],
				descopeTenantId: tenantId,
			}),
		);
		mocks.getMemberByUserId.mockResolvedValue({ status: "active" });
		mocks.getOrganizationAggregatorGateways.mockResolvedValue(
			new Map([
				[orgIds[0], { slug: "tedix" }],
				[orgIds[1], { slug: "sample" }],
			]),
		);
		mocks.searchConsents.mockResolvedValue({
			ok: true,
			data: [
				{
					id: input.consentId,
					appId: "app-1",
					userId: input.descopeUserId,
					scopes: ["platform:admin"],
				},
			],
		});
		mocks.deleteConsents.mockResolvedValue({ ok: true });
		mocks.getMcpConsentPending.mockResolvedValue(null);
		mocks.getMcpConsentSelection.mockResolvedValue({
			appId: "app-1",
			revision: input.consentRevision,
			status: "active",
			selectedTenantIds: tenantIds,
			approvedScopes: ["platform:admin"],
		});
	});
	it.each([[], ["owner"], ["admin"]])(
		"rejects platform consent for project roles %j even with a tenant platform role",
		async (...roles) => {
			mocks.loadByUserId.mockResolvedValue({
				ok: true,
				data: {
					roleNames: roles.flat(),
					userTenants: tenantIds.map((tenantId) => ({
						tenantId,
						roleNames: ["platform-admin"],
					})),
				},
			});
			const { stageHumanMcpConsent, verifyHumanMcpGrant } =
				await import("./mcp-grant");
			await expect(
				stageHumanMcpConsent({} as never, env, input.descopeUserId, {
					clientId: input.clientId,
					resourceUrl: input.resourceUrl,
					selectedTenantIds: tenantIds,
					approvedScopes: ["platform:admin"],
				}),
			).resolves.toBeNull();
			await expect(
				verifyHumanMcpGrant({} as never, env, {
					...input,
					tokenScopes: ["platform:admin"],
				}),
			).resolves.toMatchObject({ allowed: false, reason: "scope_missing" });
			expect(mocks.deleteConsents).not.toHaveBeenCalled();
		},
	);
	it("does not let platform authority bypass selected organization membership or revision fences", async () => {
		mocks.loadByUserId.mockResolvedValue({
			ok: true,
			data: {
				roleNames: ["platform-admin"],
				userTenants: [{ tenantId: tenantIds[0] }],
			},
		});
		const { stageHumanMcpConsent, verifyHumanMcpGrant } =
			await import("./mcp-grant");
		await expect(
			stageHumanMcpConsent({} as never, env, input.descopeUserId, {
				clientId: input.clientId,
				resourceUrl: input.resourceUrl,
				selectedTenantIds: tenantIds,
				approvedScopes: ["platform:admin"],
			}),
		).resolves.toBeNull();
		await expect(
			verifyHumanMcpGrant({} as never, env, {
				...input,
				tokenScopes: ["platform:admin"],
			}),
		).resolves.toMatchObject({ allowed: false, reason: "membership_missing" });
		mocks.loadByUserId.mockResolvedValue({
			ok: true,
			data: {
				roleNames: ["platform-admin"],
				userTenants: tenantIds.map((tenantId) => ({ tenantId })),
			},
		});
		mocks.getMcpConsentSelection.mockResolvedValue({
			appId: "app-1",
			revision: "different",
			status: "active",
			selectedTenantIds: tenantIds,
			approvedScopes: ["platform:admin"],
		});
		await expect(
			verifyHumanMcpGrant({} as never, env, {
				...input,
				tokenScopes: ["platform:admin"],
			}),
		).resolves.toMatchObject({ allowed: false, reason: "selection_replaced" });
	});

	it("allows a fresh project platform admin's explicit grant, and rejects it immediately after role removal", async () => {
		mocks.loadByUserId.mockResolvedValue({
			ok: true,
			data: {
				roleNames: ["platform-admin"],
				userTenants: tenantIds.map((tenantId) => ({ tenantId })),
			},
		});
		const { stageHumanMcpConsent, verifyHumanMcpGrant } =
			await import("./mcp-grant");
		await expect(
			stageHumanMcpConsent({} as never, env, input.descopeUserId, {
				clientId: input.clientId,
				resourceUrl: input.resourceUrl,
				selectedTenantIds: tenantIds,
				approvedScopes: ["platform:admin"],
			}),
		).resolves.toMatch(/^[0-9a-f-]{36}$/);
		await expect(
			verifyHumanMcpGrant({} as never, env, {
				...input,
				tokenScopes: ["platform:admin"],
			}),
		).resolves.toMatchObject({ allowed: true });
		mocks.loadByUserId.mockResolvedValue({
			ok: true,
			data: {
				roleNames: [],
				userTenants: tenantIds.map((tenantId) => ({ tenantId })),
			},
		});
		await expect(
			verifyHumanMcpGrant({} as never, env, {
				...input,
				tokenScopes: ["platform:admin"],
			}),
		).resolves.toMatchObject({ allowed: false, reason: "scope_missing" });
	});
});
