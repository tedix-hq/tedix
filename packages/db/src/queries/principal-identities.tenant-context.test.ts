import { DatabaseSync } from "node:sqlite";
import type { OrganizationMetadata } from "@tedix/api-contract/schemas/organization";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "../client";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import { principalIdentities } from "../schema/principal-identities";
import { projects } from "../schema/projects";
import { tediObjectives } from "../schema/tedi-objectives";
import { tedis } from "../schema/tedis";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	bindPrincipalIdentity,
	resolveUserTenantIdentityContext,
} from "./principal-identities";

const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const ISSUER = "https://auth.example.test/P-project";
const TENANT = "org_acme";
const SUBJECT = "user-1";
const NOW = "2026-08-30T00:00:00.000Z";

function setup(plans: string[] = []) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			organizations,
			organizationMembers,
			principalIdentities,
			projects,
			tediObjectives,
			tedis,
		),
	);
	return createDbClient(
		createD1Facade({
			prepare(query) {
				plans.push(
					...sqlite
						.prepare(`EXPLAIN QUERY PLAN ${query}`)
						.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
						.map((row) => String(row.detail)),
				);
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);
}

describe("user tenant identity context", () => {
	let db: ReturnType<typeof setup>;

	beforeEach(async () => {
		db = setup();
		await db.insert(organizations).values({
			id: ORG,
			name: "Acme",
			slug: "acme",
			descopeTenantId: TENANT,
			createdAt: NOW,
			updatedAt: NOW,
		});
	});

	const resolve = (reviewProjectId?: string) =>
		resolveUserTenantIdentityContext(db, {
			reviewProjectId,
			organizationIdentity: {
				provider: "Descope",
				issuer: `${ISSUER}/`,
				subject: TENANT,
			},
			userIdentity: {
				provider: "Descope",
				issuer: `${ISSUER}/`,
				subject: SUBJECT,
			},
		});

	it("batches the live review policy with identity and observes subsequent changes", async () => {
		await db.insert(projects).values({
			id: "private-reviews",
			orgId: ORG,
			key: "REV",
			name: "Reviews",
			createdAt: NOW,
			metadata: { agentReviewTriage: { tediId: "triage-one" } },
		});
		const batch = vi.spyOn(db, "batch");
		const first = await resolve("private-reviews");
		expect(batch).toHaveBeenCalledTimes(1);
		expect(batch.mock.calls[0]?.[0]).toHaveLength(2);
		expect(first?.organizationId).toBe(ORG);
		expect(first?.reviewProject?.project?.metadata).toEqual({
			agentReviewTriage: { tediId: "triage-one" },
		});
		await db
			.update(projects)
			.set({ metadata: { agentReviewTriage: { tediId: "triage-two" } } })
			.where(eq(projects.id, "private-reviews"));
		expect(
			(await resolve("private-reviews"))?.reviewProject?.project?.metadata,
		).toEqual({ agentReviewTriage: { tediId: "triage-two" } });
		await db.delete(projects).where(eq(projects.id, "private-reviews"));
		expect((await resolve("private-reviews"))?.reviewProject).toEqual({
			id: "private-reviews",
			project: undefined,
		});
	});

	it("seeks candidate organizations instead of scanning every tenant", async () => {
		const plans: string[] = [];
		db = setup(plans);
		await db.insert(organizations).values({
			id: ORG,
			name: "Acme",
			slug: "acme",
			descopeTenantId: TENANT,
		});
		plans.length = 0;
		expect((await resolve())?.organizationId).toBe(ORG);
		expect(plans.some((plan) => /^SCAN organizations\b/.test(plan))).toBe(
			false,
		);
		expect(plans).toContainEqual(
			expect.stringMatching(/^SEARCH organizations USING INDEX .*\(id=\?\)/),
		);
		expect(plans).toContainEqual(
			expect.stringMatching(/SEARCH .* USING .*\(descope_tenant_id=\?\)/),
		);
		expect(plans).toContainEqual(
			expect.stringMatching(
				/SEARCH .* USING .*\(provider=\? AND issuer=\? AND subject=\?\)/,
			),
		);
	});

	it.each(["active", "revoked", "other-issuer", "retired"] as const)(
		"preserves canonical organization precedence for a %s mapping",
		async (state) => {
			await db.insert(organizations).values({
				id: "canonical-org",
				name: "Canonical",
				slug: "canonical",
				metadata:
					state === "retired"
						? ({ retiredAt: NOW } as OrganizationMetadata)
						: null,
			});
			await db.insert(principalIdentities).values({
				id: "tenant-mapping",
				organizationId: "canonical-org",
				principalType: "organization",
				principalId: "canonical-org",
				provider: "descope",
				issuer:
					state === "other-issuer" ? "https://other.example.test" : ISSUER,
				subject: TENANT,
				status: state === "revoked" ? "revoked" : "active",
			});
			expect((await resolve())?.organizationId).toBe(
				state === "active" ? "canonical-org" : ORG,
			);
		},
	);

	it("returns canonical organization, user, and membership authority in one read", async () => {
		await bindPrincipalIdentity(db, {
			organizationId: ORG,
			principalType: "organization",
			principalId: ORG,
			provider: "descope",
			issuer: ISSUER,
			subject: TENANT,
		});
		await bindPrincipalIdentity(db, {
			organizationId: null,
			principalType: "user",
			principalId: USER,
			provider: "descope",
			issuer: ISSUER,
			subject: SUBJECT,
		});
		await db.insert(organizationMembers).values({
			id: "00000000-0000-4000-8000-000000000003",
			organizationId: ORG,
			userId: USER,
			descopeUserId: SUBJECT,
			email: "user@example.test",
			role: "admin",
			customPermissions: ["apps:read"],
		});

		await expect(resolve()).resolves.toEqual({
			organizationId: ORG,
			canonicalUserId: USER,
			memberIsActive: true,
			memberKind: "human",
			memberRole: "admin",
			memberPermissionOverrides: ["apps:read"],
		});
	});

	it.each(["human", "external_agent", "browser_agent"] as const)(
		"keeps the read-only Descope compatibility fallback for %s",
		async (kind) => {
			await db.insert(organizationMembers).values({
				id: "00000000-0000-4000-8000-000000000004",
				organizationId: ORG,
				descopeUserId: SUBJECT,
				email: "legacy@example.test",
				kind,
				role: "member",
			});

			await expect(resolve()).resolves.toEqual({
				organizationId: ORG,
				canonicalUserId: null,
				memberIsActive: true,
				memberKind: kind,
				memberRole: "member",
				memberPermissionOverrides: null,
			});
		},
	);

	it.each(["deactivated", "invited", null] as const)(
		"removes authority for a %s membership and restores it on reactivation",
		async (status) => {
			await db.insert(organizationMembers).values({
				id: "00000000-0000-4000-8000-000000000005",
				organizationId: ORG,
				descopeUserId: SUBJECT,
				email: "admin@example.test",
				role: "admin",
				customPermissions: ["apps:delete"],
				status,
			});

			await expect(resolve()).resolves.toMatchObject({
				organizationId: ORG,
				memberIsActive: false,
				memberRole: null,
				memberPermissionOverrides: null,
			});

			await db
				.update(organizationMembers)
				.set({ status: "active" })
				.where(eq(organizationMembers.organizationId, ORG));

			await expect(resolve()).resolves.toMatchObject({
				memberIsActive: true,
				memberRole: "admin",
				memberPermissionOverrides: ["apps:delete"],
			});
		},
	);

	it("returns organization context without inventing membership authority", async () => {
		await expect(resolve()).resolves.toEqual({
			organizationId: ORG,
			canonicalUserId: null,
			memberIsActive: null,
			memberKind: null,
			memberRole: null,
			memberPermissionOverrides: null,
		});
	});

	it("does not resolve retired organizations", async () => {
		await db
			.update(organizations)
			.set({ metadata: { retiredAt: NOW } as OrganizationMetadata })
			.where(eq(organizations.id, ORG));

		await expect(resolve()).resolves.toBeUndefined();
	});
});
