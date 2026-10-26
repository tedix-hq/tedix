import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import {
	recordMcpInboundClientAttempt,
	replaceMcpConsentSelection,
} from "@tedix/db/queries/mcp-consent";
import {
	mcpConsentGrants,
	mcpConsentSelections,
	mcpInboundClientAttempts,
} from "@tedix/db/schema/mcp-consent";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ORG_ID = "00000000-0000-4000-8000-0000000000b2";
const CIMD = "https://agent-host.example/oauth/client.json";

const mocks = vi.hoisted(() => ({
	getOrganizationById: vi.fn(),
	resource: vi.fn(),
}));

vi.mock("@tedix/db/queries/organizations", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/organizations")>()),
	getOrganizationById: mocks.getOrganizationById,
}));
vi.mock("@tedix/db/queries/mcp-consent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/mcp-consent")>()),
	getMcpConsentResource: mocks.resource,
}));

async function fixture(
	overrides: Partial<BaseContext> = {},
	policy: unknown = {
		mode: "enforce",
		entries: [{ mcpServerId: "server-1", clientId: CIMD }],
	},
) {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	for (const table of [
		mcpConsentSelections,
		mcpConsentGrants,
		mcpInboundClientAttempts,
	])
		sqlite.exec(schemaDdl(table));
	const db = createDbClient(createD1Facade(sqlite));
	mocks.getOrganizationById.mockResolvedValue({
		id: ORG_ID,
		descopeTenantId: "tenant-a",
		metadata: policy === undefined ? {} : { mcpInboundClientPolicy: policy },
	});
	mocks.resource.mockResolvedValue({ slug: "acme-gateway" });
	const grant = {
		mcpServerId: "server-1",
		appId: "app-1",
		status: "active" as const,
		approvedScopes: ["mcp:apps.read"],
	};
	await replaceMcpConsentSelection(db, {
		...grant,
		descopeUserId: "user-1",
		clientId: CIMD,
		revision: "r1",
		selectedTenantIds: ["tenant-a"],
	});
	await replaceMcpConsentSelection(db, {
		...grant,
		descopeUserId: "user-2",
		clientId: "dcr-client-1",
		revision: "r2",
		selectedTenantIds: ["tenant-a", "tenant-b"],
	});
	// Another organization's client never appears.
	await replaceMcpConsentSelection(db, {
		...grant,
		descopeUserId: "user-3",
		clientId: "dcr-client-other",
		revision: "r3",
		selectedTenantIds: ["tenant-b"],
	});
	await recordMcpInboundClientAttempt(db, {
		organizationId: ORG_ID,
		mcpServerId: "server-1",
		clientId: "dcr-client-1",
		clientName: "Notes Helper",
		stage: "grant",
		mode: "enforce",
		listed: false,
		allowed: false,
		at: "2026-10-26T10:00:00.000Z",
		minIntervalSeconds: 300,
	});
	await recordMcpInboundClientAttempt(db, {
		organizationId: OTHER_ORG_ID,
		mcpServerId: "server-1",
		clientId: "dcr-client-foreign",
		clientName: "Foreign",
		stage: "consent",
		mode: "none",
		listed: false,
		allowed: true,
		at: "2026-10-26T11:00:00.000Z",
		minIntervalSeconds: 300,
	});
	const context = {
		authType: "user",
		db,
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		userRole: "admin",
		url: new URL("https://api.tedix.test/rpc/organizations"),
		user: {
			aud: "test",
			dct: "tenant-a",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: ["settings:manage"],
			roles: [],
			sub: "user-admin",
		},
		...overrides,
	} as BaseContext;
	const { listInboundClientInventoryContract } =
		await import("./organizations-mcp-authorizations");
	return createRouterClient(
		{ list: listInboundClientInventoryContract },
		{ context },
	);
}

describe("organizations.listInboundClientInventory", () => {
	it("merges this organization's grants and recorded attempts, judged against the stored policy", async () => {
		const client = await fixture();
		const result = await client.list({ organizationId: ORG_ID });
		expect(result.policyInvalid).toBe(false);
		expect(result.policy).toMatchObject({ mode: "enforce" });
		expect(result.items).toHaveLength(2);
		const byId = (clientId: string) =>
			result.items.find((item) => item.clientId === clientId);
		expect(byId("dcr-client-1")).toMatchObject({
			clientName: "Notes Helper",
			clientKind: "opaque",
			serverSlug: "acme-gateway",
			connectedPeople: 1,
			listed: false,
			allowedNow: false,
			lastAttempt: { stage: "grant", allowed: false, denied: 1 },
		});
		expect(byId(CIMD)).toMatchObject({
			lastGrantedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
			clientKind: "cimd",
			connectedPeople: 1,
			listed: true,
			allowedNow: true,
			lastAttempt: null,
		});
		expect(JSON.stringify(result)).not.toMatch(/user-|foreign|other/);
	});

	it("reports a stored policy that does not parse", async () => {
		const client = await fixture({}, { mode: "enforce" });
		const result = await client.list({ organizationId: ORG_ID });
		expect(result).toMatchObject({ policy: null, policyInvalid: true });
		expect(result.items.every((item) => !item.allowedNow)).toBe(true);
	});

	it.each([
		["a member", { userRole: "member" }, ORG_ID],
		["an admin of another organization", {}, OTHER_ORG_ID],
		[
			"an API key holding the read scope",
			{
				authType: "apikey",
				userRole: undefined,
				apiKey: { scopes: ["apps:read"] },
			},
			ORG_ID,
		],
	] as const)("refuses %s", async (_label, overrides, organizationId) => {
		const client = await fixture(overrides as Partial<BaseContext>);
		await expect(client.list({ organizationId })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
