/**
 * Generate Postgres DDL directly from the Drizzle pg schema, for tests.
 *
 * Mirrors `schema-ddl.ts` for the pg storage plane: deriving DDL from the same
 * table objects the ported queries use keeps test fixtures honest when the
 * schema changes. Covers the subset the ported schema uses — column types,
 * NOT NULL, PRIMARY KEY (single and composite), DEFAULT, UNIQUE, CHECK,
 * foreign keys, and plain indexes. `drizzle-kit generate` remains the source
 * of truth for real migrations.
 */

import { is, SQL } from "drizzle-orm";
import {
	getTableConfig,
	PgTable,
	type PgColumn,
	PgDialect,
	type PgTable as PgTableT,
} from "drizzle-orm/pg-core";

let indexDialect: PgDialect | undefined;

/** Renders an index expression the way `CREATE INDEX` accepts it. */
function indexExpression(expression: SQL): string {
	indexDialect ??= new PgDialect();
	return indexDialect.sqlToQuery(expression.inlineParams(), "indexes").sql;
}

function quote(identifier: string): string {
	return `"${identifier.replace(/"/g, '""')}"`;
}

function literal(value: unknown): string {
	if (value === null) return "NULL";
	if (typeof value === "number") return String(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
	return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
}

function columnDdl(column: PgColumn, isLonePrimaryKey: boolean): string {
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

export interface PgTableDdlOptions {
	/** Emit `FOREIGN KEY` clauses (default true). */
	foreignKeys?: boolean;
	/**
	 * Emit indexes built over expressions (default false). Test doubles skip
	 * them, matching the SQLite-plane renderer.
	 */
	expressionIndexes?: boolean;
}

/** Render `CREATE TABLE` (plus its indexes) for one Drizzle pg table. */
export function pgTableDdl(
	table: PgTable,
	options: PgTableDdlOptions = {},
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
		const members = indexConfig.columns.map((column) =>
			is(column, SQL)
				? indexExpression(column)
				: quote((column as { name: string }).name),
		);
		statements.push(
			`CREATE ${indexConfig.unique ? "UNIQUE " : ""}INDEX ${quote(indexConfig.name ?? `${config.name}_${indexConfig.columns.map((column) => (column as { name?: string }).name ?? "expr").join("_")}`)} ` +
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
 * Order matters when foreign keys are enforced: list parents before children.
 */
export function pgSchemaDdl(...tables: PgTable[]): string;
export function pgSchemaDdl(
	options: PgTableDdlOptions,
	...tables: PgTable[]
): string;
export function pgSchemaDdl(
	optionsOrTable: PgTableDdlOptions | PgTable,
	...tables: PgTable[]
): string {
	const isOptions = !is(optionsOrTable, PgTable);
	const options = isOptions ? (optionsOrTable as PgTableDdlOptions) : {};
	const list = isOptions ? tables : [optionsOrTable as PgTableT, ...tables];
	return list.flatMap((table) => pgTableDdl(table, options)).join("\n");
}
