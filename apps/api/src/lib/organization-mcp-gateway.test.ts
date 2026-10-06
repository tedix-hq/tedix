import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	createApp: vi.fn(),
	getAppBySlug: vi.fn(),
	getTedisByOrganization: vi.fn(),
	getManagementClient: vi.fn(),
	getAssignedAppRoles: vi.fn(),
	grantAppOperator: vi.fn(),
	grantAppObserver: vi.fn(),
	revokeAppAccess: vi.fn(),
	syncTediAihClientForAssignment: vi.fn(),
	loadAllDescopeMcpServers: vi.fn(),
	registerDescopeMcpResource: vi.fn(),
	updateApp: vi.fn(),
	updateDescopeMcpServer: vi.fn(),
	runToolSchemaSync: vi.fn(),
}));

vi.mock("../services/tool-schema-sync", () => ({
	runToolSchemaSync: mocks.runToolSchemaSync,
	OS_TOOL_ID_OVERRIDES: { "osWorkspaces/outputs/create": "create_os_output" },
	OS_KIND_OVERRIDES: { "osWorkspaces/outputs/create": "write" },
}));

vi.mock("@tedix/db/queries/app-records", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/app-records")>()),
	createApp: mocks.createApp,
	getAppBySlug: mocks.getAppBySlug,
	updateApp: mocks.updateApp,
}));

vi.mock("@tedix/db/queries/tedis", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/tedis")>()),
	getTedisByOrganization: mocks.getTedisByOrganization,
}));

vi.mock("@tedix/auth/aih-client", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/auth/aih-client")>()),
	loadAllDescopeMcpServers: mocks.loadAllDescopeMcpServers,
	registerDescopeMcpResource: mocks.registerDescopeMcpResource,
	updateDescopeMcpServer: mocks.updateDescopeMcpServer,
}));

vi.mock("@tedix/auth/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/auth/client")>()),
	getManagementClient: mocks.getManagementClient,
}));

vi.mock("@tedix/auth/fga", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/auth/fga")>()),
	getAssignedAppRoles: mocks.getAssignedAppRoles,
	grantAppOperator: mocks.grantAppOperator,
	grantAppObserver: mocks.grantAppObserver,
	revokeAppAccess: mocks.revokeAppAccess,
}));

vi.mock("../services/tedi-mcp-access", async (importOriginal) => ({
	...(await importOriginal<typeof import("../services/tedi-mcp-access")>()),
	syncTediAihClientForAssignment: mocks.syncTediAihClientForAssignment,
}));

const ENV = {
	DESCOPE_PROJECT_ID: "project",
	DESCOPE_MANAGEMENT_KEY: "management-key",
} as CloudflareEnv;

function app(metadata: Record<string, unknown> = {}) {
	return {
		id: "app-1",
		organizationId: "org-1",
		name: "Acme Unified MCP",
		slug: "acme-unified",
		metadata,
	};
}

