import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";

const migration = readFileSync(
	new URL(
		"../../drizzle/20260802042204_allow_billing_credit_cascade_delete/migration.sql",
		import.meta.url,
	),
	"utf8",
);

describe("billing credit journal deletion", () => {
	it("rejects direct deletion while allowing organization cascade cleanup", () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE organizations (
				id TEXT PRIMARY KEY
			);
			CREATE TABLE billing_credit_entries (
				id TEXT PRIMARY KEY,
				organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
			);
			CREATE TRIGGER billing_credit_entries_immutable_delete
			BEFORE DELETE ON billing_credit_entries
			BEGIN
				SELECT RAISE(ABORT, 'billing credit journal is immutable');
			END;
		`);
		sqlite.exec(migration);
		sqlite.exec(`
			INSERT INTO organizations (id) VALUES ('org-1');
			INSERT INTO billing_credit_entries (id, organization_id)
			VALUES ('credit-1', 'org-1');
		`);

		expect(() =>
			sqlite.exec("DELETE FROM billing_credit_entries WHERE id = 'credit-1'"),
		).toThrow("billing credit journal is immutable");

		sqlite.exec("DELETE FROM organizations WHERE id = 'org-1'");

		const remaining = sqlite
			.prepare("SELECT COUNT(*) AS count FROM billing_credit_entries")
			.get() as { count: number };
		expect(remaining.count).toBe(0);
	});
});
