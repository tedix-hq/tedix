import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { splitMigrationStatements } from "./expected-schema";

const DB_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const MIGRATIONS_DIR = path.join(DB_ROOT, "drizzle");
const LEGACY_MIGRATIONS_DIR = path.join(DB_ROOT, "migrations");

const destructivePatterns = [
	{ label: "DROP TABLE", pattern: /\bDROP\s+TABLE\b/i },
	{ label: "DROP COLUMN", pattern: /\bDROP\s+COLUMN\b/i },
	{ label: "table rename", pattern: /\bALTER\s+TABLE\b[^;]*\bRENAME\b/i },
	{ label: "table recreation", pattern: /\b__new_[a-z0-9_]+\b/i },
	{
		label: "foreign keys disabled",
		pattern: /\bPRAGMA\s+foreign_keys\s*=\s*OFF\b/i,
	},
	{ label: "row deletion", pattern: /\bDELETE\s+FROM\b/i },
] as const;

const migrationStatementBreakpoint = /-->\s*statement-breakpoint/gi;
const sqlCommentsAndQuotedLiterals =
	/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:[^"]|"")*"|`(?:``|[^`])*`/g;

function inspectRemoteCompatibility(sql: string): string[] {
	const hasNestedTriggerCase = sql
		.split(migrationStatementBreakpoint)
		.some((statement) => {
			const executableSql = statement.replace(
				sqlCommentsAndQuotedLiterals,
				" ",
			);
			return (
				/\bCREATE\s+TRIGGER\b/i.test(executableSql) &&
				/\bCASE\b/i.test(executableSql)
			);
		});
	return hasNestedTriggerCase ? ["nested CASE inside CREATE TRIGGER"] : [];
}

/**
 * Applied history ends here: the newest migration production had applied when
 * the chain was frozen. Migrations at or before it are hash-locked by
 * `migration-integrity.json` and are not re-reviewed; the review checks below
 * judge only migrations after it. The cascade replay still runs the whole chain
 * so later migrations see the real reference graph.
 */
export const APPLIED_BASELINE = "20260928120200_cms-www-alias-claims";

/** Whether `name` (`<timestamp>_<slug>[/migration.sql]`) is applied history. */
export function isAppliedHistory(
	name: string,
	appliedBaseline: string | null = APPLIED_BASELINE,
): boolean {
	return (
		appliedBaseline !== null &&
		name.slice(0, 14) <= appliedBaseline.slice(0, 14)
	);
}

/**
 * `PRAGMA foreign_keys` is connection-scoped and a no-op inside the transaction
 * D1 applies a migration in, so it only makes a table rebuild look protected.
 * Unlike `destructivePatterns`, no directive can satisfy it.
 */
const DISABLES_FOREIGN_KEYS = /\bPRAGMA\s+foreign_keys\s*=\s*(OFF|0|false)\b/i;

const destructiveReviewDirective =
	/^--\s*tedix:\s*destructive-reviewed\s+Work-Item:\s*[0-9a-f-]{36}\s*$/im;

export function inspectMigration(
	name: string,
	sql: string,
): {
	destructive: string[];
	remoteIncompatible: string[];
	reviewed: boolean;
} {
	if (!sql.trim()) throw new Error(`${name}: migration is empty`);
	const destructive = destructivePatterns
		.filter(({ pattern }) => pattern.test(sql))
		.map(({ label }) => label);
	const remoteIncompatible = inspectRemoteCompatibility(sql);
	return {
		destructive,
		remoteIncompatible,
		reviewed: destructiveReviewDirective.test(sql),
	};
}

/*
 * Cascade safety. D1 ignores `PRAGMA foreign_keys=OFF` in an applied migration,
 * so dropping (or renaming) a table that another table references ON DELETE
 * CASCADE deletes the child's rows. Reordering a rebuild does not help; the
 * cascade must be defused (drop the child's FK first, or repopulate the child
 * after the parent is final).
 *
 * The reference graph comes from replaying the migration chain statement by
 * statement into in-memory SQLite, not from the TypeScript schema: the blast
 * radius depends on the graph at that statement (including `__new_*` rebuild
 * tables), and a removed table's `.references(...)` disappears from TypeScript
 * in the same change that drops it.
 */

/** One FK edge that would fire when its parent table is dropped. */
export interface CascadeReference {
	/** The table whose rows get deleted. */
	child: string;
	/** The child column carrying the ON DELETE CASCADE foreign key. */
	column: string;
	/** The table being dropped or renamed. */
	parent: string;
}

export interface CascadeHazard {
	operation: "DROP TABLE" | "table rename";
	/** The dropped/renamed table. */
	table: string;
	references: CascadeReference[];
}

/**
 * Every ON DELETE CASCADE edge in the database, as SQLite reports it.
 *
 * `pragma_table_info`-style table-valued join, one round trip. The name filter
 * matches `schema-description.ts` so SQLite/D1 internals never appear.
 */
export const CASCADE_CHILD_SQL =
	'SELECT m.name AS child, f."table" AS parent, f."from" AS column_name, f.on_delete AS on_delete ' +
	"FROM (SELECT name FROM sqlite_master WHERE type = 'table' " +
	"AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' " +
	"AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' " +
	"AND name NOT LIKE 'd1\\_%' ESCAPE '\\') m " +
	"JOIN pragma_foreign_key_list(m.name) f ORDER BY m.name, f.id, f.seq";

/**
 * Comments and string literals only. Unlike
 * {@link sqlCommentsAndQuotedLiterals} this preserves quoted IDENTIFIERS —
 * Drizzle writes every table name as `` `app_adapters` ``, and stripping those
 * would erase the very names this parser is looking for.
 */
const sqlCommentsAndStringLiterals =
	/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'/g;

const dropTableStatement =
	/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"[]?([A-Za-z0-9_]+)[`"\]]?/gi;
