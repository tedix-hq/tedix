/**
 * The fail-closed / fail-open boundary for the live D1 drift check.
 *
 * Drift that is actually DETECTED must block production. A check that gets NO
 * ANSWER must not — an unreadable production database is indistinguishable
 * from an outage.
 *
 * These tests cover the pure comparison over two schema descriptions, which is
 * the only part of the checker that decides whether production ships.
 */

import { describe, expect, it } from "vite-plus/test";
import { checkLiveDrift, classifyLiveDrift } from "./check-live-drift";
import {
	buildSchemaDescription,
	compareSchemaDescriptions,
	isExcludedObjectName,
	normalizeDefinition,
	type SchemaColumn,
	type SchemaDescription,
} from "./schema-description";

function column(
	name: string,
	overrides: Partial<SchemaColumn> = {},
): SchemaColumn {
	return {
		name,
		type: "TEXT",
		notNull: false,
		defaultValue: null,
		primaryKey: 0,
		...overrides,
	};
}

function schema(overrides: Partial<SchemaDescription> = {}): SchemaDescription {
	return {
		tables: [
			{
				name: "work_items",
				columns: [
					column("id", { primaryKey: 1, notNull: true }),
					column("org_id", { notNull: true }),
					column("version", { type: "INTEGER", defaultValue: "1" }),
				],
			},
		],
		indexes: [
			{
				name: "idx_work_items_org",
				table: "work_items",
				definition: normalizeDefinition(
					"CREATE INDEX `idx_work_items_org` ON `work_items` (`org_id`)",
				),
			},
		],
		objects: [],
		...overrides,
	};
}

describe("schema comparison", () => {
	it("certifies identical schemas as clean", () => {
		expect(compareSchemaDescriptions(schema(), schema())).toEqual([]);
	});

	it("is not fooled by quoting or whitespace in an index definition", () => {
		const live = schema({
			indexes: [
				{
					name: "idx_work_items_org",
					table: "work_items",
					definition: normalizeDefinition(
						'CREATE INDEX IF NOT EXISTS "idx_work_items_org"\n  ON "work_items"  ( "org_id" )',
					),
				},
			],
		});

		expect(compareSchemaDescriptions(schema(), live)).toEqual([]);
	});

	it("detects a table that live D1 has but the chain does not declare", () => {
		const live = schema();
		live.tables.push({ name: "hand_made", columns: [column("id")] });

		expect(compareSchemaDescriptions(schema(), live)).toEqual([
			{ kind: "unexpected_table", table: "hand_made" },
		]);
	});

	it("detects a declared table that is missing from live D1", () => {
		const expected = schema();
		expected.tables.push({ name: "work_evidence", columns: [column("id")] });

		expect(compareSchemaDescriptions(expected, schema())).toEqual([
			{ kind: "missing_table", table: "work_evidence" },
		]);
	});

	it("detects a dropped column", () => {
		const live = schema();
		live.tables[0].columns = live.tables[0].columns.filter(
			(entry) => entry.name !== "org_id",
		);

		expect(compareSchemaDescriptions(schema(), live)).toEqual([
			{ kind: "missing_column", table: "work_items", column: "org_id" },
		]);
	});

	it("detects a changed column type", () => {
		const live = schema();
		live.tables[0].columns[2] = column("version", {
			type: "TEXT",
			defaultValue: "1",
		});

		expect(compareSchemaDescriptions(schema(), live)).toEqual([
			{
				kind: "column_changed",
				table: "work_items",
				column: "version",
				field: "type",
				expected: "INTEGER",
				actual: "TEXT",
			},
		]);
	});

	it("detects a changed nullability and a changed default separately", () => {
		const live = schema();
		live.tables[0].columns[1] = column("org_id", { notNull: false });

		expect(compareSchemaDescriptions(schema(), live)).toEqual([
			{
				kind: "column_changed",
				table: "work_items",
				column: "org_id",
				field: "notNull",
				expected: "true",
				actual: "false",
			},
		]);
	});

	it("detects an index that differs in definition", () => {
		const live = schema({
			indexes: [
				{
					name: "idx_work_items_org",
					table: "work_items",
					definition: normalizeDefinition(
						"CREATE UNIQUE INDEX `idx_work_items_org` ON `work_items` (`org_id`)",
					),
				},
			],
		});

		const differences = compareSchemaDescriptions(schema(), live);
		expect(differences).toHaveLength(1);
		expect(differences[0]).toMatchObject({
			kind: "index_changed",
			index: "idx_work_items_org",
		});
	});

	it("detects a missing index", () => {
		expect(
			compareSchemaDescriptions(schema(), schema({ indexes: [] })),
		).toEqual([
			{
				kind: "missing_index",
				index: "idx_work_items_org",
				table: "work_items",
			},
		]);
	});

	it("compares an expression index like any other row", () => {
		// drizzle-kit 1.0.0-rc.4 ABORTS introspection here, which is what left
		// production UNVERIFIED. This path must simply diff it.
		const definition = normalizeDefinition(
			"CREATE UNIQUE INDEX `uniq_work_evidence_observation` ON `work_evidence` (`work_item_id`,coalesce(`attempt_id`,''))",
		);
		const expected = schema({
			indexes: [
				{
					name: "uniq_work_evidence_observation",
					table: "work_evidence",
					definition,
				},
			],
		});

		expect(compareSchemaDescriptions(expected, expected)).toEqual([]);
		expect(
			compareSchemaDescriptions(expected, schema({ indexes: [] })),
		).toEqual([
			{
				kind: "missing_index",
				index: "uniq_work_evidence_observation",
				table: "work_evidence",
			},
		]);
	});
});

