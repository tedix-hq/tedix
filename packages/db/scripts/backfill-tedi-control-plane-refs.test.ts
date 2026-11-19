import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";

const migration = readFileSync(
	new URL(
		"../drizzle/20261119021139_backfill-tedi-control-plane-refs/migration.sql",
		import.meta.url,
	),
	"utf8",
);
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function fixture() {
	const db = new DatabaseSync(":memory:");
	databases.push(db);
	for (const table of [
		"runtime_profiles",
		"policy_packs",
		"workspace_template_sets",
	]) {
		db.exec(
			`CREATE TABLE ${table} (id TEXT, scope TEXT, slug TEXT, status TEXT, published_at TEXT, version INTEGER, target TEXT)`,
		);
		db.exec(`INSERT INTO ${table} VALUES
			('old', 'system', 'system-default', 'active', 'published', 1, 'tedi'),
			('head', 'system', 'system-default', 'active', 'published', 2, 'shared'),
			('draft', 'system', 'system-default', 'active', NULL, 3, 'tedi'),
			('archived', 'system', 'system-default', 'archived', 'published', 4, 'tedi'),
			('private', 'organization', 'system-default', 'active', 'published', 5, 'tedi')`);
	}
	db.exec(`CREATE TABLE tedis (id TEXT PRIMARY KEY, runtime_profile_id TEXT, policy_pack_id TEXT, workspace_template_set_id TEXT);
		INSERT INTO tedis VALUES ('empty', NULL, NULL, NULL), ('partial', 'custom', NULL, 'old'), ('assigned', 'old', 'old', 'old')`);
	return db;
}

describe("control-plane reference backfill", () => {
	it("pins NULLs to active published system heads and preserves assignments on rerun", () => {
		const db = fixture();
		db.exec(
			`INSERT INTO policy_packs VALUES ('wrong-target', 'system', 'system-default', 'active', 'published', 6, 'workspace')`,
		);
		db.exec(migration);
		const rows = db.prepare("SELECT * FROM tedis ORDER BY id").all();
		expect(rows).toEqual([
			{
				id: "assigned",
				runtime_profile_id: "old",
				policy_pack_id: "old",
				workspace_template_set_id: "old",
			},
			{
				id: "empty",
				runtime_profile_id: "head",
				policy_pack_id: "head",
				workspace_template_set_id: "head",
			},
			{
				id: "partial",
				runtime_profile_id: "custom",
				policy_pack_id: "head",
				workspace_template_set_id: "old",
			},
		]);
		db.exec(migration);
		expect(db.prepare("SELECT * FROM tedis ORDER BY id").all()).toEqual(rows);
	});

	it.each(["runtime_profiles", "policy_packs", "workspace_template_sets"])(
		"refuses missing %s defaults before touching tedis",
		(table) => {
			const db = fixture();
			db.exec(`DELETE FROM ${table}`);
			const before = db.prepare("SELECT * FROM tedis").all();
			expect(() => db.exec(migration)).toThrow(/CHECK constraint/);
			expect(db.prepare("SELECT * FROM tedis").all()).toEqual(before);
		},
	);
});
