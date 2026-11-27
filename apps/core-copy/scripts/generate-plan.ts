/**
 * Generates src/plan.generated.ts: the ordered copy plan for the D1 -> Postgres
 * cutover, derived from the pg-core schema (packages/db/src/schema-pg/core.ts)
 * cross-checked against the live D1 schema (packages/db/src/schema).
 *
 * Run: bun apps/core-copy/scripts/generate-plan.ts  (from the repo root)
 */
import { readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import {
	getTableConfig as getSqliteTableConfig,
	SQLiteTable,
} from "drizzle-orm/sqlite-core";
import * as pgSchema from "@tedix/db/schema-pg/core";

type Kind = "value" | "json" | "boolean" | "epoch" | "timestamp";
export interface PlanEntry {
	table: string;
	keys: string[];
	columns: Record<string, Kind>;
	sourceRowid?: string;
	/** Columns whose D1 payload is replaced before copy; bodies move to R2. */
	blank?: Record<string, "" | null>;
}

/** Tables the cutover keeps out of Postgres entirely. */
const EXCLUDED_TABLES: Record<string, string> = {
	cms_restore_permits: "durable-object restore state, not copied",
	cms_restore_fences: "durable-object restore state, not copied",
};

/** Large payload columns the cutover archives to R2 instead of Postgres. */
const R2_BLANKS: Record<string, Record<string, "" | null>> = {
	agent_session_events: { body: "" },
	os_gadget_executions: { input: null, output: null },
};

/**
 * Columns the pg schema cannot express (added by drizzle-pg migrations after
 * the schema snapshot) plus any sourceRowid the copy must preserve.
 */
const TABLE_OVERRIDES: Record<
	string,
	{ sourceRowid?: string; addColumns?: Record<string, Kind> }
> = {
	docs_releases: {
		// docs_releases.release_order is GENERATED ALWAYS AS IDENTITY in
		// Postgres; the source rowid keeps release ordering stable.
		sourceRowid: "release_order",
		addColumns: { release_order: "value" },
	},
};

function columnKind(
	pgColumnType: string,
	dataType: string,
	sqliteType?: string,
): Kind {
	if (
		dataType === "json" ||
		pgColumnType === "PgJson" ||
		pgColumnType === "PgJsonb"
	)
		return "json";
	if (dataType === "boolean" || pgColumnType === "PgBoolean") return "boolean";
	if (
		pgColumnType.startsWith("PgTimestamp") ||
		pgColumnType === "PgDate" ||
		pgColumnType === "PgTimestampString"
	)
		// audit_events.timestamp is the only epoch-seconds column pair
		// (SQLiteTimestamp mode "timestamp"); every other timestamp in the pg
		// schema is text ISO and stays "value".
		return sqliteType === "SQLiteTimestamp" ? "epoch" : "timestamp";
	return "value";
}

interface RawEntry {
	entry: PlanEntry;
	/** pg table names this table's foreign keys point at. */
	dependsOn: Set<string>;
	skipped?: string;
}

export interface BuiltPlan {
	ordered: PlanEntry[];
	skipped: { table: string; reason: string }[];
}

/** Rebuilds the plan from the live schemas; the freshness test calls this. */
export async function buildCoreCopyPlan(): Promise<BuiltPlan> {
	// The D1 schema index does not re-export every domain file, so load each
	// schema module directly; the is(SQLiteTable) filter keeps helpers out.
	const SQLITE_SCHEMA_DIR = fileURLToPath(
		new URL("../../../packages/db/src/schema/", import.meta.url),
	);
	const sqliteTables = new Map<
		string,
		ReturnType<typeof getSqliteTableConfig>
	>();
	for (const file of readdirSync(SQLITE_SCHEMA_DIR)) {
		if (!file.endsWith(".ts") || file.includes(".test.")) continue;
		const module = (await import(
			pathToFileURL(`${SQLITE_SCHEMA_DIR}${file}`).href
		)) as Record<string, unknown>;
		for (const value of Object.values(module)) {
			if (is(value, SQLiteTable)) {
				const config = getSqliteTableConfig(value);
				sqliteTables.set(config.name, config);
			}
		}
	}

	const raw: RawEntry[] = [];
	for (const value of Object.values(pgSchema)) {
		if (!is(value, PgTable)) continue;
		const config = getTableConfig(value);
		const name = config.name;
		if (config.schema) {
			raw.push({
				entry: { table: name, keys: [], columns: {} },
				dependsOn: new Set(),
				skipped: "non-core pg schema",
			});
			continue;
		}
		if (EXCLUDED_TABLES[name]) {
			raw.push({
				entry: { table: name, keys: [], columns: {} },
				dependsOn: new Set(),
				skipped: EXCLUDED_TABLES[name],
			});
			continue;
		}
		const sqlite = sqliteTables.get(name);
		if (!sqlite) {
			raw.push({
				entry: { table: name, keys: [], columns: {} },
				dependsOn: new Set(),
				skipped: "no matching D1 table",
			});
			continue;
		}
		const sqliteColumns = new Map(
			sqlite.columns.map((column) => [column.name, column]),
		);
		const columns: Record<string, Kind> = {};
		for (const column of config.columns) {
			// Only columns the D1 read can return may be copied; pg-only columns
			// (sequences, R2 keys added by migration) take their defaults.
			const lite = sqliteColumns.get(column.name);
			if (!lite) continue;
			columns[column.name] = columnKind(
				column.columnType,
				String(column.dataType),
				lite.columnType,
			);
		}
		const override = TABLE_OVERRIDES[name];
		for (const [column, kind] of Object.entries(override?.addColumns ?? {}))
			columns[column] = kind;

		const keyNames = new Set<string>();
		for (const pk of config.primaryKeys)
			for (const column of pk.columns) keyNames.add(column.name);
		for (const column of config.columns)
			if ((column as { primary?: boolean }).primary) keyNames.add(column.name);
		// Tables without a primary key still copy when a unique constraint or
		// unique index gives ON CONFLICT a target (for example
		// billing_service_credit_controls).
		if (!keyNames.size) {
			const candidates: string[][] = [];
			for (const constraint of config.uniqueConstraints)
				candidates.push(constraint.columns.map((column) => column.name));
			for (const index of config.indexes ?? []) {
				const indexConfig = index.config as {
					unique?: boolean;
					columns?: { name: string }[];
				};
				if (indexConfig.unique && indexConfig.columns)
					candidates.push(indexConfig.columns.map((column) => column.name));
			}
			const usable = candidates
				.filter(
					(candidate) =>
						candidate.length > 0 && candidate.every((key) => key in columns),
				)
				.sort((a, b) => a.length - b.length)[0];
			if (usable) for (const key of usable) keyNames.add(key);
		}
		const keys = [...keyNames];
		if (!keys.length || keys.some((key) => !(key in columns))) {
			raw.push({
				entry: { table: name, keys: [], columns: {} },
				dependsOn: new Set(),
				skipped: "no usable primary key",
			});
			continue;
		}
		const dependsOn = new Set<string>();
		for (const fk of config.foreignKeys)
			for (const ref of fk.reference().foreignColumns)
				dependsOn.add(
					getTableConfig(
						(ref as unknown as { table: Parameters<typeof getTableConfig>[0] })
							.table,
					).name,
				);
		dependsOn.delete(name);
		const entry: PlanEntry = {
			table: name,
			keys: keys.sort(),
			columns,
		};
		if (override?.sourceRowid) entry.sourceRowid = override.sourceRowid;
		const blank = R2_BLANKS[name];
		if (blank) entry.blank = blank;
		raw.push({ entry, dependsOn });
	}

	// Parents before children so foreign keys are satisfied during the copy.
	// Cycles fall back to name order; the cutover runbook owns deferred repairs.
	const included = new Map(
		raw.filter((r) => !r.skipped).map((r) => [r.entry.table, r]),
	);
	const ordered: PlanEntry[] = [];
	const done = new Set<string>();
	while (ordered.length < included.size) {
		const ready = [...included.values()]
			.filter((r) => !done.has(r.entry.table))
			.filter((r) =>
				[...r.dependsOn].every((dep) => !included.has(dep) || done.has(dep)),
			)
			.map((r) => r.entry.table)
			.sort();
		if (!ready.length) {
			const rest = [...included.keys()].filter((t) => !done.has(t)).sort();
			for (const table of rest) {
				ordered.push(included.get(table)!.entry);
				done.add(table);
			}
			break;
		}
		for (const table of ready) {
			ordered.push(included.get(table)!.entry);
			done.add(table);
		}
	}
	const skipped = raw
		.filter((r) => r.skipped)
		.map((r) => ({ table: r.entry.table, reason: r.skipped! }))
		.sort((a, b) => a.table.localeCompare(b.table));
	return { ordered, skipped };
}

export function coreCopyPlanSource(plan: BuiltPlan): string {
	return `// Generated by apps/core-copy/scripts/generate-plan.ts. Do not edit.
export interface CoreCopyPlanEntry {
	table: string;
	keys: string[];
	columns: Record<string, "value" | "json" | "boolean" | "epoch" | "timestamp">;
	sourceRowid?: string;
	blank?: Record<string, "" | null>;
}
export const CORE_COPY_PLAN: CoreCopyPlanEntry[] = ${JSON.stringify(plan.ordered, null, "\t")};
export const CORE_COPY_SKIPPED: { table: string; reason: string }[] = ${JSON.stringify(plan.skipped, null, "\t")};
`;
}

if (import.meta.main) {
	const plan = await buildCoreCopyPlan();
	const target = fileURLToPath(
		new URL("../src/plan.generated.ts", import.meta.url),
	);
	writeFileSync(target, coreCopyPlanSource(plan));
	console.log(
		`plan: ${plan.ordered.length} tables, ${plan.skipped.length} skipped -> ${target}`,
	);
	for (const item of plan.skipped)
		console.log(`  skip ${item.table}: ${item.reason}`);
}
