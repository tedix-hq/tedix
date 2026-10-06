import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	listTediAccessKeysDueForRotation,
	replaceTediAccessKeySecrets,
	upsertTediAccessKeySecrets,
} from "./tedi-secrets";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE tedis (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			slug TEXT,
			descope_user_id TEXT,
			retired_at TEXT
		);
		CREATE TABLE tedi_secrets (
			id TEXT PRIMARY KEY NOT NULL,
			tedi_id TEXT NOT NULL,
			name TEXT NOT NULL,
			encrypted_value TEXT NOT NULL,
			hint TEXT,
			key_version INTEGER NOT NULL DEFAULT 1,
			created_by TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
 UNIQUE(tedi_id, name)
		);
	`);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

describe("tedi access-key rotation queries", () => {
	it("discovers only old keys for live identity-backed tedis", async () => {
		const { db, sqlite } = fixture();
		for (const row of [
			["due", "org-1", "cto", "user-1", null],
			["fresh", "org-1", "cmo", "user-2", null],
			["retired", "org-1", "old", "user-3", "2026-08-01"],
			["no-identity", "org-1", "new", null, null],
		]) {
			sqlite
				.prepare(
					"INSERT INTO tedis (id, organization_id, slug, descope_user_id, retired_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run(...row);
		}
		for (const [id, tediId, updatedAt] of [
			["secret-due", "due", "2026-05-01T00:00:00.000Z"],
			["secret-fresh", "fresh", "2026-08-19T00:00:00.000Z"],
			["secret-retired", "retired", "2026-05-01T00:00:00.000Z"],
			["secret-no-identity", "no-identity", "2026-05-01T00:00:00.000Z"],
		]) {
			sqlite
				.prepare(
					"INSERT INTO tedi_secrets (id, tedi_id, name, encrypted_value, created_at, updated_at) VALUES (?, ?, 'DESCOPE_ACCESS_KEY', 'encrypted', ?, ?)",
				)
				.run(id, tediId, updatedAt, updatedAt);
		}

		const rows = await listTediAccessKeysDueForRotation(db, {
			updatedBefore: "2026-06-20T00:00:00.000Z",
			limit: 25,
		});

		expect(rows).toEqual([
			expect.objectContaining({
				tediId: "due",
				accessKeySecretId: "secret-due",
			}),
		]);
	});

	it("atomically replaces both encrypted values and advances key versions", async () => {
		const { db, sqlite } = fixture();
		sqlite
			.prepare(
				"INSERT INTO tedis (id, organization_id, slug, descope_user_id) VALUES ('tedi-1', 'org-1', 'cto', 'user-1')",
			)
			.run();
		for (const [id, name] of [
			["secret-key", "DESCOPE_ACCESS_KEY"],
			["secret-key-id", "DESCOPE_ACCESS_KEY_ID"],
		]) {
			sqlite
				.prepare(
					"INSERT INTO tedi_secrets (id, tedi_id, name, encrypted_value, key_version, created_at, updated_at) VALUES (?, 'tedi-1', ?, 'old', 2, '2026-01-01', '2026-01-01')",
				)
				.run(id, name);
		}

		await replaceTediAccessKeySecrets(db, {
			accessKeySecretId: "secret-key",
			accessKeyIdSecretId: "secret-key-id",
			encryptedAccessKey: "new-key",
			encryptedAccessKeyId: "new-key-id",
			updatedAt: "2026-08-20T00:00:00.000Z",
		});

		const rows = sqlite
			.prepare(
				"SELECT id, encrypted_value, key_version, updated_at FROM tedi_secrets ORDER BY id",
			)
			.all();
		expect(rows).toEqual([
			{
				id: "secret-key",
				encrypted_value: "new-key",
				key_version: 3,
				updated_at: "2026-08-20T00:00:00.000Z",
			},
			{
				id: "secret-key-id",
				encrypted_value: "new-key-id",
				key_version: 3,
				updated_at: "2026-08-20T00:00:00.000Z",
			},
		]);
	});
});

describe("provider worker credential recovery", () => {
	it("creates a pair and replaces an incomplete pair atomically", async () => {
		const { db, sqlite } = fixture();
		await upsertTediAccessKeySecrets(db, {
			tediId: "worker",
			encryptedAccessKey: "key1",
			encryptedAccessKeyId: "id1",
		});
		sqlite.exec(
			"DELETE FROM tedi_secrets WHERE name = 'DESCOPE_ACCESS_KEY_ID'",
		);
		await upsertTediAccessKeySecrets(db, {
			tediId: "worker",
			encryptedAccessKey: "key2",
			encryptedAccessKeyId: "id2",
		});
		expect(
			sqlite
				.prepare("SELECT name, encrypted_value FROM tedi_secrets ORDER BY name")
				.all(),
		).toEqual([
			{ name: "DESCOPE_ACCESS_KEY", encrypted_value: "key2" },
			{ name: "DESCOPE_ACCESS_KEY_ID", encrypted_value: "id2" },
		]);
	});
	it("rolls back the first half if persisting the second fails", async () => {
		const { db, sqlite } = fixture();
		await upsertTediAccessKeySecrets(db, {
			tediId: "worker",
			encryptedAccessKey: "old-key",
			encryptedAccessKeyId: "old-id",
		});
		sqlite.exec(
			"CREATE TRIGGER reject_pair BEFORE INSERT ON tedi_secrets WHEN NEW.name = 'DESCOPE_ACCESS_KEY_ID' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
		);
		await expect(
			upsertTediAccessKeySecrets(db, {
				tediId: "worker",
				encryptedAccessKey: "new-key",
				encryptedAccessKeyId: "new-id",
			}),
		).rejects.toThrow();
		expect(
			sqlite
				.prepare("SELECT encrypted_value FROM tedi_secrets ORDER BY name")
				.all(),
		).toEqual([{ encrypted_value: "old-key" }, { encrypted_value: "old-id" }]);
	});
});
