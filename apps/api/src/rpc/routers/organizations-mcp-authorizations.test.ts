import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import {
	replaceMcpConsentSelection,
	stageMcpConsentPending,
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
import { verifyHumanMcpGrantContract } from "./organizations-mcp-authorizations";

const mocks = vi.hoisted(() => ({
	loadServer: vi.fn(),
	searchClients: vi.fn(),
	loadUser: vi.fn(),
	searchConsents: vi.fn(),
	resource: vi.fn(),
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
			mcpConsentGrants,
			mcpConsentSelections,
			mcpConsentPending,
		])
			view.exec(schemaDdl(table));
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
		{ verify: verifyHumanMcpGrantContract },
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

	it("keeps a positive replica verification on its original session", async () => {
		const { client, replica, withSession } = fixture();
		await replaceMcpConsentSelection(replica, selection);
		await expect(client.verify(input)).resolves.toMatchObject({
			allowed: true,
		});
		expect(withSession).toHaveBeenCalledTimes(1);
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