describe("index qualifier normalization", () => {
	const objectRow = (definition: string) => ({
		object_type: "index",
		object_name: "organizations_descope_tenant_id_unique",
		table_name: "organizations",
		definition,
	});
	// The baseline migration's spelling and a hand-created live index's
	// spelling of the same index.
	const declared =
		'CREATE UNIQUE INDEX `organizations_descope_tenant_id_unique` ON `organizations` (`descope_tenant_id`) WHERE "organizations"."descope_tenant_id" IS NOT NULL';
	const live =
		"CREATE UNIQUE INDEX organizations_descope_tenant_id_unique\nON organizations(descope_tenant_id)\nWHERE descope_tenant_id IS NOT NULL";

	it("treats a table-qualified partial predicate as the same index", () => {
		expect(
			compareSchemaDescriptions(
				buildSchemaDescription([objectRow(declared)], []),
				buildSchemaDescription([objectRow(live)], []),
			),
		).toEqual([]);
	});

	it("still reports a predicate that names a different column", () => {
		const changed = buildSchemaDescription(
			[objectRow(live.replace("WHERE descope_tenant_id", "WHERE slug"))],
			[],
		);
		expect(
			compareSchemaDescriptions(
				buildSchemaDescription([objectRow(declared)], []),
				changed,
			),
		).toMatchObject([{ kind: "index_changed" }]);
	});

	it("keeps a qualifier that names another table", () => {
		expect(
			normalizeDefinition(
				"CREATE INDEX a ON t (x) WHERE other.x IS NOT NULL",
				"t",
			),
		).toContain("other.x");
	});

	it("does not rewrite a string literal that looks like a qualifier", () => {
		expect(
			normalizeDefinition("CREATE INDEX a ON t (x) WHERE x <> 't.x'", "t"),
		).toContain("'t.x'");
	});

	it("never strips qualifiers from a trigger, where they are load-bearing", () => {
		const trigger =
			"CREATE TRIGGER g AFTER INSERT ON t BEGIN SELECT t.x, other.x; END";
		expect(normalizeDefinition(trigger)).toContain("t.x");
		expect(normalizeDefinition(trigger)).toContain("other.x");
	});
});

