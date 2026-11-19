import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";

const migration = readFileSync(
	new URL(
		"../drizzle/20261119030150_backfill-explicit-approval-policy/migration.sql",
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
	db.exec("CREATE TABLE policy_packs (id TEXT PRIMARY KEY, definition TEXT)");
	return db;
}

describe("explicit third-party approval policy backfill", () => {
	it("persists implicit false without changing explicit choices or unrelated policy", () => {
		const db = fixture();
		const definitions = [
			{ gatingPolicy: { enabled: true } },
			{ governancePolicy: null },
			{ governancePolicy: { autonomy: false, approvalTtlHours: 72 } },
			{ governancePolicy: { requireExplicitThirdPartyApprovalPolicy: true } },
			{ governancePolicy: { requireExplicitThirdPartyApprovalPolicy: false } },
		];
		const insert = db.prepare("INSERT INTO policy_packs VALUES (?, ?)");
		definitions.forEach((definition, index) =>
			insert.run(String(index), JSON.stringify(definition)),
		);
		db.exec(migration);
		const rows = db.prepare("SELECT * FROM policy_packs ORDER BY id").all();
		expect(rows.map((row) => JSON.parse(String(row.definition)))).toEqual([
			{
				gatingPolicy: { enabled: true },
				governancePolicy: { requireExplicitThirdPartyApprovalPolicy: false },
			},
			{ governancePolicy: { requireExplicitThirdPartyApprovalPolicy: false } },
			{
				governancePolicy: {
					autonomy: false,
					approvalTtlHours: 72,
					requireExplicitThirdPartyApprovalPolicy: false,
				},
			},
			definitions[3],
			definitions[4],
		]);
		db.exec(migration);
		expect(db.prepare("SELECT * FROM policy_packs ORDER BY id").all()).toEqual(
			rows,
		);
	});

	it("preserves unsupported records without failing the release", () => {
		const db = fixture();
		const insert = db.prepare("INSERT INTO policy_packs VALUES (?, ?)");
		[
			null,
			"{",
			"null",
			"[]",
			"1",
			'"text"',
			'{"governancePolicy":[]}',
			'{"governancePolicy":false}',
			'{"governancePolicy":"old"}',
			'{"governancePolicy":{"requireExplicitThirdPartyApprovalPolicy":null}}',
			'{"governancePolicy":{"requireExplicitThirdPartyApprovalPolicy":"false"}}',
			'{"governancePolicy":{"requireExplicitThirdPartyApprovalPolicy":1}}',
		].forEach((definition, index) => insert.run(String(index), definition));
		const before = db.prepare("SELECT * FROM policy_packs ORDER BY id").all();
		expect(() => db.exec(migration)).not.toThrow();
		expect(db.prepare("SELECT * FROM policy_packs ORDER BY id").all()).toEqual(
			before,
		);
	});
});
