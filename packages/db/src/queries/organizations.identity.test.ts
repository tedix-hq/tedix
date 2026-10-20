/**
 * Organization identity — slugs, external identity lookups, retirement and the
 * personal-organization join, executed against the D1 facade. The facade
 * rejects `db.transaction()` and duplicate output column names, so every query
 * here is also checked against those D1 invariants.
 */

import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { apiKeys } from "../schema/api-keys";
import { apps } from "../schema/apps";
import { organizationMembers } from "../schema/organization-members";
import {
	DEFAULT_ORGANIZATION_FEATURES_BY_PLAN,
	organizations,
} from "../schema/organizations";
import { principalIdentities } from "../schema/principal-identities";
import { tedis } from "../schema/tedis";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	bindOrganizationExternalIdentity,
	generateUniqueSlug,
	getOrganizationByDescopeId,
	getOrganizationByExternalIdentity,
	getOrganizationById,
	getOrganizationBySlug,
	getPersonalOrganization,
	isSlugAvailable,
	listOrganizations,
	retireOrganization,
} from "./organizations";
import {
	bindPrincipalIdentity,
	PrincipalIdentityConflictError,
} from "./principal-identities";

const NOW = "2026-10-20T12:00:00.000Z";
const RETIRED_AT = "2026-10-21T08:00:00.000Z";

let sqlite: DatabaseSync | undefined;

function setup(): DbClient {
	sqlite = new DatabaseSync(":memory:");
	// `tedis` and `apps` reference control-plane and catalog tables that the
	// retirement batch never reads.
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			organizations,
			organizationMembers,
			principalIdentities,
			tedis,
			apiKeys,
			apps,
		),
	);
	return createDbClient(createD1Facade(sqlite));
}

afterEach(() => {
	vi.restoreAllMocks();
	sqlite?.close();
	sqlite = undefined;
});

