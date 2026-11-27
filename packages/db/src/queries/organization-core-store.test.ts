import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { billingPlanVersions } from "../schema/billing";
import { organizations } from "../schema/organizations";
import { organizationMembers } from "../schema/organization-members";
import { organizationPurposeCharters } from "../schema/organization-purpose";
import { apps } from "../schema/apps";
import { tedis } from "../schema/tedis";
import { workItems } from "../schema/work-items";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import * as members from "./organization-members";
import * as domains from "./organization-domains";
import * as purpose from "./organization-purpose";
import * as secrets from "./organization-secrets";
import { ensureOrgAndMember, ensurePersonalOrg } from "./organization-sync";
import * as organizationQueries from "./organizations";

async function expectUniqueViolation(write: PromiseLike<unknown>) {
	let error: unknown;
	try {
		await write;
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(Error);
	const messages: string[] = [];
	for (let current = error; current instanceof Error; current = current.cause) {
		messages.push(current.message);
	}
	expect(messages.join("\n")).toMatch(
		/UNIQUE constraint failed|duplicate key value violates unique constraint/,
	);
}

for (const store of ["d1", "postgres"] as const) {
	describe(`Organization queries: ${store}`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite));
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
			}
			await db.insert(coreTable(db, billingPlanVersions)).values({
				id: "parity-starter",
				planKey: "starter",
				version: 1000,
				status: "active",
				name: "Starter",
				maxTedis: 1,
				maxCronJobsPerTedi: 1,
				maxIterationsPerTask: 1,
				effectiveAt: "2026-01-01T00:00:00.000Z",
			});
			await db.insert(coreTable(db, organizations)).values([
				{
					id: "org-a",
					name: "Alpha",
					slug: "alpha",
					descopeTenantId: "tenant-a",
					features: { os: true },
					metadata: { mcpInboundClientPolicy: { mode: "audit", entries: [] } },
				},
				{
					id: "org-b",
					name: "Beta",
					slug: "beta",
					descopeTenantId: "tenant-b",
					features: { os: false },
				},
				{
					id: "retired",
					name: "Retired",
					slug: "retired",
					descopeTenantId: "tenant-retired",
					metadata: { retiredAt: "2026-01-01" },
				},
			]);
		}, 30_000);
		afterAll(async () => {
			await close?.();
		});

		it("preserves invitations, tenant filters, JSON policy and owner guards", async () => {
			const first = await members.inviteMember(
				db,
				"org-a",
				"First@EXAMPLE.test",
			);
			const second = await members.inviteMember(
				db,
				"org-a",
				"second@example.test",
			);
			expect(first.descopeUserId).not.toBe(second.descopeUserId);
			expect(
				(await members.acceptInvite(db, first.id, "subject", { name: "First" }))
					.status,
			).toBe("active");
			await members.updateMember(db, first.id, {
				userId: "person",
				role: "owner",
				customPermissions: ["apps:read"],
			});
			expect(
				(await members.getMemberByCanonicalUserId(db, "org-a", "person"))
					?.customPermissions,
			).toEqual(["apps:read"]);
			expect(
				await members.updateMemberRole(db, "org-a", first.id, "member"),
			).toBeUndefined();
			expect(
				await members.updateMemberRole(db, "org-b", first.id, "admin"),
			).toBeUndefined();
			expect(await members.countActiveOwners(db, "org-a")).toBe(1);
			await members.addMember(db, {
				organizationId: "org-b",
				descopeUserId: "subject",
				email: "first@example.test",
				status: "deactivated",
			});
			await members.addMember(db, {
				organizationId: "retired",
				descopeUserId: "subject",
				email: "first@example.test",
			});
			expect(
				(
					await members.getMembershipsByDescopeTenants(
						db,
						["tenant-a", "tenant-b", "tenant-retired"],
						"subject",
					)
				).sort((left, right) =>
					left.organizationId.localeCompare(right.organizationId),
				),
			).toEqual([
				{
					organizationId: "org-a",
					descopeTenantId: "tenant-a",
					status: "active",
					inboundClientPolicyJson: '{"entries":[],"mode":"audit"}',
				},
				{
					organizationId: "org-b",
					descopeTenantId: "tenant-b",
					status: "deactivated",
					inboundClientPolicyJson: null,
				},
			]);
			expect(
				await members.getMemberAccessByUserId(db, "org-b", "subject"),
			).toMatchObject({ status: "deactivated" });
			expect(await members.getUserOsMemberships(db, "subject")).toEqual([
				{
					organizationId: "org-a",
					organizationName: "Alpha",
					organizationSlug: "alpha",
					organizationLogoUrl: null,
				},
			]);
			expect(
				await members.getUserOrganizationMemberships(db, "subject"),
			).toHaveLength(2);
			expect(await members.getMemberNameByUserId(db, "org-a", "subject")).toBe(
				"First",
			);
		});

		it("filters gateway JSON booleans and keeps only live tedis", async () => {
			const table = coreTable(db, apps);
			await db.insert(table).values([
				{
					id: "gateway",
					organizationId: "org-a",
					name: "Gateway",
					slug: "alpha-unified",
					metadata: {
						mcpConfig: { authMode: "authenticated", codeMode: true },
					},
				},
				{
					id: "string-boolean",
					organizationId: "org-b",
					name: "False gateway",
					slug: "beta-unified",
					metadata: {
						mcpConfig: { authMode: "authenticated", codeMode: "true" },
					},
				},
			]);
			expect(
				await members.getOrganizationAggregatorGateways(db, ["org-a", "org-b"]),
			).toEqual(
				new Map([["org-a", { slug: "alpha-unified", customMcpDomain: null }]]),
			);
			await db.insert(coreTable(db, tedis)).values([
				{
					id: "live-tedi",
					organizationId: "org-a",
					name: "Live",
					slug: "live",
					descopeUserId: "tedi-subject",
				},
				{
					id: "retired-tedi",
					organizationId: "org-a",
					name: "Retired",
					slug: "retired",
					descopeUserId: "retired-subject",
					retiredAt: "2026-01-01",
				},
			]);
			expect(
				await members.listTedisByMemberDescopeUserIds(db, "org-a", [
					"tedi-subject",
					"retired-subject",
				]),
			).toEqual([
				{ descopeUserId: "tedi-subject", tediId: "live-tedi", avatar: null },
			]);
		});

		it("enforces domain eligibility, tenant leases and immediate removal", async () => {
			const input = {
				id: "claim",
				organizationId: "org-a",
				hostname: "alpha.example.test",
				verificationToken: "token",
				expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
			};
			expect(
				await domains.reserveOrganizationDomain(db, {
					...input,
					id: "disabled",
					organizationId: "org-b",
				}),
			).toBeNull();
			expect(await domains.reserveOrganizationDomain(db, input)).toMatchObject({
				kind: "organization",
				status: "pending",
			});
			expect(
				await domains.reserveOrganizationDomain(db, {
					...input,
					id: "duplicate",
					hostname: "other.example.test",
				}),
			).toBeNull();
			expect(
				await domains.lockOrganizationDomain(
					db,
					"org-b",
					input.id,
					"provisioning",
				),
			).toBeNull();
			const lease = (await domains.lockOrganizationDomain(
				db,
				"org-a",
				input.id,
				"provisioning",
			))!;
			expect(
				await domains.finishOrganizationDomainVerification(db, {
					...input,
					lease: "stale",
					status: "active",
					providerHostnameId: "provider",
				}),
			).toBeNull();
			expect(
				await domains.finishOrganizationDomainVerification(db, {
					...input,
					lease: lease.updatedAt,
					status: "active",
					providerHostnameId: "provider",
				}),
			).toMatchObject({ status: "active" });
			expect(
				await domains.resolveOrganizationHostname(db, "ALPHA.EXAMPLE.TEST."),
			).toMatchObject({ organizationId: "org-a" });
			expect(
				await domains.deleteOrganizationDomain(db, "org-a", input.id),
			).toBe(false);
			await domains.lockOrganizationDomain(db, "org-a", input.id, "removing");
			expect(
				await domains.resolveOrganizationHostname(db, input.hostname),
			).toBeNull();
			expect(
				await domains.deleteOrganizationDomain(db, "org-a", input.id),
			).toBe(true);
		});

		it("round trips charter revisions and tenant-scoped owner brief rows", async () => {
			const now = "2026-11-27T00:00:00.000Z";
			await purpose.createPurposeCharterRevision(db, {
				id: "charter-1",
				orgId: "org-a",
				purpose: "First",
				principles: ["Keep evidence"],
				revisionReason: "Initial",
				createdAt: now,
			});
			await purpose.createPurposeCharterRevision(db, {
				id: "charter-2",
				orgId: "org-a",
				purpose: "Second",
				revisionReason: "Updated",
				createdAt: now,
			});
			expect(
				(await purpose.listPurposeCharterRevisions(db, "org-a")).map((row) => [
					row.version,
					row.status,
				]),
			).toEqual([
				[2, "active"],
				[1, "superseded"],
			]);
			expect(
				(await purpose.getPurposeCharterById(db, "charter-1"))?.principles,
			).toEqual(["Keep evidence"]);
			await expect(
				purpose.createPurposeCharterRevision(db, {
					id: "charter-1",
					orgId: "org-a",
					purpose: "Conflict",
					revisionReason: "Duplicate",
					createdAt: now,
				}),
			).rejects.toThrow();
			expect((await purpose.getActivePurposeCharter(db, "org-a"))?.id).toBe(
				"charter-2",
			);
			await db.insert(coreTable(db, workItems)).values([
				{
					id: "work-a",
					orgId: "org-a",
					title: "Alpha work",
					disposition: "accepted",
					admissionSpecRevision: "parity-spec",
					createdAt: now,
				},
				{
					id: "work-b",
					orgId: "org-b",
					title: "Beta work",
					disposition: "accepted",
					admissionSpecRevision: "parity-spec",
					createdAt: now,
				},
			]);
			expect(
				await purpose.getOrganizationOwnerBrief(db, { orgId: "org-a", now }),
			).toMatchObject({
				purposeCharter: { id: "charter-2" },
				drift: { openWorkCount: 1, unlinkedOpenWorkCount: 1 },
			});
		});

		it("enforces canonical member and active charter uniqueness", async () => {
			const now = "2026-11-27T00:00:00.000Z";
			await db.insert(coreTable(db, organizations)).values([
				{ id: "org-index-a", name: "Index Alpha", slug: "index-alpha" },
				{ id: "org-index-b", name: "Index Beta", slug: "index-beta" },
			]);
			const memberTable = coreTable(db, organizationMembers);
			await db.insert(memberTable).values([
				{
					id: "member-canonical-a",
					organizationId: "org-index-a",
					userId: "canonical-user",
					descopeUserId: "subject-a",
					email: "canonical-a@example.test",
				},
				{
					id: "member-null-a1",
					organizationId: "org-index-a",
					descopeUserId: "subject-null-a1",
					email: "null-a1@example.test",
				},
				{
					id: "member-null-a2",
					organizationId: "org-index-a",
					descopeUserId: "subject-null-a2",
					email: "null-a2@example.test",
				},
				{
					id: "member-canonical-b",
					organizationId: "org-index-b",
					userId: "canonical-user",
					descopeUserId: "subject-b",
					email: "canonical-b@example.test",
				},
			]);
			await expectUniqueViolation(
				db.insert(memberTable).values({
					id: "member-canonical-duplicate",
					organizationId: "org-index-a",
					userId: "canonical-user",
					descopeUserId: "subject-duplicate",
					email: "duplicate@example.test",
				}),
			);

			const charterTable = coreTable(db, organizationPurposeCharters);
			const charter = (
				id: string,
				orgId: string,
				version: number,
				status: "active" | "superseded",
			) => ({
				id,
				orgId,
				version,
				status,
				purpose: "Purpose",
				principles: [],
				strategicTheses: [],
				nonGoals: [],
				evidenceRefs: [],
				revisionReason: "Test",
				createdAt: now,
				activatedAt: now,
				supersededAt: status === "superseded" ? now : null,
			});
			await db
				.insert(charterTable)
				.values([
					charter("charter-index-a-1", "org-index-a", 1, "active"),
					charter("charter-index-b-1", "org-index-b", 1, "active"),
				]);
			await expectUniqueViolation(
				db
					.insert(charterTable)
					.values(charter("charter-index-a-2", "org-index-a", 2, "active")),
			);
			await db
				.insert(charterTable)
				.values([
					charter("charter-index-a-3", "org-index-a", 3, "superseded"),
					charter("charter-index-a-4", "org-index-a", 4, "superseded"),
				]);
			const charters = await db.select().from(charterTable);
			expect(
				charters.filter((row) => row.orgId === "org-index-a"),
			).toHaveLength(3);
		});

		it("isolates secret names and excludes encrypted values from metadata lists", async () => {
			const a = await secrets.createOrgSecret(db, {
				organizationId: "org-a",
				name: "token",
				encryptedValue: "cipher-a",
			});
			await secrets.createOrgSecret(db, {
				organizationId: "org-b",
				name: "token",
				encryptedValue: "cipher-b",
			});
			expect(await secrets.getOrgSecret(db, "org-b", "token")).toMatchObject({
				encryptedValue: "cipher-b",
			});
			const listed = await secrets.listOrgSecrets(db, "org-a");
			expect(listed).toHaveLength(1);
			expect(listed[0]).not.toHaveProperty("encryptedValue");
			expect(
				await secrets.updateOrgSecret(db, a.id, {
					encryptedValue: "rotated",
					keyVersion: 2,
				}),
			).toMatchObject({ encryptedValue: "rotated", keyVersion: 2 });
			expect(await secrets.deleteOrgSecret(db, a.id)).toBe(true);
			expect(await secrets.deleteOrgSecret(db, a.id)).toBe(false);
		});

		it("reconciles repeated provider login to one organization and member", async () => {
			const input = {
				settlementMode: "external" as const,
				descopeTenantId: "sync-tenant",
				identityIssuer: "https://identity.example.test",
				descopeUserId: "sync-user",
				email: "sync@example.test",
				organizationName: "Sync example",
			};
			const first = await ensureOrgAndMember(db, input);
			const second = await ensureOrgAndMember(db, input);
			expect(second.organization.id).toBe(first.organization.id);
			expect(second.member.id).toBe(first.member.id);
			expect(second.created).toEqual({ organization: false, member: false });
		});
		it("recovers a wrapped unique violation when another login creates the organization", async () => {
			const original = organizationQueries.createOrganization;
			const concurrentCreate = vi
				.spyOn(organizationQueries, "createOrganization")
				.mockImplementationOnce(async (...args) => {
					const created = await original(...args);
					await db
						.insert(coreTable(db, organizations))
						.values({ id: created.id, name: "Concurrent", slug: "concurrent" });
					return created;
				});
			try {
				const result = await ensureOrgAndMember(db, {
					settlementMode: "external",
					descopeTenantId: "race-tenant",
					identityIssuer: "https://identity.example.test",
					descopeUserId: "race-user",
					email: "race@example.test",
					organizationName: "Race example",
				});
				expect(result.organization.descopeTenantId).toBe("race-tenant");
				expect(result.created).toEqual({ organization: false, member: true });
			} finally {
				concurrentCreate.mockRestore();
			}
		});

		it("reuses a personal organization and its canonical member", async () => {
			const first = await ensurePersonalOrg(
				db,
				"personal-user",
				"Person",
				"personal@example.test",
				"https://identity.example.test",
				{ settlementMode: "external" },
			);
			const second = await ensurePersonalOrg(
				db,
				"personal-user",
				"Person",
				"personal@example.test",
				"https://identity.example.test",
				{ settlementMode: "external" },
			);
			expect(first.created).toBe(true);
			expect(second.created).toBe(false);
			expect(second.organization.id).toBe(first.organization.id);
			expect(second.member.id).toBe(first.member.id);
		});
	});
}
