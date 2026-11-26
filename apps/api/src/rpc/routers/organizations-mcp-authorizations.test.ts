import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { apps } from "@tedix/db/schema/apps";
import { appCatalog } from "@tedix/db/schema/catalog";
import { organizations } from "@tedix/db/schema/organizations";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { auditEvents } from "@tedix/db/schema/audit-events";
import {
	replaceMcpConsentSelection,
	stageMcpConsentPending,
	getMcpConsentGrant,
	getMcpConsentPending,
} from "@tedix/db/queries/mcp-consent";
import {
	mcpConsentGrants,
	mcpConsentSelections,
	mcpConsentPending,
} from "@tedix/db/schema/mcp-consent";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
	vi,
} from "vite-plus/test";
import { forgetHumanMcpProviderFacts } from "../../lib/mcp-grant";
import { createContext } from "../context";
import {
	revokeMcpInstallationContract,
	verifyHumanMcpGrantContract,
} from "./organizations-mcp-authorizations";

const mocks = vi.hoisted(() => ({
	loadServer: vi.fn(),
	searchClients: vi.fn(),
	loadUser: vi.fn(),
	searchConsents: vi.fn(),
	resource: vi.fn(),
	revocationProof: vi.fn(),
}));

vi.mock("@tedix/auth/mcp-installation-revocation", () => ({
	verifyMcpRevocationProof: mocks.revocationProof,
}));

vi.mock("@tedix/auth/aih-client", () => ({
	loadDescopeMcpServer: mocks.loadServer,
	searchDescopeMcpServerClients: mocks.searchClients,
}));
vi.mock("@tedix/auth/client", () => ({
	getManagementClient: () => ({
		management: {
			user: { loadByUserId: mocks.loadUser },
			inboundApplication: { searchConsents: mocks.searchConsents },
		},
	}),
}));
vi.mock("@tedix/db/queries/mcp-consent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/mcp-consent")>()),
	getMcpConsentResource: mocks.resource,
}));
vi.mock("@tedix/db/queries/organization-members", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/organization-members")
	>()),
	getMembershipsByDescopeTenants: async () => [
		{
			organizationId: "00000000-0000-4000-8000-000000000001",
			descopeTenantId: "tenant-example",
			status: "active",
			inboundClientPolicyJson: null,
		},
	],
	getOrganizationAggregatorGateways: async () =>
		new Map([["00000000-0000-4000-8000-000000000001", { slug: "example" }]]),
}));

const input = {
	descopeUserId: "user-example",
	mcpServerId: "server-example",
	clientId: "client-example",
	consentId: "consent-example",
	consentRevision: "00000000-0000-4000-8000-000000000002",
	selectedTenantIds: ["tenant-example"],
	tokenScopes: ["mcp:apps.read"],
};
const selection = {
	descopeUserId: input.descopeUserId,
	mcpServerId: input.mcpServerId,
	clientId: input.clientId,
	appId: "app-example",
	revision: input.consentRevision,
	status: "active" as const,
	selectedTenantIds: input.selectedTenantIds,
	approvedScopes: input.tokenScopes,
};

beforeEach(() => {
	vi.resetAllMocks();
	forgetHumanMcpProviderFacts();
	mocks.resource.mockResolvedValue({
		appId: "resource-example",
		organizationId: "00000000-0000-4000-8000-000000000001",
		slug: "example",
		metadata: {
			mcpConfig: {
				multiOrgConsent: true,
				descopeResourceId: input.mcpServerId,
			},
		},
	});
	mocks.loadServer.mockResolvedValue({
		id: input.mcpServerId,
		type: "mcp",
		audienceWhitelist: ["https://example.test/mcp"],
		approvedScopes: { connectionsScopes: [{ name: "mcp:apps.read" }] },
	});
	mocks.searchClients.mockResolvedValue([
		{
			id: selection.appId,
			mcpServerId: input.mcpServerId,
			clientId: input.clientId,
			status: "verified",
		},
	]);
	mocks.loadUser.mockResolvedValue({
		ok: true,
		data: { userTenants: [{ tenantId: "tenant-example" }] },
	});
	mocks.searchConsents.mockResolvedValue({
		ok: true,
		data: [
			{
				id: input.consentId,
				appId: selection.appId,
				userId: input.descopeUserId,
				scopes: input.tokenScopes,
			},
		],
	});
});

