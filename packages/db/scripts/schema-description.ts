/**
 * A machine-readable description of a SQLite schema, and the pure comparison
 * that turns two of them into a drift verdict.
 *
 * WHY THIS EXISTS INSTEAD OF `drizzle-kit push --explain`: drizzle-kit
 * 1.0.0-rc.4 ABORTS introspection when the database contains an index built
 * over an expression (`unexpected unique index '…' with expression value`), and
 * in `--output json` mode it exits 1 with empty stdout AND empty stderr. The
 * abort is global — not one table is compared — so the live-drift gate returns
 * NO VERDICT for the whole database, which is how production reached a
 * migration-bearing deploy with "Live D1 drift UNVERIFIED". That is a
 * deterministic capability gap in the tool, not a transport outage, so waiting
 * or re-running never fixes it.
 *
 * The replacement reads the schema the way SQLite itself describes it —
 * `sqlite_master` plus `pragma_table_info` — from BOTH sides:
 *
 *   expected = the reviewed migration chain replayed into a fresh in-memory DB
 *   actual   = live production D1, read over `wrangler d1 execute --remote`
 *
 * Both sides go through the same extraction and the same normalizer, so the
 * only thing a difference can mean is that production does not match the
 * migrations that were supposed to build it. Expression indexes are just rows
 * here; nothing in this path parses SQL semantics.
 *
 * This module is deliberately pure: no processes, no network, no filesystem.
 * It is the part that decides whether production ships, so it is the part that
 * must be unit-testable.
 */

/** One column as `pragma_table_info` reports it. */
export interface SchemaColumn {
	name: string;
	/** Declared type, upper-cased. SQLite stores the declared text verbatim. */
	type: string;
	notNull: boolean;
	/** Verbatim `dflt_value`, including quoting, or null when there is none. */
	defaultValue: string | null;
	/** 0 when not part of the primary key, otherwise its 1-based position. */
	primaryKey: number;
}

export interface SchemaTable {
	name: string;
	columns: SchemaColumn[];
}

export interface SchemaIndex {
	name: string;
	table: string;
	/** Normalized `CREATE INDEX` text. */
	definition: string;
}

export interface SchemaObject {
	name: string;
	type: "view" | "trigger";
	/** Normalized `CREATE VIEW`/`CREATE TRIGGER` text. */
	definition: string;
}

export interface SchemaDescription {
	tables: SchemaTable[];
	indexes: SchemaIndex[];
	objects: SchemaObject[];
}

/**
 * Rows from {@link SCHEMA_OBJECT_SQL}. Typed loosely because they arrive as
 * JSON from Wrangler on one side and as `node:sqlite` rows on the other.
 */
export interface SchemaObjectRow {
	object_type: unknown;
	object_name: unknown;
	table_name: unknown;
	definition: unknown;
}

/** Rows from {@link SCHEMA_COLUMN_SQL}. */
export interface SchemaColumnRow {
	table_name: unknown;
	cid: unknown;
	column_name: unknown;
	column_type: unknown;
	not_null: unknown;
	default_value: unknown;
	pk: unknown;
}

/**
 * Objects the D1 authorizer refuses to introspect at all.
 *
 * `pragma_table_info` over an unfiltered `sqlite_master` fails the WHOLE query
 * with `not authorized: SQLITE_AUTH [code: 7500]` because the join reaches
 * D1/SQLite internal tables. This predicate is applied IDENTICALLY to both
 * queries and to both sides of the comparison, and it is a strict subset of
 * {@link isExcludedObjectName} — the TypeScript filter remains the authority, so
 * a filter that exists on only one side can never manufacture drift, which is
 * exactly how drizzle-kit's `tablesFilter` failed here before.
 */
const INTROSPECTABLE_NAME_PREDICATE =
	"name NOT LIKE 'sqlite\\_%' ESCAPE '\\' " +
	"AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' " +
	"AND name NOT LIKE 'd1\\_%' ESCAPE '\\'";

/** Every object SQLite will describe. */
export const SCHEMA_OBJECT_SQL =
	"SELECT type AS object_type, name AS object_name, tbl_name AS table_name, sql AS definition " +
	`FROM sqlite_master WHERE ${INTROSPECTABLE_NAME_PREDICATE} ORDER BY type, name`;

/**
 * Table-valued `pragma_table_info` in a single round trip. Verified working
 * against production D1 — a per-table PRAGMA loop would be ~250 remote calls.
 */