describe("ensureOrganizationUnifiedGateway", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.runToolSchemaSync.mockResolvedValue({ total: 1, failed: 0 });
		mocks.getTedisByOrganization.mockResolvedValue([
			{ id: "tedi-1", slug: "tedi-first", descopeUserId: "DU-first" },
		]);
		mocks.getManagementClient.mockReturnValue({});
		mocks.getAssignedAppRoles.mockResolvedValue({});
		mocks.syncTediAihClientForAssignment.mockResolvedValue({
			status: "created",
		});
		mocks.loadAllDescopeMcpServers.mockResolvedValue([]);
		mocks.registerDescopeMcpResource.mockResolvedValue({
			id: "MS-new",
			name: "Acme Unified MCP",
		});
		mocks.updateApp.mockImplementation(
			async (_db: unknown, id: string, update: Record<string, unknown>) => ({
				...app(update.metadata as Record<string, unknown>),
				id,
				...update,
			}),
		);
	});

	it("keeps deterministic gateway hostnames within the DNS label limit", async () => {
		const { organizationGatewaySlug } =
			await import("./organization-mcp-gateway");
		const slug = organizationGatewaySlug("a".repeat(63), "12345678-rest");
		expect(slug).toHaveLength(63);
		expect(slug).toBe(`${"a".repeat(46)}-12345678-unified`);
	});

	it("creates a non-discoverable shell, registers AIH, then makes the gateway ready", async () => {
		mocks.getAppBySlug.mockResolvedValue(null);
		mocks.createApp.mockResolvedValue(app());
		const { ensureOrganizationUnifiedGateway } =
			await import("./organization-mcp-gateway");

		await expect(
			ensureOrganizationUnifiedGateway({} as never, ENV, {
				organizationId: "org-1",
				organizationName: "Acme",
				organizationSlug: "acme",
			}),
		).resolves.toEqual({
			appId: "app-1",
			descopeResourceId: "MS-new",
			gatewaySlug: "acme-unified",
			mcpUrl: "https://acme-unified.mcp.tedix.dev/mcp",
		});

		const createInput = mocks.createApp.mock.calls[0]?.[1];
		expect(mocks.runToolSchemaSync).not.toHaveBeenCalled();
		expect(createInput.metadata.mcpConfig).toMatchObject({
			provisioningStatus: "pending",
		});
		expect(createInput.metadata.mcpConfig).not.toHaveProperty("codeMode");
		expect(mocks.registerDescopeMcpResource).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				audienceWhitelist: expect.arrayContaining([
					"https://acme-unified.mcp.tedix.dev/mcp",
				]),
				tags: expect.arrayContaining(["app:acme-unified"]),
			}),
		);
		expect(mocks.updateApp).toHaveBeenCalledWith(
			expect.anything(),
			"app-1",
			expect.objectContaining({
				metadata: expect.objectContaining({
					mcpConfig: expect.objectContaining({
						authMode: "authenticated",
						codeMode: true,
						assignmentConfig: {
							mode: "profile-default",
							role: "operator",
						},
						descopeResourceId: "MS-new",
						provisioningStatus: "ready",
						aggregateTedis: [{ slug: "tedi-first", surface: "full" }],
						toolScopes: expect.objectContaining({
							work: ["mcp:work.read", "mcp:work.write"],
						}),
					}),
				}),
			}),
		);
		expect(mocks.grantAppOperator).toHaveBeenCalledWith(
			expect.anything(),
			"DU-first",
			"app-1",
		);
		expect(mocks.syncTediAihClientForAssignment).toHaveBeenCalledWith(
			expect.objectContaining({
				tedi: expect.objectContaining({ id: "tedi-1" }),
				app: expect.objectContaining({ id: "app-1" }),
				role: "operator",
			}),
		);
	});

	it("retries credential sync without duplicating an existing FGA grant", async () => {
		let persisted: ReturnType<typeof app> | null = null;
		mocks.getAppBySlug.mockImplementation(async () => persisted);
		mocks.createApp.mockResolvedValue(app());
		mocks.updateApp.mockImplementation(
			async (_db: unknown, id: string, update: Record<string, unknown>) =>
				(persisted = {
					...app(update.metadata as Record<string, unknown>),
					id,
					...update,
				}),
		);
		mocks.getAssignedAppRoles
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({ "app-1": "operator" });
		mocks.loadAllDescopeMcpServers
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ id: "MS-new", name: "Acme Unified MCP" }]);
		mocks.updateDescopeMcpServer.mockResolvedValue({ id: "MS-new" });
		const { ensureOrganizationUnifiedGateway } =
			await import("./organization-mcp-gateway");
		const input = {
			organizationId: "org-1",
			organizationName: "Acme",
			organizationSlug: "acme",
		};

		await ensureOrganizationUnifiedGateway({} as never, ENV, input);
		await ensureOrganizationUnifiedGateway({} as never, ENV, input);

		expect(mocks.createApp).toHaveBeenCalledOnce();
		expect(mocks.grantAppOperator).toHaveBeenCalledOnce();
		expect(mocks.syncTediAihClientForAssignment).toHaveBeenCalledTimes(2);
	});

	it("preserves an explicit manual assignment policy", async () => {
		mocks.getAppBySlug.mockResolvedValue(
			app({ mcpConfig: { assignmentConfig: { mode: "manual" } } }),
		);
		const { ensureOrganizationUnifiedGateway } =
			await import("./organization-mcp-gateway");

		await ensureOrganizationUnifiedGateway({} as never, ENV, {
			organizationId: "org-1",
			organizationName: "Acme",
			organizationSlug: "acme",
		});

		expect(
			mocks.updateApp.mock.calls[0]?.[2].metadata.mcpConfig.assignmentConfig,
		).toEqual({ mode: "manual" });
		expect(mocks.grantAppOperator).not.toHaveBeenCalled();
		expect(mocks.syncTediAihClientForAssignment).not.toHaveBeenCalled();
	});

	it("fails onboarding when first-tedi credentials cannot sync", async () => {
		mocks.getAppBySlug.mockResolvedValue(app());
		mocks.syncTediAihClientForAssignment.mockResolvedValue({
			status: "skipped",
			reason: "missing credentials",
		});
		const { ensureOrganizationUnifiedGateway } =
			await import("./organization-mcp-gateway");

		await expect(
			ensureOrganizationUnifiedGateway({} as never, ENV, {
				organizationId: "org-1",
				organizationName: "Acme",
				organizationSlug: "acme",
			}),
		).rejects.toThrow("First tedi MCP access was not provisioned");
	});

	it("repairs an older gateway without dropping its existing scope groups", async () => {
		mocks.getAppBySlug.mockResolvedValue(
			app({
				mcpConfig: {
					toolScopes: {
						content: ["mcp:content.write"],
						work: ["mcp:work.write"],
					},
					aggregateTedis: [],
				},
			}),
		);
		const { ensureOrganizationUnifiedGateway } =
			await import("./organization-mcp-gateway");
		await ensureOrganizationUnifiedGateway({} as never, ENV, {
			organizationId: "org-1",
			organizationName: "Acme",
			organizationSlug: "acme",
		});
		const config = mocks.updateApp.mock.calls[0]?.[2].metadata.mcpConfig;
		expect(config.toolScopes).toEqual({
			content: ["mcp:content.write"],
			work: ["mcp:work.write", "mcp:work.read"],
		});
		expect(config.aggregateTedis).toEqual([
			{ slug: "tedi-first", surface: "full" },
		]);
	});

	it("reuses an ownership-tagged AIH server after a partial first attempt", async () => {
		mocks.getAppBySlug.mockResolvedValue(
			app({
				mcpConfig: {
					serverName: "Acme Unified MCP",
					provisioningStatus: "pending",
				},
			}),
		);
		const taggedServer = {
			id: "MS-existing",
			name: "Acme Unified MCP",
			tags: ["managed-by:tedix", "app:acme-unified"],
			audienceWhitelist: ["https://acme-unified.mcp.tedix.dev/mcp"],
		};
		mocks.loadAllDescopeMcpServers.mockResolvedValue([taggedServer]);
		mocks.updateDescopeMcpServer.mockImplementation(
			async (_env: unknown, server: unknown) => server,
		);
		const { ensureOrganizationUnifiedGateway } =
			await import("./organization-mcp-gateway");

		const result = await ensureOrganizationUnifiedGateway({} as never, ENV, {
			organizationId: "org-1",
			organizationName: "Acme",
			organizationSlug: "acme",
		});

		expect(result.descopeResourceId).toBe("MS-existing");
		expect(mocks.createApp).not.toHaveBeenCalled();
		expect(mocks.registerDescopeMcpResource).not.toHaveBeenCalled();
		expect(mocks.updateDescopeMcpServer).toHaveBeenCalledOnce();
	});

	it("keeps credential-free local onboarding inside D1", async () => {
		mocks.getAppBySlug.mockResolvedValue(null);
		mocks.createApp.mockResolvedValue(app());
		const { ensureOrganizationUnifiedGateway } =
			await import("./organization-mcp-gateway");

		const result = await ensureOrganizationUnifiedGateway(
			{} as never,
			{
				...ENV,
				ENVIRONMENT: "development",
				DESCOPE_PROJECT_ID: "local-development-disabled",
				TEDIX_LOCAL_DEMO_ENABLED: "true",
				MCP_URL: "http://localhost:3000",
			} as CloudflareEnv,
			{
				organizationId: "org-1",
				organizationName: "Acme",
				organizationSlug: "acme",
			},
		);

		expect(result).toMatchObject({
			descopeResourceId: "local-acme-unified",
			mcpUrl: "http://localhost:3000",
		});
		expect(mocks.runToolSchemaSync).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				appId: "app-1",
				mode: "projection",
				router: "osWorkspaces",
				includeInternal: false,
				apply: true,
				toolIdOverrides: { "osWorkspaces/outputs/create": "create_os_output" },
			}),
		);
		expect(mocks.loadAllDescopeMcpServers).not.toHaveBeenCalled();
		expect(mocks.registerDescopeMcpResource).not.toHaveBeenCalled();
		expect(mocks.updateApp).toHaveBeenCalledWith(
			expect.anything(),
			"app-1",
			expect.objectContaining({
				metadata: expect.objectContaining({
					mcpConfig: expect.objectContaining({
						descopeResourceId: "local-acme-unified",
						provisioningStatus: "ready",
					}),
				}),
			}),
		);
	});

	it.each([
		{ total: 1, failed: 1 },
		{ total: 0, failed: 0 },
	])(
		"does not mark a local gateway ready when projection fails: %j",
		async (result) => {
			mocks.getAppBySlug.mockResolvedValue(app());
			mocks.runToolSchemaSync.mockResolvedValue(result);
			const { ensureOrganizationUnifiedGateway } =
				await import("./organization-mcp-gateway");
			await expect(
				ensureOrganizationUnifiedGateway(
					{} as never,
					{
						...ENV,
						ENVIRONMENT: "development",
						DESCOPE_PROJECT_ID: "local-development-disabled",
						TEDIX_LOCAL_DEMO_ENABLED: "true",
						MCP_URL: "http://localhost:3000",
					} as CloudflareEnv,
					{
						organizationId: "org-1",
						organizationName: "Acme",
						organizationSlug: "acme",
					},
				),
			).rejects.toThrow("Failed to provision local workspace tools");
			expect(mocks.updateApp).not.toHaveBeenCalled();
		},
	);

	it("refuses to reuse a globally colliding app slug", async () => {
		mocks.getAppBySlug.mockResolvedValue({
			...app(),
			organizationId: "other-org",
		});
		const {
			ensureOrganizationUnifiedGateway,
			OrganizationGatewaySlugConflictError,
		} = await import("./organization-mcp-gateway");

		await expect(
			ensureOrganizationUnifiedGateway({} as never, ENV, {
				organizationId: "org-1",
				organizationName: "Acme",
				organizationSlug: "acme",
			}),
		).rejects.toBeInstanceOf(OrganizationGatewaySlugConflictError);
		expect(mocks.loadAllDescopeMcpServers).not.toHaveBeenCalled();
	});
});

