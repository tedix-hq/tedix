/**
 * `schema-check`: does the workspace object's own table shape accept what
 * `import` writes? For every mapped table, compare the snapshot's columns
 * with the columns the object's migration chain creates. A table the chain
 * does not create yet, or a column that exists on one side only, is a
 * finding; the import would refuse or lose it.
 */
import { DatabaseSync } from "node:sqlite";
import { splitSqlStatements } from "./rows";
import { hasTable, type Snapshot } from "./source";
import { WORKSPACE_TABLES } from "./tables";
import { readTenantStoreMigrations } from "./target";

export interface SchemaFinding {
	table: string;
	kind: "missing-in-object" | "missing-in-snapshot" | "columns-differ";
	detail: string;
}

export interface SchemaCheckReport {
	ok: boolean;
	objectTables: string[];
	checked: Array<{ table: string; columns: number }>;
	findings: SchemaFinding[];
}

/** The object's schema as its migration chain builds it, in memory. */
export function objectSchemaDatabase(
	migrations = readTenantStoreMigrations(),
): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	for (const { sql } of migrations)
		for (const statement of splitSqlStatements(sql)) db.exec(statement);
	return db;
}

function columnsOf(db: DatabaseSync, table: string): string[] {
	return db
		.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid")
		.all(table)
		.map((row) => String(row.name));
}

export function checkSchema(
	snapshot: Snapshot,
	object: DatabaseSync = objectSchemaDatabase(),
): SchemaCheckReport {
	const findings: SchemaFinding[] = [];
	const checked: SchemaCheckReport["checked"] = [];
	for (const mapping of WORKSPACE_TABLES) {
		const source = [snapshot.main, ...snapshot.logs].find((db) =>
			hasTable(db, mapping.table),
		);
		if (!source) {
			findings.push({
				table: mapping.table,
				kind: "missing-in-snapshot",
				detail: "no store in the snapshot has this table",
			});
			continue;
		}
		if (!hasTable(object, mapping.table)) {
			findings.push({
				table: mapping.table,
				kind: "missing-in-object",
				detail: "the object's migration chain does not create it",
			});
			continue;
		}
		const a = columnsOf(source, mapping.table);
		const b = columnsOf(object, mapping.table);
		const onlySnapshot = a.filter((c) => !b.includes(c));
		const onlyObject = b.filter((c) => !a.includes(c));
		if (onlySnapshot.length || onlyObject.length)
			findings.push({
				table: mapping.table,
				kind: "columns-differ",
				detail: `only in snapshot: [${onlySnapshot.join(", ")}] only in object: [${onlyObject.join(", ")}]`,
			});
		else checked.push({ table: mapping.table, columns: a.length });
	}
	return {
		ok: findings.length === 0,
		objectTables: object
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all()
			.map((row) => String(row.name)),
		checked,
		findings,
	};
}

export function renderSchemaCheck(report: SchemaCheckReport): string {
	const lines = [`schema check ${report.ok ? "OK" : "FINDINGS"}`];
	for (const c of report.checked)
		lines.push(`ok       ${c.table} (${c.columns} columns match)`);
	for (const f of report.findings)
		lines.push(`${f.kind.padEnd(19)} ${f.table}: ${f.detail}`);
	return lines.join("\n");
}
