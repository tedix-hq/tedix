import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { organizations } from "../schema/organizations";
import {
	PRINCIPAL_TYPE_VALUES,
	principalIdentities,
} from "../schema/principal-identities";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	bindPrincipalIdentity,
	listPrincipalIdentities,
	PrincipalIdentityConflictError,
	resolvePrincipalIdentity,
	revokePrincipalIdentity,
} from "./principal-identities";

const ORG = "00000000-0000-4000-8000-000000000001";
const ISSUER = "https://auth.example.test/P-project";
const NOW = "2026-08-08T00:00:00.000Z";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations, principalIdentities));
	return createDbClient(createD1Facade(sqlite));
}

describe("principal identity mappings", () => {
	let db: ReturnType<typeof setup>;

	beforeEach(async () => {
		db = setup();
		await db.insert(organizations).values({
			id: ORG,
			name: "Acme",
			slug: "acme",
			createdAt: NOW,
			updatedAt: NOW,
		});
	});

	it("maps every canonical principal class through exact issuer and subject tuples", async () => {
		for (const [index, principalType] of PRINCIPAL_TYPE_VALUES.entries()) {
			const principalId =
				principalType === "organization"
					? ORG
					: `00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`;
			const organizationId = principalType === "user" ? null : ORG;
			await bindPrincipalIdentity(db, {
				id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
				organizationId,
				principalType,
				principalId,
				provider: "Descope",
				issuer: `${ISSUER}/`,
				subject: `subject-${principalType}`,
				verifiedAt: NOW,
			});

			await expect(
				resolvePrincipalIdentity(db, {
					provider: "descope",
					issuer: ISSUER,
					subject: `subject-${principalType}`,
				}),
			).resolves.toMatchObject({
				organizationId,
				principalType,
				principalId,
				provider: "descope",
				issuer: ISSUER,
			});
		}
	});

	it("fails closed instead of rebinding an external identity", async () => {
		const identity = {
			provider: "descope",
			issuer: ISSUER,
			subject: "user-1",
		};
		await bindPrincipalIdentity(db, {
			...identity,
			principalType: "user",
			principalId: "00000000-0000-4000-8000-000000000010",
			organizationId: null,
			verifiedAt: NOW,
		});

		await expect(
			bindPrincipalIdentity(db, {
				...identity,
				principalType: "user",
				principalId: "00000000-0000-4000-8000-000000000011",
				organizationId: null,
				verifiedAt: NOW,
			}),
		).rejects.toBeInstanceOf(PrincipalIdentityConflictError);
	});

	it("revokes without deleting audit history and can reactivate the same binding", async () => {
		const identity = {
			provider: "descope",
			issuer: ISSUER,
			subject: "client-1",
		};
		const principal = {
			principalType: "service" as const,
			principalId: "00000000-0000-4000-8000-000000000020",
			organizationId: ORG,
		};
		await bindPrincipalIdentity(db, {
			...identity,
			...principal,
			verifiedAt: NOW,
		});
		await expect(revokePrincipalIdentity(db, identity, NOW)).resolves.toBe(
			true,
		);
		await expect(
			resolvePrincipalIdentity(db, identity),
		).resolves.toBeUndefined();
		await expect(
			resolvePrincipalIdentity(db, identity, { includeRevoked: true }),
		).resolves.toMatchObject({ status: "revoked" });

		await bindPrincipalIdentity(db, {
			...identity,
			...principal,
			verifiedAt: NOW,
		});
		await expect(listPrincipalIdentities(db, principal)).resolves.toEqual([
			expect.objectContaining({ status: "active", subject: "client-1" }),
		]);
	});

	it("keeps identical subjects from different issuers distinct", async () => {
		await bindPrincipalIdentity(db, {
			principalType: "organization",
			principalId: ORG,
			organizationId: ORG,
			provider: "descope",
			issuer: ISSUER,
			subject: "tenant-1",
			verifiedAt: NOW,
		});
		await expect(
			resolvePrincipalIdentity(db, {
				provider: "descope",
				issuer: "https://other.example/P-project",
				subject: "tenant-1",
			}),
		).resolves.toBeUndefined();
	});
});
