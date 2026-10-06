import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import {
	createPersonalResourceDelegation,
	getPersonalResourceDelegation,
	listPersonalResourceDelegations,
	revokePersonalResourceDelegation,
} from "./personal-resource-delegations";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		"CREATE TABLE personal_resource_delegations (id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, tedi_id TEXT NOT NULL, skill_id TEXT NOT NULL, skill_revision INTEGER NOT NULL, workspace_id TEXT NOT NULL, resource_id TEXT NOT NULL, connection_instance_id TEXT NOT NULL, provider_id TEXT NOT NULL, resource_type TEXT NOT NULL, provider_resource_id TEXT NOT NULL, account_subject TEXT NOT NULL, grant_fingerprint TEXT NOT NULL, required_scopes TEXT NOT NULL, operations TEXT NOT NULL, tool_ids TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT)",
	);
	return createDbQueryClient(createD1Facade(sqlite));
}
const row = {
	id: "consent",
	organizationId: "org",
	ownerUserId: "alice",
	tediId: "worker",
	skillId: "skill",
	skillRevision: 1,
	workspaceId: "workspace",
	resourceId: "calendar",
	connectionInstanceId: "account",
	providerId: "google",
	resourceType: "calendar",
	providerResourceId: "calendar-original",
	accountSubject: "subject",
	grantFingerprint: "hash",
	requiredScopes: ["read"],
	operations: ["read"],
	toolIds: ["list_events"],
	createdAt: "2026-10-01T00:00:00.000Z",
	expiresAt: "2026-11-01T00:00:00.000Z",
	revokedAt: null,
};
describe("personal resource consent on D1", () => {
	it("scopes records to the organization and owner", async () => {
		const db = fixture();
		await createPersonalResourceDelegation(db, row);
		expect(
			await getPersonalResourceDelegation(db, {
				organizationId: "other",
				id: row.id,
			}),
		).toBeUndefined();
		expect(
			await listPersonalResourceDelegations(db, {
				organizationId: "org",
				ownerUserId: "bob",
			}),
		).toEqual([]);
		expect(
			await revokePersonalResourceDelegation(db, {
				organizationId: "org",
				ownerUserId: "bob",
				id: row.id,
				revokedAt: "2026-10-02",
			}),
		).toBeUndefined();
		expect(
			(
				await getPersonalResourceDelegation(db, {
					organizationId: "org",
					id: row.id,
				})
			)?.revokedAt,
		).toBeNull();
	});
	it("retains immutable permission snapshots and does not overwrite consent", async () => {
		const db = fixture();
		await createPersonalResourceDelegation(db, row);
		await expect(
			createPersonalResourceDelegation(db, {
				...row,
				providerResourceId: "other",
			}),
		).rejects.toThrow();
		expect(
			(
				await getPersonalResourceDelegation(db, {
					organizationId: "org",
					id: row.id,
				})
			)?.providerResourceId,
		).toBe("calendar-original");
	});
	it("keeps the first revocation under concurrent repeated calls", async () => {
		const db = fixture();
		await createPersonalResourceDelegation(db, row);
		await Promise.all(
			["2026-10-02", "2026-10-03"].map((revokedAt) =>
				revokePersonalResourceDelegation(db, {
					organizationId: "org",
					ownerUserId: "alice",
					id: row.id,
					revokedAt,
				}),
			),
		);
		const first = await getPersonalResourceDelegation(db, {
			organizationId: "org",
			id: row.id,
		});
		await revokePersonalResourceDelegation(db, {
			organizationId: "org",
			ownerUserId: "alice",
			id: row.id,
			revokedAt: "2026-10-04",
		});
		expect(
			(
				await getPersonalResourceDelegation(db, {
					organizationId: "org",
					id: row.id,
				})
			)?.revokedAt,
		).toBe(first?.revokedAt);
	});
	it("caps lists and preserves revoked audit records", async () => {
		const db = fixture();
		for (const id of ["a", "b", "c"])
			await createPersonalResourceDelegation(db, { ...row, id });
		await revokePersonalResourceDelegation(db, {
			organizationId: "org",
			ownerUserId: "alice",
			id: "c",
			revokedAt: "2026-10-02",
		});
		expect(
			(
				await listPersonalResourceDelegations(db, {
					organizationId: "org",
					ownerUserId: "alice",
					limit: 2,
				})
			).map((r) => r.id),
		).toEqual(["c", "b"]);
	});
});
