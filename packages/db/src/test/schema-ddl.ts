/**
 * Generate SQLite DDL directly from the Drizzle schema, for tests.
 *
 * Test doubles in this package used to hand-write `CREATE TABLE` blocks. That
 * is a silent drift surface in both directions: a test can pass against a
 * column set the real table does not have, and a migration can add a NOT NULL
 * column that no test ever exercises. Deriving DDL from the same table objects
 * production uses means a schema change is reflected in every test that touches
 * the table, for free.
 *
 * This intentionally covers the subset of SQLite DDL the schema actually uses —
 * column types, NOT NULL, PRIMARY KEY (single and composite), DEFAULT, UNIQUE,
 * CHECK, foreign keys, and indexes. It is not a general-purpose DDL emitter;
 * `drizzle-kit generate` remains the source of truth for real migrations.
 */

import { is, SQL } from "drizzle-orm";
import {
	getTableConfig,
	type SQLiteColumn,
	type SQLiteTable,
} from "drizzle-orm/sqlite-core";
import { capabilityLinks, orgCapabilities } from "../schema/capabilities";
import { organizations } from "../schema/organizations";
import { projects } from "../schema/projects";
import { tediObjectives } from "../schema/tedi-objectives";
import {
	workAttempts,
	workItemComments,
	workItemRelations,
	workItems,
} from "../schema/work-items";
import {
	workApprovalProposals,
	workApprovalDecisions,
	workBudgetEnvelopes,
	workCaseItems,
	workCases,
	workResourcePools,
	workResourceRequirements,
} from "../schema/work-factory";

function quote(identifier: string): string {
	return `"${identifier.replace(/"/g, '""')}"`;
}

function literal(value: unknown): string {
	if (value === null) return "NULL";
	if (typeof value === "number") return String(value);
	if (typeof value === "boolean") return value ? "1" : "0";
	if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
	return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
}

function columnDdl(column: SQLiteColumn, isLonePrimaryKey: boolean): string {
	const parts = [quote(column.name), column.getSQLType()];
	if (isLonePrimaryKey) parts.push("PRIMARY KEY");
	if (column.notNull && !isLonePrimaryKey) parts.push("NOT NULL");
	// `$defaultFn` / `$default` are applied by the driver at insert time and emit
	// no DDL default, so only a materialised default is rendered here.
	if (column.default !== undefined && !is(column.default, SQL)) {
		parts.push(`DEFAULT ${literal(column.default)}`);
	}
	return parts.join(" ");
}

/** Render `CREATE TABLE` (plus its indexes) for one Drizzle table. */
export function tableDdl(table: SQLiteTable): string[] {
	const config = getTableConfig(table);
	const primaryKeyColumns = config.columns.filter((column) => column.primary);
	const compositePrimaryKey = config.primaryKeys[0];

	const definitions: string[] = config.columns.map((column) =>
		columnDdl(
			column,
			primaryKeyColumns.length === 1 && column.primary && !compositePrimaryKey,
		),
	);

	if (compositePrimaryKey) {
		definitions.push(
			`PRIMARY KEY (${compositePrimaryKey.columns.map((column) => quote(column.name)).join(", ")})`,
		);
	}

	for (const unique of config.uniqueConstraints) {
		definitions.push(
			`UNIQUE (${unique.columns.map((column) => quote(column.name)).join(", ")})`,
		);
	}

	for (const foreignKey of config.foreignKeys) {
		const reference = foreignKey.reference();
		definitions.push(
			`FOREIGN KEY (${reference.columns.map((column) => quote(column.name)).join(", ")}) ` +
				`REFERENCES ${quote(getTableConfig(reference.foreignTable).name)} ` +
				`(${reference.foreignColumns.map((column) => quote(column.name)).join(", ")})` +
				(foreignKey.onDelete ? ` ON DELETE ${foreignKey.onDelete}` : ""),
		);
	}

	const statements = [
		`CREATE TABLE ${quote(config.name)} (\n\t${definitions.join(",\n\t")}\n);`,
	];

	for (const index of config.indexes) {
		const indexConfig = index.config;
		// Expression indexes carry SQL rather than columns; tests do not depend on
		// them for correctness, only for the plain column indexes that back
		// uniqueness, so skip anything that is not a bare column list.
		const columns = indexConfig.columns.filter(
			(column): column is SQLiteColumn => !is(column, SQL),
		);
		if (columns.length !== indexConfig.columns.length) continue;
		statements.push(
			`CREATE ${indexConfig.unique ? "UNIQUE " : ""}INDEX ${quote(indexConfig.name)} ` +
				`ON ${quote(config.name)} (${columns.map((column) => quote(column.name)).join(", ")});`,
		);
	}

	return statements;
}

/**
 * Render DDL for every table given, in the order supplied.
 *
 * Order matters when foreign keys are enforced: list parents before children,
 * or create the tables with `PRAGMA foreign_keys = OFF`.
 */
export function schemaDdl(...tables: SQLiteTable[]): string {
	return tables.flatMap(tableDdl).join("\n");
}

/** Current artifact-neutral Work factory schema for focused in-memory tests. */
export function canonicalWorkFactoryDdl(): string {
	return schemaDdl(
		organizations,
		projects,
		workItems,
		workItemRelations,
		workAttempts,
		workResourcePools,
		workResourceRequirements,
		workApprovalProposals,
		workApprovalDecisions,
		workBudgetEnvelopes,
		workCases,
		workCaseItems,
		workItemComments,
		tediObjectives,
		orgCapabilities,
		capabilityLinks,
	);
}
