import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { connectionInstances } from "@tedix/db/schema/connection-instances";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { expect, it, vi } from "vite-plus/test";
import { userContext } from "../rpc/test-context";
import { discoverWorkspaceConnections } from "./workspace-available-connections";

vi.mock("../lib/descope-management", () => ({
	getDescopeManagement: () => ({
		management: {
			outboundApplication: {
				fetchToken: async () => ({ ok: false, code: 404 }),
				fetchTenantToken: async () => ({ ok: false, code: 404 }),
			},
		},
	}),
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: async () => ({ descopeTenantId: "tenant" }),
}));
vi.mock("@tedix/db/queries/connection-providers", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/connection-providers")
	>()),
	listConnectionProviders: async () => [],
}));
vi.mock("../rpc/routers/connections/discovery-user", () => ({
	readConnectionProviders: async () => ({
		data: [
			{
				appId: "example",
				name: "Example",
				description: null,
				logoUrl: null,
				availableScopes: [],
				enabled: true,
				connectionType: "oauth",
				registrationMode: "pre_registered",
				tokenScope: "user",
				recommendedScope: "user",
				supportedScopes: ["user", "tenant"],
				accountMode: "multiple",
				availableAccountModes: ["single", "multiple"],
			},
		],
	}),
}));
vi.mock("../rpc/routers/connections/provider-registration", () => ({
	collectReferencedProviders: async () => ({
		references: new Map(),
		complete: true,
		toolCapabilities: new Map([
			["example", [{ id: "read", label: "Read records", riskTier: "read" }]],
		]),
		toolCapabilitiesComplete: new Map(),
	}),
}));
vi.mock("../rpc/routers/connections/policy-resolution", () => ({
	requireUserId: (context: { user: { sub: string } }) => context.user.sub,
	fetchNamedConnection: async () => ({
		accessToken: "private-token",
		scopes: [],
	}),
	authedOs: {
		getConnectionsOverview: { use: () => ({ handler: () => ({}) }) },
	},
}));

it("uses the Connections page inventory while keeping personal accounts and opaque choices bound to the sender", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(connectionInstances));
	const env = { DB: createD1Facade(sqlite) } as CloudflareEnv;
	const db = createDbClient(env.DB);
	for (const [id, ownerUserId, organizationId, label] of [
		["a", "alice", null, "Alice account"],
		["b", "bob", null, "Bob account"],
		["o", "admin", "org-1", "Shared account"],
		["x", "admin", "org-2", "Other org account"],
	] as const) {
		await db
			.insert(connectionInstances)
			.values({
				id,
				ownerUserId,
				organizationId,
				providerId: "example",
				label,
				tokenIds: ["private-grant"],
				tokenSub: "private-sub",
				createdAt: "2026-01-01",
				updatedAt: "2026-01-01",
			});
	}
	const read = (sub: string) =>
		discoverWorkspaceConnections(
			userContext({ env, organizationId: "org-1", sub }),
		);
	const alice = await read("alice");
	const bob = await read("bob");
	expect(alice.map((row) => row.label)).toEqual([
		"Shared account",
		"Alice account",
	]);
	expect(bob.map((row) => row.label)).toEqual([
		"Shared account",
		"Bob account",
	]);
	expect(alice.every((row) => row.connectedForYou && row.hybrid)).toBe(true);
	expect(alice[0]?.access).toEqual([
		{ label: "Read records", riskTier: "read" },
	]);
	expect(alice.some((row) => bob.some((other) => other.id === row.id))).toBe(
		false,
	);
	const json = JSON.stringify(alice);
	for (const secret of [
		"private-token",
		"private-grant",
		"private-sub",
		"Bob account",
		"Other org account",
	])
		expect(json).not.toContain(secret);
	expect((await db.select().from(connectionInstances)).length).toBe(4);
	sqlite.close();
});