describe("renameOrganizationUnifiedGateway", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getTedisByOrganization.mockResolvedValue([
			{ id: "tedi-1", slug: "tedi-first", descopeUserId: "DU-first" },
		]);
		mocks.getManagementClient.mockReturnValue({});
		mocks.getAssignedAppRoles.mockResolvedValue({});
		mocks.syncTediAihClientForAssignment.mockResolvedValue({
			status: "created",
		});
		mocks.loadAllDescopeMcpServers.mockResolvedValue([]);
		mocks.registerDescopeMcpResource.mockResolvedValue({ id: "MS-new" });
		mocks.updateDescopeMcpServer.mockResolvedValue({ id: "MS-existing" });
		mocks.updateApp.mockImplementation(
			async (_db: unknown, id: string, update: Record<string, unknown>) => ({
				...app(update.metadata as Record<string, unknown>),
				id,
				...update,
			}),
		);
	});

	it("moves the existing gateway onto the new handle instead of creating a second one", async () => {
		// The resource the gateway already owns, as Descope would return it.
		mocks.loadAllDescopeMcpServers.mockResolvedValue([
			{
				id: "MS-existing",
				name: "Acme Unified MCP",
				audienceWhitelist: ["https://acme-demo-unified.mcp.tedix.dev/mcp"],
				tags: ["app:acme-demo-unified"],
			},
		]);
		// Resolved twice: the current gateway, then the free destination slug.
		mocks.getAppBySlug
			.mockResolvedValueOnce({
				...app({ mcpConfig: { descopeResourceId: "MS-existing" } }),
				slug: "acme-demo-unified",
			})
			.mockResolvedValueOnce(undefined)
			.mockResolvedValue({
				...app({ mcpConfig: { descopeResourceId: "MS-existing" } }),
				slug: "globex-unified",
			});
		const { renameOrganizationUnifiedGateway } =
			await import("./organization-mcp-gateway");

		const result = await renameOrganizationUnifiedGateway({} as never, ENV, {
			organizationId: "org-1",
			organizationName: "Globex",
			currentGatewaySlug: "acme-demo-unified",
			nextOrganizationSlug: "globex",
		});

		expect(mocks.createApp).not.toHaveBeenCalled();
		expect(mocks.updateApp).toHaveBeenCalledWith(
			expect.anything(),
			"app-1",
			expect.objectContaining({ slug: "globex-unified" }),
		);
		expect(result?.gatewaySlug).toBe("globex-unified");
		// The audience follows the handle, on the resource the app already owns:
		// updated in place, never re-registered as a second resource.
		expect(mocks.registerDescopeMcpResource).not.toHaveBeenCalled();
		expect(mocks.updateDescopeMcpServer).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				id: "MS-existing",
				audienceWhitelist: ["https://globex-unified.mcp.tedix.dev/mcp"],
			}),
		);
		expect(mocks.updateApp).toHaveBeenCalledWith(
			expect.anything(),
			"app-1",
			expect.objectContaining({
				metadata: expect.objectContaining({
					mcpConfig: expect.objectContaining({
						expectedAudience: "https://globex-unified.mcp.tedix.dev/mcp",
					}),
				}),
			}),
		);
	});

	it("refuses a destination handle owned by another organization before writing", async () => {
		mocks.getAppBySlug
			.mockResolvedValueOnce({ ...app(), slug: "acme-demo-unified" })
			.mockResolvedValueOnce({
				...app(),
				id: "app-2",
				organizationId: "other-org",
				slug: "globex-unified",
			});
		const {
			renameOrganizationUnifiedGateway,
			OrganizationGatewaySlugConflictError,
		} = await import("./organization-mcp-gateway");

		await expect(
			renameOrganizationUnifiedGateway({} as never, ENV, {
				organizationId: "org-1",
				organizationName: "Globex",
				currentGatewaySlug: "acme-demo-unified",
				nextOrganizationSlug: "globex",
			}),
		).rejects.toBeInstanceOf(OrganizationGatewaySlugConflictError);
		expect(mocks.updateApp).not.toHaveBeenCalled();
	});

	it("reports nothing to move when the organization has no gateway yet", async () => {
		const { renameOrganizationUnifiedGateway } =
			await import("./organization-mcp-gateway");

		await expect(
			renameOrganizationUnifiedGateway({} as never, ENV, {
				organizationId: "org-1",
				organizationName: "Globex",
				currentGatewaySlug: null,
				nextOrganizationSlug: "globex",
			}),
		).resolves.toBeNull();
		expect(mocks.updateApp).not.toHaveBeenCalled();
		expect(mocks.createApp).not.toHaveBeenCalled();
	});
});
