import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import { principalIdentities } from "../schema/principal-identities";
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

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(organizations, organizationMembers, principalIdentities),
	);
	return createDbClient(createD1Facade(sqlite));
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

	const resolve = () =>
		resolveUserTenantIdentityContext(db, {
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
			memberRole: "admin",
			memberPermissionOverrides: ["apps:read"],
		});
	});

	it("keeps the read-only Descope compatibility fallback", async () => {
		await db.insert(organizationMembers).values({
			id: "00000000-0000-4000-8000-000000000004",
			organizationId: ORG,
			descopeUserId: SUBJECT,
			email: "legacy@example.test",
			role: "member",
		});

		await expect(resolve()).resolves.toEqual({
			organizationId: ORG,
			canonicalUserId: null,
			memberRole: "member",
			memberPermissionOverrides: null,
		});
	});

	it("returns organization context without inventing membership authority", async () => {
		await expect(resolve()).resolves.toEqual({
			organizationId: ORG,
			canonicalUserId: null,
			memberRole: null,
			memberPermissionOverrides: null,
		});
	});

	it("does not resolve retired organizations", async () => {
		await db
			.update(organizations)
			.set({ metadata: { retiredAt: NOW } })
			.where(eq(organizations.id, ORG));

		await expect(resolve()).resolves.toBeUndefined();
	});
});
