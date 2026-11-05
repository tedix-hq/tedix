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
 * CHECK, foreign keys, and indexes with their partial-index WHERE clauses. It
 * is not a general-purpose DDL emitter; `drizzle-kit generate` remains the
 * source of truth for real migrations.
 */

import { is, SQL } from "drizzle-orm";
import {
	getTableConfig,
	type SQLiteColumn,
	SQLiteDialect,
	SQLiteTable,
	type SQLiteTable as SQLiteTableT,
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

let indexDialect: SQLiteDialect | undefined;

/** Renders an index expression the way `CREATE INDEX` accepts it. */
function indexExpression(expression: SQL): string {
	indexDialect ??= new SQLiteDialect();
	return indexDialect.sqlToQuery(expression.inlineParams(), "indexes").sql;
}

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

export interface TableDdlOptions {
	/**
	 * Emit `FOREIGN KEY` clauses (default true). The logs database holds copies
	 * of ledger tables without their parent tables, so its DDL omits them.
	 */
	foreignKeys?: boolean;
	/**
	 * Emit indexes built over expressions (default false). Test doubles skip
	 * them: several fixtures apply the real migration next to this DDL, and the
	 * retention tests store deliberately non-JSON metadata that a json_extract
	 * index would reject. The logs-database renderer turns them on so its
	 * checked-in migrations are compared index for index.
	 */
	expressionIndexes?: boolean;
}

/** Render `CREATE TABLE` (plus its indexes) for one Drizzle table. */
export function tableDdl(
	table: SQLiteTable,
	options: TableDdlOptions = {},
): string[] {
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

	for (const foreignKey of options.foreignKeys === false
		? []
		: config.foreignKeys) {
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
		const hasExpression = indexConfig.columns.some((column) => is(column, SQL));
		if (hasExpression && !options.expressionIndexes) continue;
		// An expression renders the way drizzle-kit writes it: column references
		// unqualified ("." is not allowed in index expressions), parameters
		// inlined.
		const members = indexConfig.columns.map((column) =>
			is(column, SQL) ? indexExpression(column) : quote(column.name),
		);
		statements.push(
			`CREATE ${indexConfig.unique ? "UNIQUE " : ""}INDEX ${quote(indexConfig.name)} ` +
				`ON ${quote(config.name)} (${members.join(", ")})` +
				(indexConfig.where
					? ` WHERE ${indexExpression(indexConfig.where)}`
					: "") +
				";",
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
export function schemaDdl(...tables: SQLiteTable[]): string;
export function schemaDdl(
	options: TableDdlOptions,
	...tables: SQLiteTable[]
): string;
export function schemaDdl(
	optionsOrTable: TableDdlOptions | SQLiteTable,
	...tables: SQLiteTable[]
): string {
	const isOptions = !is(optionsOrTable, SQLiteTable);
	const options = isOptions ? (optionsOrTable as TableDdlOptions) : {};
	const list = isOptions ? tables : [optionsOrTable as SQLiteTableT, ...tables];
	return list.flatMap((table) => tableDdl(table, options)).join("\n");
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
