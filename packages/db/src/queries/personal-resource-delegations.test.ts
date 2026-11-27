import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { createPGliteFacade } from "../test/pglite-facade";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import {
	createPersonalResourceDelegation,
	getPersonalResourceDelegation,
	listActiveSkillPersonalResourceDelegations,
	listPersonalResourceDelegations,
	revokePersonalResourceDelegation,
} from "./personal-resource-delegations";
let close: (() => void | Promise<void>) | undefined;
afterEach(async () => {
	await close?.();
	close = undefined;
});
async function fixture(store: "d1" | "postgres") {
	if (store === "postgres") {
		const fixture = await createPGliteFacade();
		close = fixture.close;
		for (const migration of readMigrationFiles({
			migrationsFolder: fileURLToPath(
				new URL("../../drizzle-pg", import.meta.url),
			),
		}))
			for (const ddl of migration.sql) await fixture.engine.exec(ddl);
		return fixture.db;
	}

	const sqlite = new DatabaseSync(":memory:");
	close = () => sqlite.close();
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
for (const store of ["d1", "postgres"] as const)
	describe(`personal resource consent (${store})`, () => {
		it("selects the newest active grant per resource before the scheduled resource cap", async () => {
			const db = await fixture(store);
			await createPersonalResourceDelegation(db, { ...row, id: "z-older" });
			await createPersonalResourceDelegation(db, {
				...row,
				id: "older-other",
				resourceId: "other",
			});
			for (let revision = 1; revision <= 20; revision++) {
				await createPersonalResourceDelegation(db, {
					...row,
					id: `regrant-${String(revision).padStart(2, "0")}`,
					skillRevision: revision,
					createdAt: "2026-10-02T00:00:00.000Z",
				});
			}
			for (const override of [
				{ id: "foreign-org", organizationId: "other" },
				{ id: "foreign-worker", tediId: "other" },
				{ id: "foreign-skill", skillId: "other" },
				{ id: "revoked", revokedAt: "2026-10-03T00:00:00.000Z" },
				{ id: "expired", expiresAt: "2026-10-04T00:00:00.000Z" },
			]) {
				await createPersonalResourceDelegation(db, {
					...row,
					createdAt: "2026-10-03T00:00:00.000Z",
					...override,
				});
			}
			const input = {
				organizationId: row.organizationId,
				tediId: row.tediId,
				skillId: row.skillId,
				now: "2026-10-04T00:00:00.000Z",
			};
			expect(
				(await listActiveSkillPersonalResourceDelegations(db, input)).map(
					(grant) => grant.id,
				),
			).toEqual(["regrant-20", "older-other"]);

			for (let resource = 0; resource < 21; resource++) {
				await createPersonalResourceDelegation(db, {
					...row,
					id: `resource-${String(resource).padStart(2, "0")}`,
					resourceId: `resource-${resource}`,
					createdAt: "2026-10-03T00:00:00.000Z",
				});
			}
			const capped = await listActiveSkillPersonalResourceDelegations(
				db,
				input,
			);
			expect(capped.map((grant) => grant.id)).toEqual(
				Array.from(
					{ length: 20 },
					(_, index) => `resource-${String(20 - index).padStart(2, "0")}`,
				),
			);
		});
		it("scopes records to the organization and owner", async () => {
			const db = await fixture(store);
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
			const db = await fixture(store);
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
			const db = await fixture(store);
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
			const db = await fixture(store);
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
