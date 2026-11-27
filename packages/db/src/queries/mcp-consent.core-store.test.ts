import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { apps } from "../schema/apps";
import { mcpConsentGrants } from "../schema/mcp-consent";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	countLiveMcpConsentGrants,
	disableMcpConsentSelection,
	finalizeMcpConsentGrant,
	getMcpConsentGrant,
	getMcpConsentResource,
	getMcpConsentVerificationState,
	listMcpConsentGrantClientsForTenant,
	listMcpConsentGrants,
	listMcpConsentSignIns,
	listMcpConsentSignInsForTenant,
	listMcpInboundClientAttempts,
	promoteMcpConsentPending,
	recordMcpInboundClientAttempt,
	replaceMcpConsentSelection,
	stageMcpConsentPending,
} from "./mcp-consent";

async function fixture(store: "d1" | "postgres"): Promise<DbClient> {
	let db: DbClient;
	if (store === "d1") {
		const sqlite = createMigratedSqlite();
		onTestFinished(() => sqlite.close());
		db = createDbClient(createD1Facade(sqlite));
	} else {
		const pg = await createPGliteFacade();
		onTestFinished(pg.close);
		db = pg.db;
		for (const migration of readMigrationFiles({
			migrationsFolder: fileURLToPath(
				new URL("../../drizzle-pg", import.meta.url),
			),
		}))
			for (const ddl of migration.sql) await pg.engine.exec(ddl);
	}
	await db.insert(coreTable(db, organizations)).values({
		id: "org",
		name: "Example",
		slug: "example",
		descopeTenantId: "tenant",
		metadata: { mcpInboundClientPolicy: { mode: "audit", entries: [] } },
	});
	await db.insert(coreTable(db, organizationMembers)).values({
		id: "member",
		organizationId: "org",
		descopeUserId: "person",
		email: "person@example.test",
		status: "active",
	});
	await db.insert(coreTable(db, apps)).values({
		id: "app",
		organizationId: "org",
		name: "Example",
		slug: "example-unified",
		metadata: {
			mcpConfig: {
				descopeResourceId: "resource",
				authMode: "authenticated",
				codeMode: true,
				multiOrgConsent: true,
			},
		},
	});
	return db;
}

const key = {
	descopeUserId: "person",
	mcpServerId: "resource",
	clientId: "agent",
};
const install = { ...key, revision: "install" };

