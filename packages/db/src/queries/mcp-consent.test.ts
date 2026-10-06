import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { appCatalog } from "../schema/catalog";
import { apps } from "../schema/apps";
import { organizations } from "../schema/organizations";
import { mcpConsentSelections, mcpConsentPending } from "../schema/mcp-consent";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getMcpConsentResource,
	stageMcpConsentPending,
	getMcpConsentPending,
	promoteMcpConsentPending,
	disableMcpConsentSelection,
	listMcpConsentSelections,
	getMcpConsentSelection,
	replaceMcpConsentSelection,
} from "./mcp-consent";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(mcpConsentSelections));
	sqlite.exec(schemaDdl(mcpConsentPending));
	sqlite.exec(schemaDdl(organizations));
	sqlite.exec(schemaDdl(appCatalog));
	sqlite.exec(schemaDdl(apps));
	return createDbQueryClient(createD1Facade(sqlite));
}

describe("current MCP consent selection", () => {
	it("atomically replaces the old revision and authority set without crossing clients", async () => {
		const db = fixture();
		const key = {
			descopeUserId: "user-1",
			mcpServerId: "connect-resource",
			clientId: "client-1",
		};
		const first = {
			...key,
			appId: "app-1",
			revision: "revision-1",
			status: "active" as const,
			selectedTenantIds: ["org_tedix", "org_sample"],
			approvedScopes: ["mcp:apps.read", "mcp:work.read"],
		};
		await replaceMcpConsentSelection(db, first);
		await replaceMcpConsentSelection(db, {
			...first,
			clientId: "client-2",
			revision: "other-client",
		});
		await replaceMcpConsentSelection(db, {
			...first,
			revision: "revision-2",
			selectedTenantIds: ["org_tedix"],
			approvedScopes: ["mcp:apps.read"],
		});
		expect(await getMcpConsentSelection(db, key)).toMatchObject({
			revision: "revision-2",
			selectedTenantIds: ["org_tedix"],
			approvedScopes: ["mcp:apps.read"],
		});
		expect(
			await getMcpConsentSelection(db, { ...key, clientId: "client-2" }),
		).toMatchObject({ revision: "other-client" });
		await replaceMcpConsentSelection(db, {
			...first,
			revision: "revision-3",
			status: "revoked",
			selectedTenantIds: [],
			approvedScopes: [],
		});
		expect(await getMcpConsentSelection(db, key)).toMatchObject({
			revision: "revision-3",
			status: "revoked",
			selectedTenantIds: [],
			approvedScopes: [],
		});
	});
});

it("isolates subject/resource pagination and current revision disable", async () => {
	const db = fixture();
	const key = {
		descopeUserId: "owner",
		mcpServerId: "connect",
		clientId: "one",
	};
	const row = {
		...key,
		appId: "app",
		revision: "r1",
		status: "active" as const,
		selectedTenantIds: ["tenant"],
		approvedScopes: ["mcp:work.read"],
	};
	for (const other of [
		row,
		{ ...row, clientId: "two" },
		{ ...row, descopeUserId: "other" },
		{ ...row, mcpServerId: "other" },
	])
		await replaceMcpConsentSelection(db, other);
	expect(
		(await listMcpConsentSelections(db, { ...key, limit: 1, offset: 0 })).map(
			(item) => item.clientId,
		),
	).toEqual(["one"]);
	expect(
		(await listMcpConsentSelections(db, { ...key, limit: 1, offset: 1 })).map(
			(item) => item.clientId,
		),
	).toEqual(["two"]);
	expect(
		await disableMcpConsentSelection(db, {
			...key,
			expectedRevision: "old",
			revision: "r2",
		}),
	).toBeNull();
	expect(
		await disableMcpConsentSelection(db, {
			...key,
			descopeUserId: "stranger",
			expectedRevision: "r1",
			revision: "r2",
		}),
	).toBeNull();
	expect(
		await disableMcpConsentSelection(db, {
			...key,
			expectedRevision: "r1",
			revision: "r2",
		}),
	).toMatchObject({
		revision: "r2",
		status: "revoked",
		selectedTenantIds: [],
		approvedScopes: [],
	});
	expect(
		await getMcpConsentSelection(db, { ...key, clientId: "two" }),
	).toMatchObject({ status: "active", revision: "r1" });
});

it("resolves exact configured audience and owning tenant, rejecting unknown and duplicate resources", async () => {
	const db = fixture();
	await db.insert(organizations).values({
		id: "org",
		name: "One",
		slug: "one",
		descopeTenantId: "tenant-one",
	});
	await db.insert(apps).values({
		id: "app",
		organizationId: "org",
		name: "One app",
		slug: "one",
		metadata: {
			mcpConfig: {
				descopeResourceId: "resource-one",
				expectedAudience: "https://configured.example/mcp",
			},
		},
	});
	expect(
		await getMcpConsentResource(db, {
			resourceUrl: "https://configured.example/mcp",
		}),
	).toMatchObject({
		appId: "app",
		organizationId: "org",
		descopeTenantId: "tenant-one",
	});
	expect(
		await getMcpConsentResource(db, {
			resourceUrl: "https://one.mcp.tedix.dev/mcp",
		}),
	).toBeNull();
	expect(
		await getMcpConsentResource(db, { mcpServerId: "unknown" }),
	).toBeNull();
	await db.insert(apps).values({
		id: "duplicate",
		organizationId: "org",
		name: "Duplicate",
		slug: "duplicate",
		metadata: {
			mcpConfig: {
				descopeResourceId: "resource-one",
				expectedAudience: "https://configured.example/mcp",
			},
		},
	});
	expect(
		await getMcpConsentResource(db, {
			resourceUrl: "https://configured.example/mcp",
		}),
	).toBeNull();
	expect(
		await getMcpConsentResource(db, { mcpServerId: "resource-one" }),
	).toBeNull();
});