function org(
	id: string,
	overrides: Partial<typeof organizations.$inferInsert> = {},
) {
	return {
		id,
		name: id,
		slug: id,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

describe("slugs", () => {
	it("reports availability case-insensitively and honours the exclusion", async () => {
		const db = setup();
		await db.insert(organizations).values(org("org-acme", { slug: "acme" }));

		expect(await isSlugAvailable(db, "acme")).toBe(false);
		expect(await isSlugAvailable(db, "ACME")).toBe(false);
		expect(await isSlugAvailable(db, "acme", "org-acme")).toBe(true);
		expect(await isSlugAvailable(db, "acme", "org-someone-else")).toBe(false);
		expect(await isSlugAvailable(db, "acme-2")).toBe(true);
	});

	it("normalises the name into a slug", async () => {
		const db = setup();
		expect(await generateUniqueSlug(db, "Acme GmbH!")).toBe("acme-gmbh");
		expect(await generateUniqueSlug(db, "  Ünïcode -- Co. ")).toBe("n-code-co");
	});

	it("appends a random suffix when the base slug is taken", async () => {
		const db = setup();
		await db
			.insert(organizations)
			.values(org("org-acme", { slug: "acme-gmbh" }));
		vi.spyOn(Math, "random").mockReturnValue(0.123456789);
		const suffix = (0.123456789).toString(36).substring(2, 6);

		expect(await generateUniqueSlug(db, "Acme GmbH!")).toBe(
			`acme-gmbh-${suffix}`,
		);
	});

	it("falls back to a UUID suffix after ten colliding random suffixes", async () => {
		const db = setup();
		vi.spyOn(Math, "random").mockReturnValue(0.123456789);
		const suffix = (0.123456789).toString(36).substring(2, 6);
		await db
			.insert(organizations)
			.values([
				org("org-base", { slug: "acme-gmbh" }),
				org("org-suffixed", { slug: `acme-gmbh-${suffix}` }),
			]);

		const slug = await generateUniqueSlug(db, "Acme GmbH!");

		expect(slug).toMatch(/^acme-gmbh-[0-9a-f]{8}$/);
		expect(slug).not.toBe(`acme-gmbh-${suffix}`);
		expect(Math.random).toHaveBeenCalledTimes(10);
	});
});

describe("lookups", () => {
	it("finds a live organization by Descope tenant and ignores a retired one", async () => {
		const db = setup();
		await db.insert(organizations).values([
			org("org-live", { descopeTenantId: "T_live" }),
			org("org-retired", {
				descopeTenantId: "T_retired",
				metadata: { retiredAt: RETIRED_AT } as never,
			}),
		]);

		expect((await getOrganizationByDescopeId(db, "T_live"))?.id).toBe(
			"org-live",
		);
		expect(await getOrganizationByDescopeId(db, "T_retired")).toBeUndefined();
		expect(await getOrganizationByDescopeId(db, "T_unknown")).toBeUndefined();
	});

	it("binds an external identity and resolves it back, normalised", async () => {
		const db = setup();
		await db.insert(organizations).values(org("org-bound"));

		await bindOrganizationExternalIdentity(
			db,
			"org-bound",
			{
				provider: "Descope",
				issuer: "https://auth.example.test/P-project/",
				subject: "T_bound",
			},
			NOW,
		);

		const resolved = await getOrganizationByExternalIdentity(db, {
			provider: "descope",
			issuer: "https://auth.example.test/P-project",
			subject: "T_bound",
		});
		expect(resolved?.id).toBe("org-bound");

		const [mapping] = await db.select().from(principalIdentities);
		expect(mapping).toMatchObject({
			organizationId: "org-bound",
			principalType: "organization",
			principalId: "org-bound",
			provider: "descope",
			issuer: "https://auth.example.test/P-project",
			subject: "T_bound",
			status: "active",
			lastVerifiedAt: NOW,
		});
	});

	it("does not resolve an organization through a user-bound identity", async () => {
		const db = setup();
		await db.insert(organizations).values(org("org-host"));
		const identity = {
			provider: "descope",
			issuer: "https://auth.example.test/P-project",
			subject: "U_person",
		};
		await bindPrincipalIdentity(db, {
			organizationId: "org-host",
			principalType: "user",
			principalId: "user-1",
			...identity,
		});

		expect(
			await getOrganizationByExternalIdentity(db, identity),
		).toBeUndefined();
		expect(
			await getOrganizationByExternalIdentity(db, {
				...identity,
				subject: "T_nobody",
			}),
		).toBeUndefined();
	});

	it("refuses to rebind an identity to a second organization", async () => {
		const db = setup();
		await db
			.insert(organizations)
			.values([org("org-first"), org("org-second")]);
		const identity = {
			provider: "descope",
			issuer: "https://auth.example.test/P-project",
			subject: "T_shared",
		};
		await bindOrganizationExternalIdentity(db, "org-first", identity);

		await expect(
			bindOrganizationExternalIdentity(db, "org-second", identity),
		).rejects.toBeInstanceOf(PrincipalIdentityConflictError);
		expect((await getOrganizationByExternalIdentity(db, identity))?.id).toBe(
			"org-first",
		);
	});
});

describe("retireOrganization", () => {
	async function seedTenant(db: DbClient) {
		await db.insert(organizations).values([
			org("org-1", {
				slug: "acme",
				descopeTenantId: "T_acme",
				metadata: { contactEmail: "ops@example.test" },
				features: { os: true, maxApps: 2 },
			}),
			org("org-bystander", { slug: "bystander" }),
		]);
		await db.insert(tedis).values([
			{ id: "tedi-live", organizationId: "org-1", name: "CTO", slug: "cto" },
			{
				id: "tedi-gone",
				organizationId: "org-1",
				name: "Old",
				slug: "old-retired-tedi-gone",
				retiredAt: "2026-05-01T00:00:00.000Z",
				retiredSlug: "old",
				status: "paused",
				runtimeState: "archived",
				isolateAgentId: "old",
			},
			{
				id: "tedi-bystander",
				organizationId: "org-bystander",
				name: "Other",
				slug: "other",
			},
		]);
		await db.insert(apiKeys).values([
			{
				id: "key-active",
				organizationId: "org-1",
				name: "deploy",
				keyHash: "hash-active",
				keyPreview: "tdx_…a",
				status: "active",
			},
			{
				id: "key-bystander",
				organizationId: "org-bystander",
				name: "deploy",
				keyHash: "hash-bystander",
				keyPreview: "tdx_…b",
				status: "active",
			},
		]);
		await db.insert(apps).values([
			{
				id: "app-1",
				organizationId: "org-1",
				name: "Site",
				slug: "site",
				visibility: "public",
			},
			{
				id: "app-bystander",
				organizationId: "org-bystander",
				name: "Site",
				slug: "site",
				visibility: "public",
			},
		]);
		await db.insert(organizationMembers).values([
			{
				id: "m-1",
				organizationId: "org-1",
				descopeUserId: "U1",
				email: "u1@example.test",
				status: "active",
			},
			{
				id: "m-bystander",
				organizationId: "org-bystander",
				descopeUserId: "U1",
				email: "u1@example.test",
				status: "active",
			},
		]);
	}

	function retireParams() {
		return {
			id: "org-1",
			retiredAt: RETIRED_AT,
			retiredBy: "U-admin",
			metadata: {
				contactEmail: "ops@example.test",
				retiredAt: RETIRED_AT,
				retiredSlug: "acme",
				memoryRetained: true as const,
			},
			features: { ...DEFAULT_ORGANIZATION_FEATURES_BY_PLAN.starter, os: false },
		};
	}

	it("tombstones the organization and its live dependants in one batch", async () => {
		const db = setup();
		await seedTenant(db);

		const retired = await retireOrganization(db, retireParams());

		expect(retired).toMatchObject({
			id: "org-1",
			slug: "acme-retired-org-1",
			descopeTenantId: "T_acme",
			updatedAt: RETIRED_AT,
			features: { ...DEFAULT_ORGANIZATION_FEATURES_BY_PLAN.starter, os: false },
			metadata: {
				contactEmail: "ops@example.test",
				retiredAt: RETIRED_AT,
				retiredSlug: "acme",
				memoryRetained: true,
			},
		});

		const [liveTedi] = await db
			.select()
			.from(tedis)
			.where(eq(tedis.id, "tedi-live"));
		expect(liveTedi).toMatchObject({
			retiredAt: RETIRED_AT,
			retiredSlug: "cto",
			slug: "cto-retired-tedi-live",
			isolateAgentId: "cto",
			status: "paused",
			runtimeState: "archived",
			updatedAt: RETIRED_AT,
		});
		const [goneTedi] = await db
			.select()
			.from(tedis)
			.where(eq(tedis.id, "tedi-gone"));
		expect(goneTedi).toMatchObject({
			retiredAt: "2026-05-01T00:00:00.000Z",
			slug: "old-retired-tedi-gone",
		});

		const [key] = await db
			.select()
			.from(apiKeys)
			.where(eq(apiKeys.id, "key-active"));
		expect(key).toMatchObject({
			status: "revoked",
			revokedAt: RETIRED_AT,
			revokedBy: "U-admin",
			revokeReason: "Organization retired",
		});
		const [app] = await db.select().from(apps).where(eq(apps.id, "app-1"));
		expect(app).toMatchObject({
			visibility: "disabled",
			updatedAt: RETIRED_AT,
		});
		const [member] = await db
			.select()
			.from(organizationMembers)
			.where(eq(organizationMembers.id, "m-1"));
		expect(member).toMatchObject({
			status: "deactivated",
			updatedAt: RETIRED_AT,
		});

		const bystanderTedi = await db
			.select()
			.from(tedis)
			.where(eq(tedis.id, "tedi-bystander"));
		expect(bystanderTedi[0]?.retiredAt).toBeNull();
		const bystanderKey = await db
			.select()
			.from(apiKeys)
			.where(eq(apiKeys.id, "key-bystander"));
		expect(bystanderKey[0]?.status).toBe("active");
		const bystanderApp = await db
			.select()
			.from(apps)
			.where(eq(apps.id, "app-bystander"));
		expect(bystanderApp[0]?.visibility).toBe("public");
		const bystanderMember = await db
			.select()
			.from(organizationMembers)
			.where(eq(organizationMembers.id, "m-bystander"));
		expect(bystanderMember[0]?.status).toBe("active");
	});

	it("hides the organization from slug, tenant and list reads but not from id reads", async () => {
		const db = setup();
		await seedTenant(db);
		await retireOrganization(db, retireParams());

		expect((await listOrganizations(db)).map((row) => row.id)).toEqual([
			"org-bystander",
		]);
		expect(await getOrganizationBySlug(db, "acme")).toBeUndefined();
		expect(
			await getOrganizationBySlug(db, "acme-retired-org-1"),
		).toBeUndefined();
		expect(await getOrganizationByDescopeId(db, "T_acme")).toBeUndefined();
		expect((await getOrganizationById(db, "org-1"))?.slug).toBe(
			"acme-retired-org-1",
		);
		expect(await isSlugAvailable(db, "acme")).toBe(true);
	});

	it("is a no-op on a retry", async () => {
		const db = setup();
		await seedTenant(db);
		await retireOrganization(db, retireParams());

		const again = await retireOrganization(db, {
			...retireParams(),
			retiredAt: "2026-12-31T00:00:00.000Z",
		});

		expect(again).toBeUndefined();
		expect((await getOrganizationById(db, "org-1"))?.updatedAt).toBe(
			RETIRED_AT,
		);
		const [tedi] = await db
			.select()
			.from(tedis)
			.where(eq(tedis.id, "tedi-live"));
		expect(tedi?.slug).toBe("cto-retired-tedi-live");
	});

	it("returns undefined for an unknown organization", async () => {
		const db = setup();
		expect(
			await retireOrganization(db, { ...retireParams(), id: "org-missing" }),
		).toBeUndefined();
	});
});

describe("getPersonalOrganization", () => {
	it("returns the user's live personal organization with its own identity", async () => {
		const db = setup();
		await db.insert(organizations).values([
			org("org-team", { type: "organization", name: "Team" }),
			org("org-personal-retired", {
				type: "personal",
				name: "Old personal",
				metadata: { retiredAt: RETIRED_AT } as never,
			}),
			org("org-personal", { type: "personal", name: "Personal" }),
			org("org-personal-other", { type: "personal", name: "Someone else" }),
		]);
		const member = (id: string, organizationId: string, user: string) => ({
			id,
			organizationId,
			descopeUserId: user,
			email: `${user}@example.test`,
			status: "active" as const,
		});
		await db
			.insert(organizationMembers)
			.values([
				member("m-team", "org-team", "U1"),
				member("m-retired", "org-personal-retired", "U1"),
				member("m-personal", "org-personal", "U1"),
				member("m-other", "org-personal-other", "U2"),
			]);

		const personal = await getPersonalOrganization(db, "U1");

		expect(personal?.id).toBe("org-personal");
		expect(personal?.name).toBe("Personal");
		expect(personal?.type).toBe("personal");
		expect(await getPersonalOrganization(db, "U3")).toBeUndefined();
	});
});
