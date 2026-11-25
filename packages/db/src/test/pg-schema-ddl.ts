import { is, SQL, sql } from "drizzle-orm";
import {
	getTableConfig,
	PgDialect,
	IndexedColumn,
	type PgTable,
} from "drizzle-orm/pg-core";

const dialect = new PgDialect();
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
/** Test DDL preserves the pg-core definition, including constraints and index expressions. */
export function pgTableDdl(table: PgTable): string[] {
	const config = getTableConfig(table);
	const name = config.schema
		? `${quote(config.schema)}.${quote(config.name)}`
		: quote(config.name);
	// PostgreSQL forbids table-qualified columns in index expressions.
	const expression = (value: SQL) =>
		dialect.sqlToQuery(value.inlineParams()).sql.replaceAll(`${name}.`, "");
	const expressions = config.columns.map((column) => {
		let ddl = `${quote(column.name)} ${column.getSQLType()}`;
		if (column.generatedIdentity)
			ddl += ` GENERATED ${column.generatedIdentity.type === "always" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`;
		if (column.generated) {
			const value =
				typeof column.generated.as === "function"
					? column.generated.as()
					: column.generated.as;
			ddl += ` GENERATED ALWAYS AS (${is(value, SQL) ? expression(value) : value}) STORED`;
		}
		if (column.primary) ddl += " PRIMARY KEY";
		if (column.notNull) ddl += " NOT NULL";
		if (column.isUnique)
			ddl += ` UNIQUE${column.uniqueType === "not distinct" ? " NULLS NOT DISTINCT" : ""}`;
		if (column.default !== undefined) {
			const value = is(column.default, SQL)
				? column.default
				: column.columnType === "PgJsonb"
					? sql.raw(
							`'${JSON.stringify(column.default).replaceAll("'", "''")}'::jsonb`,
						)
					: sql`${column.default}`;
			ddl += ` DEFAULT ${expression(value)}`;
		}
		return ddl;
	});
	for (const pk of config.primaryKeys)
		expressions.push(
			`CONSTRAINT ${quote(pk.getName())} PRIMARY KEY (${pk.columns.map((c) => quote(c.name)).join(",")})`,
		);
	for (const unique of config.uniqueConstraints)
		expressions.push(
			`CONSTRAINT ${quote(unique.getName()!)} UNIQUE${unique.nullsNotDistinct ? " NULLS NOT DISTINCT" : ""} (${unique.columns.map((c) => quote(c.name)).join(",")})`,
		);
	for (const check of config.checks)
		expressions.push(
			`CONSTRAINT ${quote(check.name)} CHECK (${expression(check.value)})`,
		);
	for (const fk of config.foreignKeys) {
		const reference = fk.reference();
		const foreign = getTableConfig(reference.foreignTable);
		const target = foreign.schema
			? `${quote(foreign.schema)}.${quote(foreign.name)}`
			: quote(foreign.name);
		expressions.push(
			`CONSTRAINT ${quote(fk.getName())} FOREIGN KEY (${reference.columns.map((c) => quote(c.name)).join(",")}) REFERENCES ${target} (${reference.foreignColumns.map((c) => quote(c.name)).join(",")}) ON UPDATE ${fk.onUpdate ?? "no action"} ON DELETE ${fk.onDelete ?? "no action"}`,
		);
	}
	return [
		`CREATE TABLE ${name} (${expressions.join(",")})`,
		...config.indexes.map(({ config: idx }) => {
			const columns = idx.columns.map((c) => {
				if (is(c, SQL)) return `(${expression(c)})`;
				if (!is(c, IndexedColumn)) throw new Error("Unsupported index column");
				const options = c.indexConfig;
				return `${quote(c.name)}${options?.opClass ? ` ${options.opClass}` : ""}${options?.order ? ` ${options.order}` : ""}${options?.nulls ? ` NULLS ${options.nulls}` : ""}`;
			});
			const storage = idx.with
				? ` WITH (${Object.entries(idx.with)
						.map(([key, value]) => `${quote(key)}=${value}`)
						.join(",")})`
				: "";
			return `CREATE ${idx.unique ? "UNIQUE " : ""}INDEX ${quote(idx.name!)} ON ${idx.only ? "ONLY " : ""}${name} USING ${idx.method ?? "btree"} (${columns.join(",")})${storage}${idx.where ? ` WHERE ${expression(idx.where)}` : ""}`;
		}),
	];
}