describe("schema description building", () => {
	it("excludes platform-owned objects on BOTH sides", () => {
		for (const name of [
			"sqlite_autoindex_work_items_1",
			"tedix_drizzle_migrations",
			"__drizzle_migrations",
			"_cf_KV",
			"d1_migrations",
		]) {
			expect(isExcludedObjectName(name)).toBe(true);
		}
		expect(isExcludedObjectName("work_items")).toBe(false);
	});

	it("reports an unmanaged product table instead of hiding it", () => {
		const live = buildSchemaDescription(
			[
				{
					object_type: "table",
					object_name: "unmanaged_imports",
					table_name: "unmanaged_imports",
					definition: "CREATE TABLE unmanaged_imports (id TEXT PRIMARY KEY)",
				},
			],
			[
				{
					table_name: "unmanaged_imports",
					cid: 0,
					column_name: "id",
					column_type: "TEXT",
					not_null: 0,
					default_value: null,
					pk: 1,
				},
			],
		);
		expect(live.tables).toEqual([
			{
				name: "unmanaged_imports",
				columns: [column("id", { primaryKey: 1 })],
			},
		]);
		expect(
			compareSchemaDescriptions({ tables: [], indexes: [], objects: [] }, live),
		).toEqual([{ kind: "unexpected_table", table: "unmanaged_imports" }]);
	});

	it("drops SQLite-generated objects with no stored SQL", () => {
		const description = buildSchemaDescription(
			[
				{
					object_type: "index",
					object_name: "sqlite_autoindex_work_items_1",
					table_name: "work_items",
					definition: null,
				},
				{
					object_type: "index",
					object_name: "idx_real",
					table_name: "work_items",
					definition: "CREATE INDEX `idx_real` ON `work_items` (`org_id`)",
				},
			],
			[
				{
					table_name: "work_items",
					cid: 0,
					column_name: "id",
					column_type: "TEXT",
					not_null: 1,
					default_value: null,
					pk: 1,
				},
			],
		);

		expect(description.indexes.map((index) => index.name)).toEqual([
			"idx_real",
		]);
		expect(description.tables).toEqual([
			{
				name: "work_items",
				columns: [
					{
						name: "id",
						type: "TEXT",
						notNull: true,
						defaultValue: null,
						primaryKey: 1,
					},
				],
			},
		]);
	});
});

describe("live drift verdicts", () => {
	// An unreadable production database is indistinguishable from an outage, so
	// NO ANSWER must never
	// block a deploy — only a difference we actually observed may.
	it("does NOT block when the live schema cannot be read at all", () => {
		const outcome = checkLiveDrift({
			run: () => {
				throw new Error("wrangler exited 1: credentials unavailable");
			},
		});

		expect(outcome.verdict).toBe("unverified");
		if (outcome.verdict !== "unverified") throw new Error("unreachable");
		// The operator must be able to reproduce it, so the message has to name
		// the command and the credential rather than just failing.
		expect(outcome.message).toContain(
			"Could not read the live production schema",
		);
		expect(outcome.message).toContain("CLOUDFLARE_API_TOKEN");
	});

	it("passes a clean verdict with what it actually compared", () => {
		expect(classifyLiveDrift(schema(), schema())).toEqual({
			verdict: "current",
			tableCount: 1,
			indexCount: 1,
		});
	});

	it("BLOCKS on real detected drift and names it", () => {
		const live = schema();
		live.tables[0].columns = live.tables[0].columns.filter(
			(entry) => entry.name !== "org_id",
		);

		const outcome = classifyLiveDrift(schema(), live);

		expect(outcome.verdict).toBe("drift");
		// The operator must see the difference, not just a count.
		expect(outcome).toMatchObject({
			message: expect.stringContaining("work_items.org_id"),
		});
	});
});