function fixture() {
	const views = [new DatabaseSync(":memory:"), new DatabaseSync(":memory:")];
	onTestFinished(() => views.forEach((view) => view.close()));
	for (const view of views) {
		for (const table of [
			organizations,
			organizationMembers,
			appCatalog,
			apps,
			auditEvents,
			mcpConsentGrants,
			mcpConsentSelections,
			mcpConsentPending,
		])
			view.exec(schemaDdl(table));
		view.exec(`INSERT INTO organizations (id, name, slug, descope_tenant_id) VALUES ('00000000-0000-4000-8000-000000000001', 'Example', 'example', 'tenant-example');
		INSERT INTO organization_members (id, organization_id, descope_user_id, email, status) VALUES ('member', '00000000-0000-4000-8000-000000000001', 'user-example', 'person@example.test', 'active');
		INSERT INTO apps (id, organization_id, name, slug, metadata) VALUES ('resource-example', '00000000-0000-4000-8000-000000000001', 'Example', 'example-unified', '{"mcpConfig":{"multiOrgConsent":true,"descopeResourceId":"server-example","expectedAudience":"https://example.test/mcp","authMode":"authenticated","codeMode":true}}');`);
	}
	const [replica, primary] = views.map((view) => createD1Facade(view));
	const withSession = vi.fn((constraint: string) => {
		let source = constraint === "first-primary" ? primary! : replica!;
		return {
			prepare: (sql: string) => {
				if (!/^\s*select\b/i.test(sql)) source = primary!;
				return source.prepare(sql);
			},
			batch: (statements: D1PreparedStatement[]) => {
				source = primary!;
				return primary!.batch(statements);
			},
			getBookmark: () => null,
		};
	});
	const binding = { ...primary!, withSession } as D1Database;
	const context = createContext(
		new Request(
			"https://api.internal/rpc/organizations/verifyMultiOrgMcpGrant",
			{
				headers: { "X-Service-Binding": "true" },
			},
		),
		{
			DB: binding,
			DESCOPE_PROJECT_ID: "project-example",
			DESCOPE_MANAGEMENT_KEY: "key-example",
		} as CloudflareEnv,
	);
	const client = createRouterClient(
		{
			verify: verifyHumanMcpGrantContract,
			revokeMcpInstallation: revokeMcpInstallationContract,
		},
		{ context },
	);
	return {
		client,
		withSession,
		primary: createDbClient(primary!),
		replica: createDbClient(replica!),
	};
}