describe("pending MCP consent activation on real D1 SQL", () => {
	const key = {
		descopeUserId: "owner",
		mcpServerId: "resource",
		clientId: "client",
	};
	const authority = {
		...key,
		appId: "app",
		selectedTenantIds: ["tenant"],
		approvedScopes: ["mcp:apps.read"],
	};
	const pending = {
		...authority,
		revision: "candidate",
		expectedActiveRevision: "old",
		expiresAt: "2999-01-01T00:00:00.000Z",
	};
	const active = {
		...authority,
		revision: "old",
		status: "active" as const,
		approvedScopes: ["mcp:apps.read", "mcp:work.read"],
	};
	it("preserves the active grant while pending, activates once and fences old contenders", async () => {
		const db = fixture();
		await replaceMcpConsentSelection(db, active);
		await stageMcpConsentPending(db, pending);
		await stageMcpConsentPending(db, { ...pending, revision: "competitor" });
		expect(await getMcpConsentSelection(db, key)).toMatchObject({
			revision: "old",
		});
		expect(
			await getMcpConsentPending(db, { ...key, revision: "candidate" }),
		).toMatchObject({ expectedActiveRevision: "old" });
		const results = await Promise.all([
			promoteMcpConsentPending(db, pending),
			promoteMcpConsentPending(db, { ...pending, revision: "competitor" }),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(await promoteMcpConsentPending(db, pending)).toBe(false);
		expect(await getMcpConsentSelection(db, key)).toMatchObject({
			revision: "candidate",
			status: "active",
		});
	});
	it("serializes activation against a concurrent revoke and blocks later replay", async () => {
		const db = fixture();
		await replaceMcpConsentSelection(db, active);
		await stageMcpConsentPending(db, pending);
		const [promoted, revoked] = await Promise.all([
			promoteMcpConsentPending(db, pending),
			disableMcpConsentSelection(db, {
				...key,
				expectedRevision: "old",
				revision: "revoked",
			}),
		]);
		expect(Number(promoted) + Number(Boolean(revoked))).toBe(1);
		const current = await getMcpConsentSelection(db, key);
		if (current?.status === "active") {
			await disableMcpConsentSelection(db, {
				...key,
				expectedRevision: current.revision,
				revision: "revoked-after-activation",
			});
		}
		expect(await promoteMcpConsentPending(db, pending)).toBe(false);
		expect(await getMcpConsentSelection(db, key)).toMatchObject({
			status: "revoked",
		});
	});

	it("allows first-use activation only while the exact active key is absent", async () => {
		const db = fixture();
		const first = { ...pending, expectedActiveRevision: null };
		await stageMcpConsentPending(db, first);
		expect(await promoteMcpConsentPending(db, first)).toBe(true);
		const other = { ...first, revision: "late" };
		await stageMcpConsentPending(db, other);
		expect(await promoteMcpConsentPending(db, other)).toBe(false);
	});
	it("revocation wins against a pending activation and replay cannot resurrect", async () => {
		const db = fixture();
		await replaceMcpConsentSelection(db, active);
		await stageMcpConsentPending(db, pending);
		await disableMcpConsentSelection(db, {
			...key,
			expectedRevision: "old",
			revision: "revoked",
		});
		expect(await promoteMcpConsentPending(db, pending)).toBe(false);
		expect(await getMcpConsentSelection(db, key)).toMatchObject({
			status: "revoked",
			revision: "revoked",
		});
	});
	it("a first-use candidate cannot overwrite a later revocation tombstone", async () => {
		const db = fixture();
		const first = { ...pending, expectedActiveRevision: null };
		await stageMcpConsentPending(db, first);
		await replaceMcpConsentSelection(db, {
			...active,
			revision: "revoked",
			status: "revoked",
			approvedScopes: [],
			selectedTenantIds: [],
		});
		expect(await promoteMcpConsentPending(db, first)).toBe(false);
	});
	it.each([
		{ descopeUserId: "other" },
		{ mcpServerId: "other" },
		{ clientId: "other" },
		{ appId: "other" },
		{ revision: "other" },
		{ expectedActiveRevision: "other" },
		{ approvedScopes: ["mcp:apps.write"] },
		{ selectedTenantIds: ["other"] },
	])("atomically rejects changed identity or authority %#", async (change) => {
		const db = fixture();
		await replaceMcpConsentSelection(db, active);
		await stageMcpConsentPending(db, pending);
		expect(await promoteMcpConsentPending(db, { ...pending, ...change })).toBe(
			false,
		);
		expect(await getMcpConsentSelection(db, key)).toMatchObject({
			revision: "old",
		});
	});
	it("checks expiration inside the promotion statement", async () => {
		const db = fixture();
		await replaceMcpConsentSelection(db, active);
		await stageMcpConsentPending(db, {
			...pending,
			expiresAt: "2000-01-01T00:00:00.000Z",
		});
		expect(await promoteMcpConsentPending(db, pending)).toBe(false);
		expect(await getMcpConsentSelection(db, key)).toMatchObject({
			revision: "old",
		});
	});
});