export const SCHEMA_COLUMN_SQL =
	'SELECT m.name AS table_name, p.cid AS cid, p.name AS column_name, p.type AS column_type, p."notnull" AS not_null, p.dflt_value AS default_value, p.pk AS pk ' +
	"FROM (SELECT name FROM sqlite_master WHERE type = 'table' AND " +
	`${INTROSPECTABLE_NAME_PREDICATE}) m ` +
	"JOIN pragma_table_info(m.name) p ORDER BY m.name, p.cid";

/**
 * Objects that exist in live D1 but are not owned by the migration chain, or
 * vice versa. Each entry is a deliberate, named exception — never a wildcard
 * that could hide a real product table.
 *
 * - `sqlite_*`  : SQLite internals, including UNIQUE auto-indexes.
 * - `_cf_*`/`d1_*`: Cloudflare/D1 internals.
 * - `tedix_drizzle_migrations`: Wrangler's native ledger, created by the
 *   ledger-cutover migration and owned by Wrangler, not by the schema.
 *
 * Kept aligned with `tablesFilter` in `drizzle.config.ts`.
 */
export const EXCLUDED_OBJECT_NAMES = new Set([
	"tedix_drizzle_migrations",
	"__drizzle_migrations",
	"_cf_METADATA",
]);

const EXCLUDED_OBJECT_PREFIXES = ["sqlite_", "_cf_", "d1_"];

