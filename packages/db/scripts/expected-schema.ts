/**
 * The DECLARED schema, derived by replaying the reviewed migration chain into a
 * fresh in-memory SQLite database.
 *
 * The migration chain — not the Drizzle TypeScript schema — is the right
 * expectation for a LIVE drift check. `db:schema:check` already proves the
 * TypeScript schema and the migration snapshot agree; what production can
 * silently violate is the chain itself (a hand-run ALTER, a `push` that
 * truncate-recreated a table, a partially applied migration). Replaying the
 * same files D1 applied means both sides of the comparison are built by the
 * same statements, so the only surviving difference is real drift.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationManifest } from "./check-live-migration-ledger";
import {
	buildSchemaDescription,
	SCHEMA_COLUMN_SQL,
	SCHEMA_OBJECT_SQL,
	type SchemaColumnRow,
	type SchemaDescription,
	type SchemaObjectRow,
} from "./schema-description";

const DB_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

/** Drizzle's statement separator inside a generated migration file. */
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

export function splitMigrationStatements(sql: string): string[] {
	return sql
		.split(STATEMENT_BREAKPOINT)
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

/**
 * Replay every migration in manifest order and describe the result.
 *
 * Throws on the first statement the replay cannot execute. That is deliberate:
 * a chain that will not replay is a chain whose expectation cannot be
 * established, and the caller must report UNVERIFIED rather than guess.
 */
export function readExpectedSchema(dbRoot = DB_ROOT): SchemaDescription {
	const manifest = readMigrationManifest(
		path.join(dbRoot, "migration-integrity.json"),
	);
	// `node:sqlite` rather than `bun:sqlite` so this module also loads under the
	// Node-based test runner; both hosts ship the same SQLite engine surface for
	// the DDL and PRAGMA reads used here.
	const database = new DatabaseSync(":memory:");
	try {
		// Migrations legitimately reference tables created later in the chain and
		// carry data backfills against an empty database; enforcement here would
		// reject statements production accepted.
		database.exec("PRAGMA foreign_keys = OFF");
		for (const migration of manifest.migrations) {
			const file = path.join(dbRoot, "drizzle", migration.name);
			const statements = splitMigrationStatements(readFileSync(file, "utf8"));
			for (const statement of statements) {
				try {
					database.exec(statement);
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					throw new Error(
						`Replay of ${migration.name} failed: ${reason}\nstatement: ${statement.slice(0, 400)}`,
					);
				}
			}
		}
		const objectRows = database
			.prepare(SCHEMA_OBJECT_SQL)
			.all() as unknown as SchemaObjectRow[];
		const columnRows = database
			.prepare(SCHEMA_COLUMN_SQL)
			.all() as unknown as SchemaColumnRow[];
		return buildSchemaDescription(objectRows, columnRows);
	} finally {
		database.close();
	}
}
