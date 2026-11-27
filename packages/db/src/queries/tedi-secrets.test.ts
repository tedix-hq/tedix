import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { organizations } from "../schema/organizations";
import { tediSecrets } from "../schema/tedi-secrets";
import { tedis } from "../schema/tedis";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	deleteTediSecret,
	getAllTediSecrets,
	getTediSecret,
	getTediSecretById,
	listTediSecrets,
	listTediAccessKeysDueForRotation,
	replaceTediAccessKeySecrets,
	upsertTediAccessKeySecrets,
	upsertTediSecret,
} from "./tedi-secrets";

for (const store of ["d1", "postgres"] as const)
	describe(`tedi secrets (${store})`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		let exec: (ddl: string) => unknown | Promise<unknown>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite));
				close = () => sqlite.close();
				exec = (ddl) => sqlite.exec(ddl);
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				exec = (ddl) => fixture.engine.exec(ddl);
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await exec(ddl);
			}
			await db
				.insert(coreTable(db, organizations))
				.values({ id: "org", name: "Example", slug: "example" });
			await db.insert(coreTable(db, tedis)).values([
				{
					id: "due",
					organizationId: "org",
					name: "Due",
					slug: "due",
					descopeUserId: "person",
				},
				{
					id: "fresh",
					organizationId: "org",
					name: "Fresh",
					slug: "fresh",
					descopeUserId: "person",
				},
				{
					id: "retired",
					organizationId: "org",
					name: "Retired",
					slug: "retired",
					descopeUserId: "person",
					retiredAt: "2026-08-01",
				},
				{
					id: "no-identity",
					organizationId: "org",
					name: "No identity",
					slug: "no-identity",
				},
				...["rotation", "recovery", "rollback", "crud"].map((id) => ({
					id,
					organizationId: "org",
					name: id,
					slug: id,
				})),
			]);
		}, 30_000);
		afterAll(async () => {
			await close?.();
		});

		it("discovers only old keys for live identity-backed tedis", async () => {
			await db.insert(coreTable(db, tediSecrets)).values(
				["due", "fresh", "retired", "no-identity"].map((tediId) => ({
					id: `secret-${tediId}`,
					tediId,
					name: "DESCOPE_ACCESS_KEY",
					encryptedValue: "encrypted",
					createdAt: "2026-05-01",
					updatedAt:
						tediId === "fresh"
							? "2026-08-19T00:00:00.000Z"
							: "2026-05-01T00:00:00.000Z",
				})),
			);
			expect(
				await listTediAccessKeysDueForRotation(db, {
					updatedBefore: "2026-06-20T00:00:00.000Z",
					limit: 25,
				}),
			).toEqual([
				expect.objectContaining({
					tediId: "due",
					accessKeySecretId: "secret-due",
				}),
			]);
		});

		it("atomically replaces both encrypted values and advances key versions", async () => {
			await upsertTediAccessKeySecrets(db, {
				tediId: "rotation",
				encryptedAccessKey: "old",
				encryptedAccessKeyId: "old-id",
			});
			const key = (await getTediSecret(db, "rotation", "DESCOPE_ACCESS_KEY"))!;
			const keyId = (await getTediSecret(
				db,
				"rotation",
				"DESCOPE_ACCESS_KEY_ID",
			))!;
			await replaceTediAccessKeySecrets(db, {
				accessKeySecretId: key.id,
				accessKeyIdSecretId: keyId.id,
				encryptedAccessKey: "new",
				encryptedAccessKeyId: "new-id",
				updatedAt: "2026-08-20T00:00:00.000Z",
			});
			expect(
				(await getAllTediSecrets(db, "rotation"))
					.map((row) => [
						row.name,
						row.encryptedValue,
						row.keyVersion,
						row.updatedAt,
					])
					.sort(),
			).toEqual([
				["DESCOPE_ACCESS_KEY", "new", 2, "2026-08-20T00:00:00.000Z"],
				["DESCOPE_ACCESS_KEY_ID", "new-id", 2, "2026-08-20T00:00:00.000Z"],
			]);
		});

		it("creates a pair and replaces an incomplete pair atomically", async () => {
			await upsertTediAccessKeySecrets(db, {
				tediId: "recovery",
				encryptedAccessKey: "key1",
				encryptedAccessKeyId: "id1",
			});
			await deleteTediSecret(
				db,
				(await getTediSecret(db, "recovery", "DESCOPE_ACCESS_KEY_ID"))!.id,
			);
			await upsertTediAccessKeySecrets(db, {
				tediId: "recovery",
				encryptedAccessKey: "key2",
				encryptedAccessKeyId: "id2",
			});
			expect(
				(await getAllTediSecrets(db, "recovery"))
					.map((row) => [row.name, row.encryptedValue])
					.sort(),
			).toEqual([
				["DESCOPE_ACCESS_KEY", "key2"],
				["DESCOPE_ACCESS_KEY_ID", "id2"],
			]);
		});

		it("keeps per-tedi values and metadata separate through upserts and deletion", async () => {
			const original = await upsertTediSecret(
				db,
				"crud",
				"TOKEN",
				"old",
				"hint",
				"creator",
			);
			await upsertTediSecret(db, "due", "TOKEN", "other", null, null);
			const updated = await upsertTediSecret(
				db,
				"crud",
				"TOKEN",
				"new",
				null,
				"another",
			);
			expect(updated).toMatchObject({
				id: original.id,
				createdBy: "creator",
				encryptedValue: "new",
				hint: null,
			});
			expect(await getTediSecretById(db, original.id)).toEqual(updated);
			const {
				encryptedValue: _encrypted,
				tediId: _owner,
				...metadata
			} = updated;
			expect(await listTediSecrets(db, "crud")).toEqual([metadata]);
			expect((await getTediSecret(db, "due", "TOKEN"))?.encryptedValue).toBe(
				"other",
			);
			expect(await deleteTediSecret(db, original.id)).toBe(true);
			expect(await deleteTediSecret(db, original.id)).toBe(false);
			expect(await getTediSecret(db, "crud", "TOKEN")).toBeUndefined();
		});

		it("rolls back the first half if persisting the second fails", async () => {
			await upsertTediAccessKeySecrets(db, {
				tediId: "rollback",
				encryptedAccessKey: "old-key",
				encryptedAccessKeyId: "old-id",
			});
			await exec(
				store === "d1"
					? "CREATE TRIGGER reject_pair BEFORE INSERT ON tedi_secrets WHEN NEW.tedi_id = 'rollback' AND NEW.name = 'DESCOPE_ACCESS_KEY_ID' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;"
					: `CREATE FUNCTION reject_pair() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tedi_id = 'rollback' AND NEW.name = 'DESCOPE_ACCESS_KEY_ID' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_pair BEFORE INSERT ON tedi_secrets FOR EACH ROW EXECUTE FUNCTION reject_pair();`,
			);
			await expect(
				upsertTediAccessKeySecrets(db, {
					tediId: "rollback",
					encryptedAccessKey: "new-key",
					encryptedAccessKeyId: "new-id",
				}),
			).rejects.toThrow();
			const secrets = coreTable(db, tediSecrets);
			expect(
				await db
					.select({ name: secrets.name, value: secrets.encryptedValue })
					.from(secrets)
					.where(eq(secrets.tediId, "rollback"))
					.orderBy(asc(secrets.name)),
			).toEqual([
				{ name: "DESCOPE_ACCESS_KEY", value: "old-key" },
				{ name: "DESCOPE_ACCESS_KEY_ID", value: "old-id" },
			]);
		});
	});