describe("grant verification across D1 replica lag", () => {
	it("accepts both the step-up union and the earlier revision of a shared client", async () => {
		const { client, primary } = fixture();
		await replaceMcpConsentSelection(primary, selection);
		const scopes = ["mcp:apps.read", "mcp:work.read"];
		mocks.loadServer.mockResolvedValue({
			id: input.mcpServerId,
			type: "mcp",
			audienceWhitelist: ["https://example.test/mcp"],
			approvedScopes: {
				connectionsScopes: scopes.map((name) => ({ name })),
			},
		});
		mocks.searchConsents.mockResolvedValue({
			ok: true,
			data: [
				{
					id: input.consentId,
					appId: selection.appId,
					userId: input.descopeUserId,
					scopes,
				},
			],
		});
		const staged = await stageMcpConsentPending(primary, {
			...selection,
			revision: "00000000-0000-4000-8000-000000000003",
			expectedActiveRevision: selection.revision,
			approvedScopes: ["mcp:work.read"],
			expiresAt: "2099-01-01T00:00:00.000Z",
		});
		await expect(
			client.verify({
				...input,
				consentRevision: staged.revision,
				tokenScopes: scopes,
				supportsConsentScopeCeiling: true,
			}),
		).resolves.toMatchObject({ allowed: true, effectiveScopes: scopes });
		await expect(
			client.verify({
				...input,
				tokenScopes: scopes,
				supportsConsentScopeCeiling: true,
			}),
		).resolves.toMatchObject({
			allowed: true,
			effectiveScopes: input.tokenScopes,
		});
	});

	it("revokes one install and its refresh token while another install sharing the same consent keeps working", async () => {
		const { client, primary, replica } = fixture();
		await replaceMcpConsentSelection(primary, selection);
		await replaceMcpConsentSelection(replica, selection);
		const second = {
			...input,
			consentRevision: "00000000-0000-4000-8000-000000000003",
		};
		await primary.insert(mcpConsentGrants).values([
			{ ...selection, revision: second.consentRevision },
			{ ...selection, clientId: "cli-client", revision: "cli-install" },
			{
				...selection,
				descopeUserId: "another-user",
				revision: "other-user-install",
			},
		]);
		await stageMcpConsentPending(primary, {
			...selection,
			expectedActiveRevision: selection.revision,
			expiresAt: "2099-01-01T00:00:00.000Z",
		});
		mocks.revocationProof.mockResolvedValue({
			descopeUserId: input.descopeUserId,
			clientId: input.clientId,
			revision: input.consentRevision,
			revocationEndpoint: "https://auth.example.test/revoke",
		});
		const provider = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", provider);
		onTestFinished(() => vi.unstubAllGlobals());
		await expect(client.verify(input)).resolves.toMatchObject({
			allowed: true,
		});
		await expect(client.verify(second)).resolves.toMatchObject({
			allowed: true,
		});
		await expect(
			client.revokeMcpInstallation({
				resourceUrl: "https://example.test/mcp",
				accessToken: "signed-install-proof",
				refreshToken: "removed-install-refresh",
			}),
		).resolves.toEqual({
			revoked: true,
			consentRevision: input.consentRevision,
		});
		const audit = await primary.select().from(auditEvents);
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			resourceType: "mcp_installation",
			resourceId: input.consentRevision,
		});
		expect(JSON.stringify(audit)).not.toContain("signed-install-proof");
		expect(JSON.stringify(audit)).not.toContain("removed-install-refresh");
		expect(provider).toHaveBeenCalledOnce();
		const [url, init] = provider.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://auth.example.test/revoke");
		expect(new URLSearchParams(init.body as URLSearchParams).get("token")).toBe(
			"removed-install-refresh",
		);
		expect(
			new URLSearchParams(init.body as URLSearchParams).get("client_id"),
		).toBe(input.clientId);
		await expect(client.verify(input)).resolves.toMatchObject({
			allowed: false,
			reason: "selection_replaced",
		});
		await expect(client.verify(second)).resolves.toMatchObject({
			allowed: true,
		});
		expect(
			await getMcpConsentGrant(primary, {
				...selection,
				revision: "cli-install",
				clientId: "cli-client",
			}),
		).not.toBeNull();
		expect(
			await getMcpConsentGrant(primary, {
				...selection,
				revision: "other-user-install",
				descopeUserId: "another-user",
			}),
		).not.toBeNull();
		expect(await getMcpConsentPending(primary, selection)).toBeNull();
		expect(mocks.searchConsents).toHaveBeenCalledWith({
			userId: input.descopeUserId,
			consentId: input.consentId,
		});
	});

	it.each(["missing", "expired pending"])(
		"verifies a fresh primary grant when the replica has %s consent",
		async (state) => {
			const { client, primary, replica, withSession } = fixture();
			await replaceMcpConsentSelection(primary, selection);
			if (state === "expired pending") {
				await stageMcpConsentPending(replica, {
					...selection,
					expectedActiveRevision: null,
					expiresAt: "2000-01-01T00:00:00.000Z",
				});
			}
			await expect(client.verify(input)).resolves.toMatchObject({
				allowed: true,
				reason: "active",
			});
			expect(withSession.mock.calls.map(([constraint]) => constraint)).toEqual([
				"first-unconstrained",
				"first-primary",
			]);
		},
	);

	it("refuses a removed grant even when the replica still allows it", async () => {
		const { client, replica, withSession } = fixture();
		await replaceMcpConsentSelection(replica, selection);
		await expect(client.verify(input)).resolves.toMatchObject({
			allowed: false,
		});
		expect(withSession).toHaveBeenCalledTimes(2);
	});

	it("answers a real missing grant negatively after only one primary retry", async () => {
		const { client, withSession } = fixture();
		await expect(client.verify(input)).resolves.toMatchObject({
			allowed: false,
			reason: "selection_replaced",
		});
		expect(withSession.mock.calls.map(([constraint]) => constraint)).toEqual([
			"first-unconstrained",
			"first-primary",
		]);
	});

	it.each([
		{ status: "revoked" as const },
		{ approvedScopes: ["mcp:work.read"] },
		{ selectedTenantIds: ["tenant-other"] },
	])("does not authorize an unusable primary grant: %j", async (change) => {
		const { client, primary, withSession } = fixture();
		await replaceMcpConsentSelection(primary, { ...selection, ...change });
		await expect(client.verify(input)).resolves.toMatchObject({
			allowed: false,
			reason: "selection_replaced",
		});
		expect(withSession).toHaveBeenCalledTimes(2);
	});

	it("keeps provider failure retryable instead of declaring consent invalid", async () => {
		const { client, primary, withSession } = fixture();
		await replaceMcpConsentSelection(primary, selection);
		mocks.loadUser.mockRejectedValue(new Error("Provider unavailable"));
		await expect(client.verify(input)).resolves.toMatchObject({
			allowed: false,
			reason: "provider_unavailable",
		});
		expect(withSession).toHaveBeenCalledTimes(2);
	});
});