describe.each(["d1", "postgres"] as const)("MCP consent (%s)", (store) => {
	it("reads grant, membership, gateway and audience state and stamps use", async () => {
		const db = await fixture(store);
		await replaceMcpConsentSelection(db, {
			...install,
			appId: "oauth-app",
			status: "active",
			clientName: "Agent",
			device: "laptop",
			selectedTenantIds: ["tenant"],
			approvedScopes: ["mcp:apps.read"],
		});
		const state = await getMcpConsentVerificationState(db, {
			...install,
			selectedTenantIds: ["tenant"],
		});
		expect(state?.current).toEqual({
			appId: "oauth-app",
			revision: "install",
			clientName: "Agent",
			device: "laptop",
			selectedTenantIds: ["tenant"],
			approvedScopes: ["mcp:apps.read"],
		});
		expect(state?.pending).toBeNull();
		expect(state?.resource).toMatchObject({
			appId: "app",
			descopeTenantId: "tenant",
		});
		expect(state?.resourceOwner).toEqual({
			resourceUrl: "https://example-unified.mcp.tedix.dev/mcp",
			resourceUrlOwners: 1,
		});
		const [membership] = state!.memberships;
		expect({
			...membership,
			inboundClientPolicyJson: JSON.parse(membership!.inboundClientPolicyJson!),
		}).toEqual({
			organizationId: "org",
			descopeTenantId: "tenant",
			status: "active",
			inboundClientPolicyJson: { mode: "audit", entries: [] },
			gatewaySlug: "example-unified",
		});
		expect(state?.gateways.get("org")?.slug).toBe("example-unified");
		expect(state?.touchDue).toBe(true);
		expect(await finalizeMcpConsentGrant(db, install, true)).toMatchObject({
			revision: "install",
		});
		expect(
			(
				await getMcpConsentVerificationState(db, {
					...install,
					selectedTenantIds: ["tenant"],
				})
			)?.touchDue,
		).toBe(false);
		expect(
			await getMcpConsentVerificationState(db, {
				...install,
				mcpServerId: "unknown",
				selectedTenantIds: ["tenant"],
			}),
		).toBeNull();

		expect(
			await getMcpConsentResource(db, { mcpServerId: "resource" }),
		).toMatchObject({ appId: "app", organizationId: "org" });
		expect(
			await getMcpConsentResource(db, {
				resourceUrl: "https://example-unified.mcp.tedix.dev/mcp",
			}),
		).toMatchObject({ appId: "app" });
		expect(
			await getMcpConsentResource(db, { resourceUrl: "https://elsewhere/mcp" }),
		).toBeNull();

		const [signIn] = await listMcpConsentSignInsForTenant(db, "tenant", {
			limit: 10,
			offset: 0,
		});
		expect(signIn).toMatchObject({
			revision: "install",
			clientName: "Agent",
			memberEmail: "person@example.test",
		});
		expect(
			await listMcpConsentSignInsForTenant(db, "other-tenant", {
				limit: 10,
				offset: 0,
			}),
		).toEqual([]);
		expect(await listMcpConsentGrantClientsForTenant(db, "tenant")).toEqual([
			{
				mcpServerId: "resource",
				clientId: "agent",
				people: 1,
				lastGrantedAt: expect.any(String),
			},
		]);
	});

	it("adds a step-up install, expires idle sign-ins and fences a disable", async () => {
		const db = await fixture(store);
		await replaceMcpConsentSelection(db, {
			...install,
			appId: "oauth-app",
			status: "active",
			selectedTenantIds: ["tenant"],
			approvedScopes: ["mcp:apps.read"],
		});
		// Idle past the TTL in both stored text formats.
		await db.insert(coreTable(db, mcpConsentGrants)).values([
			{
				...key,
				revision: "idle-iso",
				appId: "oauth-app",
				selectedTenantIds: ["tenant"],
				approvedScopes: [],
				createdAt: "2020-01-01T00:00:00.000Z",
			},
			{
				...key,
				revision: "idle-sqlite",
				appId: "oauth-app",
				selectedTenantIds: ["tenant"],
				approvedScopes: [],
				createdAt: "2020-01-01 00:00:00",
			},
		]);
		expect(await countLiveMcpConsentGrants(db, key)).toBe(1);
		expect(
			(await listMcpConsentSignIns(db, "person", { limit: 10, offset: 0 })).map(
				(grant) => grant.revision,
			),
		).toEqual(["install"]);

		const pending = await stageMcpConsentPending(db, {
			...key,
			appId: "oauth-app",
			revision: "step-up",
			expectedActiveRevision: "install",
			selectedTenantIds: ["tenant"],
			approvedScopes: ["mcp:work.read"],
			expiresAt: "2999-01-01T00:00:00.000Z",
		});
		expect(pending.approvedScopes).toEqual(["mcp:apps.read", "mcp:work.read"]);
		const promotion = {
			...key,
			appId: "oauth-app",
			revision: "step-up",
			expectedActiveRevision: "install",
			selectedTenantIds: ["tenant"],
			approvedScopes: pending.approvedScopes,
		};
		expect(
			await promoteMcpConsentPending(db, {
				...promotion,
				approvedScopes: ["x"],
			}),
		).toBe(false);
		expect(await promoteMcpConsentPending(db, promotion)).toBe(true);
		expect(
			(await listMcpConsentGrants(db, key))
				.map((grant) => grant.revision)
				.sort(),
		).toEqual(["install", "step-up"]);
		expect(
			await getMcpConsentGrant(db, { ...key, revision: "idle-iso" }),
		).toBeNull();

		// A first-use candidate needs an absent key.
		await stageMcpConsentPending(db, {
			...key,
			appId: "oauth-app",
			revision: "first-use",
			expectedActiveRevision: null,
			selectedTenantIds: ["tenant"],
			approvedScopes: ["mcp:apps.read"],
			expiresAt: "2999-01-01T00:00:00.000Z",
		});
		expect(
			await promoteMcpConsentPending(db, {
				...promotion,
				revision: "first-use",
				expectedActiveRevision: null,
				approvedScopes: ["mcp:apps.read", "mcp:work.read"],
			}),
		).toBe(false);

		expect(
			await disableMcpConsentSelection(db, {
				...key,
				expectedRevision: "stale",
				revision: "off",
			}),
		).toBeNull();
		expect(await listMcpConsentGrants(db, key)).toHaveLength(2);
		expect(
			await disableMcpConsentSelection(db, {
				...key,
				expectedRevision: "step-up",
				revision: "off",
			}),
		).toMatchObject({ status: "revoked", revision: "off" });
		expect(await listMcpConsentGrants(db, key)).toEqual([]);
	});

	it("skips an identical inbound decision inside the interval", async () => {
		const db = await fixture(store);
		const base = {
			organizationId: "org",
			mcpServerId: "resource",
			clientId: "agent",
			clientName: "Agent",
			stage: "consent" as const,
			mode: "audit" as const,
			listed: false,
			allowed: true,
			at: "2026-10-26T10:00:00.000Z",
			minIntervalSeconds: 300,
		};
		await recordMcpInboundClientAttempt(db, base);
		await recordMcpInboundClientAttempt(db, {
			...base,
			at: "2026-10-26T10:01:00.000Z",
		});
		await recordMcpInboundClientAttempt(db, {
			...base,
			clientName: null,
			allowed: false,
			at: "2026-10-26T10:02:00.000Z",
		});
		expect(await listMcpInboundClientAttempts(db, "org")).toEqual([
			expect.objectContaining({
				clientName: "Agent",
				lastListed: false,
				lastAllowed: false,
				attemptCount: 2,
				deniedCount: 1,
				lastSeenAt: "2026-10-26T10:02:00.000Z",
			}),
		]);
	});
});