const renameTableStatement =
	/\bALTER\s+TABLE\s+[`"[]?([A-Za-z0-9_]+)[`"\]]?\s+RENAME\s+TO\b/gi;

/**
 * The tables a statement removes from under its children. A rename counts:
 * renaming a parent rewrites every child's FK to follow it, so in the rebuild
 * idiom the children end up pointing at the old table the next statement drops.
 */
export function parseCascadeTargets(
	statement: string,
): { operation: CascadeHazard["operation"]; table: string }[] {
	const executableSql = statement.replace(sqlCommentsAndStringLiterals, " ");
	const targets: { operation: CascadeHazard["operation"]; table: string }[] =
		[];
	for (const match of executableSql.matchAll(dropTableStatement)) {
		targets.push({ operation: "DROP TABLE", table: match[1] as string });
	}
	for (const match of executableSql.matchAll(renameTableStatement)) {
		targets.push({ operation: "table rename", table: match[1] as string });
	}
	return targets;
}

/**
 * Children that lose rows when `parent` is dropped.
 *
 * A self-reference is excluded: the table is going away regardless, so its own
 * rows are not additional blast radius.
 */
export function findCascadeChildren(
	database: DatabaseSync,
	parent: string,
): CascadeReference[] {
	const rows = database.prepare(CASCADE_CHILD_SQL).all() as unknown as {
		child: string;
		parent: string;
		column_name: string;
		on_delete: string;
	}[];
	const target = parent.toLowerCase();
	return rows
		.filter(
			(row) =>
				String(row.on_delete).toUpperCase() === "CASCADE" &&
				String(row.parent).toLowerCase() === target &&
				String(row.child).toLowerCase() !== target,
		)
		.map((row) => ({
			child: String(row.child),
			column: String(row.column_name),
			parent: String(row.parent),
		}));
}

/**
 * Per-table acknowledgement directive. Separate from `destructive-reviewed` so
 * the author has to name each parent table whose cascade they accept.
 */
const cascadeReviewDirective =
	/^--\s*tedix:\s*cascade-reviewed\s+Work-Item:\s*[0-9a-f-]{36}\s+Table:\s*([A-Za-z0-9_]+)\s*$/gim;

export function cascadeReviewedTables(sql: string): Set<string> {
	const tables = new Set<string>();
	for (const match of sql.matchAll(cascadeReviewDirective)) {
		tables.add((match[1] as string).toLowerCase());
	}
	return tables;
}

/**
 * Step one migration through `database`, reporting every cascade hazard, and
 * leave the database advanced past it so the next migration sees the real
 * graph.
 *
 * The check runs BEFORE each statement chunk executes, which is the moment the
 * cascade would fire. When a chunk holds several statements the graph is read
 * as of the chunk's start — conservative by construction, which is the correct
 * direction for a data-destruction gate.
 */
export function inspectMigrationCascades(
	database: DatabaseSync,
	name: string,
	sql: string,
): CascadeHazard[] {
	const hazards: CascadeHazard[] = [];
	for (const statement of splitMigrationStatements(sql)) {
		for (const { operation, table } of parseCascadeTargets(statement)) {
			const references = findCascadeChildren(database, table);
			if (references.length > 0) hazards.push({ operation, table, references });
		}
		try {
			database.exec(statement);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(
				`${name}: cascade replay could not execute a statement: ${reason}\nstatement: ${statement.slice(0, 400)}`,
			);
		}
	}
	return hazards;
}

export function renderCascadeHazard(hazard: CascadeHazard): string {
	const paths = hazard.references
		.map(
			(reference) =>
				`    ${reference.child}.${reference.column} -> ${reference.parent} ON DELETE CASCADE (every row of ${reference.child} is deleted)`,
		)
		.join("\n");
	return `  ${hazard.operation} \`${hazard.table}\` cascades into:\n${paths}`;
}

/**
 * Replay the whole chain once, checking every drop and rename against the graph
 * that exists at that instant. Applied history is replayed for state but not
 * judged.
 */
export function checkCascadeSafety(
	directory: string,
	files: readonly string[],
	appliedBaseline: string | null = APPLIED_BASELINE,
): void {
	const database = new DatabaseSync(":memory:");
	try {
		// Matches the replay in `expected-schema.ts`: migrations reference tables
		// created later and backfill against an empty database. The graph is
		// read, never enforced.
		database.exec("PRAGMA foreign_keys = OFF");
		for (const name of files) {
			const sql = readFileSync(path.join(directory, name), "utf8");
			const hazards = inspectMigrationCascades(database, name, sql);
			if (hazards.length === 0 || isAppliedHistory(name, appliedBaseline))
				continue;
			const reviewed = cascadeReviewedTables(sql);
			const unreviewed = hazards.filter(
				(hazard) => !reviewed.has(hazard.table.toLowerCase()),
			);
			if (unreviewed.length === 0) continue;
			throw new Error(
				`${name}: drops or renames a table that another table references ON DELETE CASCADE.\n` +
					`${unreviewed.map(renderCascadeHazard).join("\n")}\n` +
					"D1 does NOT honour `PRAGMA foreign_keys=OFF` in an applied migration, so those " +
					"rows WILL be deleted. Reordering does not help; the cascade must be defused (drop the " +
					"child's foreign key first, or repopulate the child after the parent is final).\n" +
					"If the deletion is intended, add one directive per table:\n" +
					unreviewed
						.map(
							(hazard) =>
								`  -- tedix: cascade-reviewed Work-Item: <uuid> Table: ${hazard.table}`,
						)
						.join("\n"),
			);
		}
	} finally {
		database.close();
	}
}

/**
 * Every migration folder keeps its `snapshot.json`. Each snapshot carries `id`
 * + `prevIds`, and `drizzle-kit check` walks them to detect branch collisions;
 * with a hole, the next generated migration records the wrong parent.
 */
export function assertSnapshotPerMigration(
	directory: string,
	files: readonly string[],
): void {
	const expected = files.map((name) =>
		name.replace(/\/migration\.sql$/, "/snapshot.json"),
	);
	const absent = expected.filter(
		(name) => !existsSync(path.join(directory, name)),
	);
	if (absent.length > 0) {
		throw new Error(
			`Every migration keeps its snapshot.json; missing: ${absent.join(", ")}. ` +
				"Commit the snapshot Drizzle Kit generated beside the migration — the " +
				"chain is how branch collisions are detected, and a hole makes the next " +
				"generated migration record the wrong parent.",
		);
	}
}

export function assertNoLegacyMigrationFiles(files: string[]): void {
	const sqlFiles = files.filter((name) => name.endsWith(".sql")).sort();
	if (sqlFiles.length > 0) {
		throw new Error(
			`Legacy flat D1 migration projection is forbidden; remove: ${sqlFiles.join(", ")}`,
		);
	}
}

function checkLegacyMigrationDirectory(): void {
	assertNoLegacyMigrationFiles(
		existsSync(LEGACY_MIGRATIONS_DIR) ? readdirSync(LEGACY_MIGRATIONS_DIR) : [],
	);
}

export function checkMigrations(
	directory = MIGRATIONS_DIR,
	options: { appliedBaseline?: string | null } = {},
): string[] {
	const appliedBaseline =
		options.appliedBaseline === undefined
			? APPLIED_BASELINE
			: options.appliedBaseline;
	if (directory === MIGRATIONS_DIR) checkLegacyMigrationDirectory();
	const files = readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => `${entry.name}/migration.sql`)
		.sort();
	if (files.length === 0) throw new Error("No D1 migration SQL files found");

	const timestamps = new Set<string>();
	const pragmaOffenders: string[] = [];
	for (const name of files) {
		const match = /^(\d{14})_[^/]+\/migration\.sql$/.exec(name);
		if (!match) {
			throw new Error(
				`${name}: expected <14-digit timestamp>_<slug>/migration.sql`,
			);
		}
		const timestamp = match[1] as string;
		if (timestamps.has(timestamp)) {
			throw new Error(`${name}: duplicate migration timestamp ${timestamp}`);
		}
		timestamps.add(timestamp);
		let sql: string;
		try {
			sql = readFileSync(path.join(directory, name), "utf8");
		} catch {
			throw new Error(`${name}: missing migration.sql`);
		}
		const result = inspectMigration(name, sql);
		if (!isAppliedHistory(name, appliedBaseline)) {
			if (DISABLES_FOREIGN_KEYS.test(sql)) pragmaOffenders.push(name);
			if (result.destructive.length > 0 && !result.reviewed) {
				throw new Error(
					`${name}: destructive DDL (${result.destructive.join(", ")}) requires ` +
						"an explicit `-- tedix: destructive-reviewed Work-Item: <uuid>` directive and a reviewed data-preservation plan",
				);
			}
		}
		if (result.remoteIncompatible.length > 0) {
			throw new Error(
				`${name}: D1 remote migration parser incompatibility (${result.remoteIncompatible.join(", ")}); ` +
					"rewrite trigger CASE expressions without a nested END token",
			);
		}
	}

	// Cascade fixtures intentionally contain only SQL. The canonical migration
	// tree must have every snapshot, including if all of them were removed.
	if (
		path.resolve(directory) === MIGRATIONS_DIR ||
		files.some((name) =>
			existsSync(
				path.join(
					directory,
					name.replace(/\/migration\.sql$/, "/snapshot.json"),
				),
			),
		)
	) {
		assertSnapshotPerMigration(directory, files);
	}

	// Reported after the cascade check on purpose: when a migration has both, the
	// cascade path names the rows at risk, which is the more useful first error.
	checkCascadeSafety(directory, files, appliedBaseline);
	if (pragmaOffenders.length > 0) {
		throw new Error(
			`${pragmaOffenders.join(", ")}: remove \`PRAGMA foreign_keys=OFF\`. D1 ` +
				"applies each migration inside a transaction, where that pragma is a " +
				"no-op, so it protects nothing and misrepresents the migration as safe. " +
				"If this migration drops a table another table references ON DELETE " +
				"CASCADE, the cascade will fire; defuse it explicitly.",
		);
	}
	return files;
}

if (
	import.meta.main ||
	(process.argv[1] &&
		path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
) {
	if (process.argv.includes("--help")) {
		console.log(
			"Usage: check-migrations.ts — verify D1 migration safety and replay the cascade graph",
		);
	} else {
		const files = checkMigrations();
		console.log(
			`D1 migration safety check passed (${files.length} migration(s); cascade graph replayed)`,
		);
	}
}