export function isExcludedObjectName(name: string): boolean {
	if (EXCLUDED_OBJECT_NAMES.has(name)) return true;
	const lowered = name.toLowerCase();
	return EXCLUDED_OBJECT_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

/**
 * Reduce DDL text to the form where only a real difference survives.
 *
 * SQLite stores the CREATE statement verbatim, so replaying the same migration
 * file locally yields byte-identical text; normalizing anyway keeps the check
 * from failing on a whitespace or quoting difference introduced by a hand-run
 * statement that is otherwise the same schema. Quoted-identifier styles are
 * stripped, keyword case is folded, and `IF NOT EXISTS` is dropped. Single
 * quotes are preserved so string literals still compare.
 */
export function normalizeDefinition(
	sql: string,
	/**
	 * The table an index belongs to. Supplying it strips that one table's
	 * qualifier from column references — see {@link stripOwnTableQualifier}.
	 * Never pass an owner for a view or trigger.
	 */
	ownerTable?: string,
): string {
	const normalized = sql
		.replace(/[`"[\]]/g, "")
		.replace(/\bIF\s+NOT\s+EXISTS\b/gi, "")
		.replace(/\s+/g, " ")
		.replace(/\s*([(),])\s*/g, "$1")
		.replace(/;\s*$/, "")
		.trim()
		.toLowerCase();
	return ownerTable
		? stripOwnTableQualifier(normalized, ownerTable.toLowerCase())
		: normalized;
}

/** Single-quoted string literals, kept intact by {@link stripOwnTableQualifier}. */
const SINGLE_QUOTED_LITERAL = /('(?:''|[^'])*')/;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove the indexed table's own qualifier from an index definition.
 *
 * `CREATE INDEX ... ON organizations(x) WHERE "organizations"."x" IS NOT NULL`
 * and the same statement written `WHERE x IS NOT NULL` are the SAME index:
 * inside a `CREATE INDEX`, the indexed table is the only table in scope, so a
 * qualifier naming it is redundant and SQLite resolves both spellings to the
 * identical column. Production carries the bare spelling for
 * `organizations_descope_tenant_id_unique` because the index was created by
 * hand; the migration chain carries Drizzle's qualified spelling. Comparing raw
 * DDL text reported that as drift when nothing about the index differs.
 *
 * This is deliberately the NARROWEST rule that closes the false positive:
 *
 * - Only the index's OWN table name is stripped, so `other_table.x` still
 *   differs from `x` — and inside a view or trigger, where several tables are
 *   in scope and a qualifier is load-bearing, no stripping happens at all
 *   because callers pass no owner.
 * - Only the `<table>.` prefix disappears. Column names, key order, `UNIQUE`,
 *   collations, `ASC`/`DESC`, expressions and the structure of the partial
 *   predicate all still compare exactly, so real index drift still fails.
 * - String literals are left alone, so a predicate comparing against the
 *   literal `'organizations.x'` is not rewritten.
 */
export function stripOwnTableQualifier(
	definition: string,
	ownerTable: string,
): string {
	const qualifier = new RegExp(
		`(^|[^a-z0-9_$])${escapeRegExp(ownerTable)}\\.`,
		"g",
	);
	return definition
		.split(SINGLE_QUOTED_LITERAL)
		.map((segment, index) =>
			index % 2 === 1 ? segment : segment.replace(qualifier, "$1"),
		)
		.join("");
}

function asString(value: unknown, context: string): string {
	if (typeof value !== "string") {
		throw new Error(`${context} is not a string: ${JSON.stringify(value)}`);
	}
	return value;
}

function asNumber(value: unknown, context: string): number {
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	throw new Error(`${context} is not a number: ${JSON.stringify(value)}`);
}

/**
 * Build a comparable description from the two raw result sets.
 *
 * Tables come from the column query (a table with zero readable columns is not
 * describable and must not silently compare as empty), indexes and the
 * remaining objects from `sqlite_master`.
 */
export function buildSchemaDescription(
	objectRows: readonly SchemaObjectRow[],
	columnRows: readonly SchemaColumnRow[],
): SchemaDescription {
	const tables = new Map<string, SchemaColumn[]>();
	for (const row of columnRows) {
		const table = asString(row.table_name, "column row table_name");
		if (isExcludedObjectName(table)) continue;
		const columns = tables.get(table) ?? [];
		columns.push({
			name: asString(row.column_name, `${table} column name`),
			type: asString(row.column_type, `${table} column type`).toUpperCase(),
			notNull: asNumber(row.not_null, `${table} notnull`) !== 0,
			defaultValue:
				row.default_value === null || row.default_value === undefined
					? null
					: String(row.default_value),
			primaryKey: asNumber(row.pk, `${table} pk`),
		});
		tables.set(table, columns);
	}

	const indexes: SchemaIndex[] = [];
	const objects: SchemaObject[] = [];
	for (const row of objectRows) {
		const name = asString(row.object_name, "object row name");
		const type = asString(row.object_type, "object row type");
		if (isExcludedObjectName(name)) continue;
		const owner =
			typeof row.table_name === "string" ? row.table_name : undefined;
		if (owner && isExcludedObjectName(owner)) continue;
		// A NULL `sql` means SQLite generated the object itself (UNIQUE/PK
		// auto-indexes). Those are implied by the table definition already
		// compared above, and they carry no stable name to diff.
		if (typeof row.definition !== "string") continue;
		if (type === "index") {
			indexes.push({
				name,
				table: owner ?? "",
				definition: normalizeDefinition(row.definition, owner),
			});
		} else if (type === "view" || type === "trigger") {
			objects.push({
				name,
				type,
				definition: normalizeDefinition(row.definition),
			});
		}
	}

	return {
		tables: [...tables.entries()]
			.map(([name, columns]) => ({ name, columns }))
			.sort((a, b) => a.name.localeCompare(b.name)),
		indexes: indexes.sort((a, b) => a.name.localeCompare(b.name)),
		objects: objects.sort((a, b) => a.name.localeCompare(b.name)),
	};
}

export type SchemaDifference =
	| { kind: "missing_table"; table: string }
	| { kind: "unexpected_table"; table: string }
	| { kind: "missing_column"; table: string; column: string }
	| { kind: "unexpected_column"; table: string; column: string }
	| {
			kind: "column_changed";
			table: string;
			column: string;
			field: "type" | "notNull" | "default" | "primaryKey";
			expected: string;
			actual: string;
	  }
	| { kind: "missing_index"; index: string; table: string }
	| { kind: "unexpected_index"; index: string; table: string }
	| { kind: "index_changed"; index: string; expected: string; actual: string }
	| { kind: "missing_object"; object: string; objectType: string }
	| { kind: "unexpected_object"; object: string; objectType: string }
	| {
			kind: "object_changed";
			object: string;
			expected: string;
			actual: string;
	  };

function compareColumns(
	table: string,
	expected: readonly SchemaColumn[],
	actual: readonly SchemaColumn[],
): SchemaDifference[] {
	const differences: SchemaDifference[] = [];
	const actualByName = new Map(actual.map((column) => [column.name, column]));
	const expectedNames = new Set(expected.map((column) => column.name));

	for (const column of expected) {
		const live = actualByName.get(column.name);
		if (!live) {
			differences.push({ kind: "missing_column", table, column: column.name });
			continue;
		}
		if (live.type !== column.type) {
			differences.push({
				kind: "column_changed",
				table,
				column: column.name,
				field: "type",
				expected: column.type,
				actual: live.type,
			});
		}
		if (live.notNull !== column.notNull) {
			differences.push({
				kind: "column_changed",
				table,
				column: column.name,
				field: "notNull",
				expected: String(column.notNull),
				actual: String(live.notNull),
			});
		}
		if ((live.defaultValue ?? "") !== (column.defaultValue ?? "")) {
			differences.push({
				kind: "column_changed",
				table,
				column: column.name,
				field: "default",
				expected: column.defaultValue ?? "<none>",
				actual: live.defaultValue ?? "<none>",
			});
		}
		if (live.primaryKey !== column.primaryKey) {
			differences.push({
				kind: "column_changed",
				table,
				column: column.name,
				field: "primaryKey",
				expected: String(column.primaryKey),
				actual: String(live.primaryKey),
			});
		}
	}

	for (const column of actual) {
		if (!expectedNames.has(column.name)) {
			differences.push({
				kind: "unexpected_column",
				table,
				column: column.name,
			});
		}
	}

	return differences;
}

/**
 * Compare the declared schema against the live one.
 *
 * `expected` is what the reviewed migration chain builds; `actual` is what
 * production reports. An empty result is the only thing that certifies a clean
 * schema — the caller must never treat a thrown error or an unobtainable
 * description as an empty diff.
 */
export function compareSchemaDescriptions(
	expected: SchemaDescription,
	actual: SchemaDescription,
): SchemaDifference[] {
	const differences: SchemaDifference[] = [];

	const actualTables = new Map(
		actual.tables.map((table) => [table.name, table]),
	);
	const expectedTables = new Map(
		expected.tables.map((table) => [table.name, table]),
	);
	for (const table of expected.tables) {
		const live = actualTables.get(table.name);
		if (!live) {
			differences.push({ kind: "missing_table", table: table.name });
			continue;
		}
		differences.push(
			...compareColumns(table.name, table.columns, live.columns),
		);
	}
	for (const table of actual.tables) {
		if (!expectedTables.has(table.name)) {
			differences.push({ kind: "unexpected_table", table: table.name });
		}
	}

	const actualIndexes = new Map(
		actual.indexes.map((index) => [index.name, index]),
	);
	const expectedIndexes = new Map(
		expected.indexes.map((index) => [index.name, index]),
	);
	for (const index of expected.indexes) {
		const live = actualIndexes.get(index.name);
		if (!live) {
			differences.push({
				kind: "missing_index",
				index: index.name,
				table: index.table,
			});
			continue;
		}
		if (live.definition !== index.definition) {
			differences.push({
				kind: "index_changed",
				index: index.name,
				expected: index.definition,
				actual: live.definition,
			});
		}
	}
	for (const index of actual.indexes) {
		if (!expectedIndexes.has(index.name)) {
			differences.push({
				kind: "unexpected_index",
				index: index.name,
				table: index.table,
			});
		}
	}

	const actualObjects = new Map(
		actual.objects.map((object) => [object.name, object]),
	);
	const expectedObjects = new Map(
		expected.objects.map((object) => [object.name, object]),
	);
	for (const object of expected.objects) {
		const live = actualObjects.get(object.name);
		if (!live) {
			differences.push({
				kind: "missing_object",
				object: object.name,
				objectType: object.type,
			});
			continue;
		}
		if (live.definition !== object.definition) {
			differences.push({
				kind: "object_changed",
				object: object.name,
				expected: object.definition,
				actual: live.definition,
			});
		}
	}
	for (const object of actual.objects) {
		if (!expectedObjects.has(object.name)) {
			differences.push({
				kind: "unexpected_object",
				object: object.name,
				objectType: object.type,
			});
		}
	}

	return differences;
}

/** One operator-readable line per difference. */
export function renderSchemaDifference(difference: SchemaDifference): string {
	switch (difference.kind) {
		case "missing_table":
			return `table ${difference.table} is declared but MISSING from live D1`;
		case "unexpected_table":
			return `table ${difference.table} exists in live D1 but is not declared`;
		case "missing_column":
			return `column ${difference.table}.${difference.column} is declared but MISSING from live D1`;
		case "unexpected_column":
			return `column ${difference.table}.${difference.column} exists in live D1 but is not declared`;
		case "column_changed":
			return `column ${difference.table}.${difference.column} ${difference.field}: declared ${difference.expected}, live ${difference.actual}`;
		case "missing_index":
			return `index ${difference.index} on ${difference.table} is declared but MISSING from live D1`;
		case "unexpected_index":
			return `index ${difference.index} on ${difference.table} exists in live D1 but is not declared`;
		case "index_changed":
			return `index ${difference.index} differs:\n  declared: ${difference.expected}\n  live:     ${difference.actual}`;
		case "missing_object":
			return `${difference.objectType} ${difference.object} is declared but MISSING from live D1`;
		case "unexpected_object":
			return `${difference.objectType} ${difference.object} exists in live D1 but is not declared`;
		case "object_changed":
			return `object ${difference.object} differs:\n  declared: ${difference.expected}\n  live:     ${difference.actual}`;
	}
}

export function renderSchemaDifferences(
	differences: readonly SchemaDifference[],
): string {
	return differences.map(renderSchemaDifference).join("\n");
}

/* ------------------------------------------------------------------ *
 * ACKNOWLEDGED DIFFERENCES
 *
 * An acknowledgement is NOT a suppression, and that distinction is the whole
 * design of what follows.
 *
 * A suppression says "ignore this table" or "ignore notNull". This says: on
 * these six exact columns, and only for `notNull`, and only in the direction
 * where LIVE IS STRICTER THAN DECLARED, the difference is known, explained,
 * printed on every run, and required to still exist. Everything else about those same columns — type, default, primary-key
 * position — and every other column and table in the database still blocks.
 * Reverse the direction and it blocks loudly.
 *
 * WHAT THESE SIX ARE. `app_adapters`, `mcp_payment_events`,
 * `tedi_email_attachments`, `tedi_email_events`, `tedi_email_messages` and
 * `tedi_email_threads` carry `id text PRIMARY KEY NOT NULL` in production while
 * the reviewed migration chain declares `id text PRIMARY KEY`. The extra NOT
 * NULL was injected by a historical `drizzle-kit push` recreate, whose
 * fingerprint is still visible in live `sqlite_master` (double-quoted table
 * name, old unnamed `FOREIGN KEY (...)` form).
 *
 * They are REAL differences, not noise. In SQLite a TEXT column declared
 * PRIMARY KEY without NOT NULL genuinely admits one NULL row — a long-standing
 * documented deviation from the standard. Live therefore enforces a constraint
 * the chain does not.
 *
 * WHY THEY ARE NOT SIMPLY FIXED. Every ordinary route is closed:
 *   - TypeScript cannot express it. drizzle-kit 1.0.0-rc.4 models a primary-key
 *     column as implicitly not-null and DISCARDS `.notNull()` on it; adding it
 *     yields "No Drizzle schema changes" and leaves `notNull: false` in the
 *     snapshot.
 *   - SQLite has no `ALTER COLUMN`.
 *   - The baseline migration is applied history and must never be edited.
 *   - A hand-written table rebuild cascade-deletes the email child tables,
 *     because D1 ignores `PRAGMA foreign_keys=OFF` in an applied migration.
 *
 * So the choice is between a gate permanently red for a difference in the
 * safe direction, which trains operators to ignore it, and this: a narrow,
 * direction-aware, self-expiring, always-printed acknowledgement.
 * ------------------------------------------------------------------ */

/**
 * One reviewed, named difference the gate will not block on.
 *
 * `declared` and `live` pin the DIRECTION. They are compared exactly against
 * the values of a `column_changed` difference, so an entry covers one direction
 * of one property of one column and nothing else.
 */
export interface AcknowledgedDifference {
	table: string;
	column: string;
	/** The single column property acknowledged. Never widen this to a list. */
	field: "type" | "notNull" | "default" | "primaryKey";
	/** The value the migration chain declares. */
	declared: string;
	/** The value production reports. Must be the STRICTER side. */
	live: string;
	reason: string;
}

const PUSH_RECREATED_PRIMARY_KEY_NOT_NULL =
	"`drizzle-kit push` recreated this table with `id text PRIMARY KEY NOT NULL` " +
	"while the chain declares `id text PRIMARY KEY`. Live is STRICTER: SQLite " +
	"admits one NULL in a TEXT PRIMARY KEY, production does not. Unfixable in " +
	"TypeScript (drizzle-kit rc.4 discards `.notNull()` on a primary key), " +
	"unfixable by ALTER (SQLite has none), and a table rebuild would cascade-delete " +
	"child rows.";

const PUSH_RECREATED_PRIMARY_KEY_TABLES = [
	"app_adapters",
	"mcp_payment_events",
	"tedi_email_attachments",
	"tedi_email_events",
	"tedi_email_messages",
	"tedi_email_threads",
] as const;

export const ACKNOWLEDGED_DIFFERENCES: readonly AcknowledgedDifference[] =
	PUSH_RECREATED_PRIMARY_KEY_TABLES.map((table) => ({
		table,
		column: "id",
		field: "notNull" as const,
		// Direction-aware by construction: declared false, live true. A live side
		// that became LOOSER than the chain renders as `declared true / live
		// false`, matches nothing here, and blocks — that direction is real
		// production risk, not a documented deviation.
		declared: "false",
		live: "true",
		reason: PUSH_RECREATED_PRIMARY_KEY_NOT_NULL,
	}));

export interface PartitionedDifferences {
	/** Differences that must fail the gate. */
	blocking: SchemaDifference[];
	/** Acknowledged entries actually observed this run. */
	acknowledged: AcknowledgedDifference[];
	/**
	 * Acknowledged entries the live schema no longer exhibits. Someone fixed the
	 * difference; the entry has to be deleted, or the list rots into exactly the
	 * blanket suppression it was written not to be.
	 */
	stale: AcknowledgedDifference[];
}

function matchesAcknowledgement(
	difference: SchemaDifference,
	entry: AcknowledgedDifference,
): boolean {
	return (
		difference.kind === "column_changed" &&
		difference.table === entry.table &&
		difference.column === entry.column &&
		difference.field === entry.field &&
		difference.expected === entry.declared &&
		difference.actual === entry.live
	);
}

/**
 * Split a comparison into what blocks, what was acknowledged, and what has gone
 * stale.
 *
 * Pure and total: every input difference lands in exactly one of `blocking` or
 * `acknowledged`, and every acknowledgement lands in `acknowledged` or `stale`.
 */
export function partitionAcknowledgedDifferences(
	differences: readonly SchemaDifference[],
	acknowledgements: readonly AcknowledgedDifference[] = ACKNOWLEDGED_DIFFERENCES,
): PartitionedDifferences {
	const observed = new Set<AcknowledgedDifference>();
	const blocking: SchemaDifference[] = [];
	for (const difference of differences) {
		const entry = acknowledgements.find((candidate) =>
			matchesAcknowledgement(difference, candidate),
		);
		if (entry) observed.add(entry);
		else blocking.push(difference);
	}
	return {
		blocking,
		acknowledged: acknowledgements.filter((entry) => observed.has(entry)),
		stale: acknowledgements.filter((entry) => !observed.has(entry)),
	};
}

function hasColumn(
	description: SchemaDescription,
	table: string,
	column: string,
): boolean {
	return (
		description.tables
			.find((candidate) => candidate.name === table)
			?.columns.some((candidate) => candidate.name === column) ?? false
	);
}

/**
 * The acknowledgements that this comparison can say anything about.
 *
 * An entry only becomes STALE when the column it names exists on BOTH sides and
 * the difference is nevertheless gone — that is what "someone fixed it" looks
 * like. If the column is absent from either description the comparison has
 * already reported a structural difference (`missing_table`/`missing_column`,
 * which blocks), and calling the entry stale on top of that would be noise
 * pointing at the wrong fix.
 */
export function applicableAcknowledgements(
	expected: SchemaDescription,
	actual: SchemaDescription,
	acknowledgements: readonly AcknowledgedDifference[] = ACKNOWLEDGED_DIFFERENCES,
): AcknowledgedDifference[] {
	return acknowledgements.filter(
		(entry) =>
			hasColumn(expected, entry.table, entry.column) &&
			hasColumn(actual, entry.table, entry.column),
	);
}

/** One operator-readable line per acknowledged entry. */
export function renderAcknowledgedDifference(
	entry: AcknowledgedDifference,
): string {
	return (
		`${entry.table}.${entry.column} ${entry.field}: declared ${entry.declared}, live ${entry.live} ` +
		"(live is STRICTER)"
	);
}

export function renderAcknowledgedDifferences(
	entries: readonly AcknowledgedDifference[],
): string {
	return entries.map(renderAcknowledgedDifference).join("\n");
}
