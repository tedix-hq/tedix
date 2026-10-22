/// <reference types="node" />
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { afterAll } from "vite-plus/test";

interface MigratedSqliteOptions {
	/** Applied in ledger order, before each migration is executed. */
	transformMigration?: (sql: string, name: string) => string;
	/** Historical migration tests seed rows before applying this migration. */
	beforeMigration?: string;
	foreignKeys?: boolean;
}

// Keep templates across module isolation when Vitest reuses a worker.
const worker = process as typeof process & {
	__tedixMigratedSqlite?: Map<string, Uint8Array>;
};
const templates = (worker.__tedixMigratedSqlite ??= new Map());
const copies: DatabaseSync[] = [];
let directory: string | undefined;
const migrationRoot = new URL("../../drizzle/", import.meta.url);
const migrations = readdirSync(migrationRoot)
	.filter((name) => /^\d{14}_/.test(name))
	.sort()
	.map((name) => ({
		name,
		sql: readFileSync(new URL(`${name}/migration.sql`, migrationRoot), "utf8"),
	}));

afterAll(() => {
	for (const sqlite of copies.splice(0)) {
		if (sqlite.isOpen) sqlite.close();
	}
	if (directory) rmSync(directory, { recursive: true, force: true });
});

/** An independent, writable copy of the production migration ledger. */
export function createMigratedSqlite({
	transformMigration,
	beforeMigration,
	foreignKeys = true,
}: MigratedSqliteOptions = {}): DatabaseSync {
	directory ??= mkdtempSync(join(tmpdir(), "tedix-migrated-sqlite-"));

	const statements = migrations
		.filter(({ name }) => !beforeMigration || name < beforeMigration)
		.map(({ name, sql }) => transformMigration?.(sql, name) ?? sql);
	// Key by SQL rather than callback identity so equivalent transforms in
	// isolated test modules share a template and different transforms cannot.
	const key = createHash("sha256")
		.update(JSON.stringify([foreignKeys, statements]))
		.digest("hex");
	let template = templates.get(key);
	if (!template) {
		const path = join(directory, "template.sqlite");
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec(`PRAGMA foreign_keys=${foreignKeys ? "ON" : "OFF"}`);
			for (const sql of statements) sqlite.exec(sql);
			sqlite.prepare("VACUUM INTO ?").run(path);
			template = readFileSync(path);
		} finally {
			sqlite.close();
			rmSync(path, { force: true });
		}
		templates.set(key, template);
	}

	const path = join(directory, `copy-${copies.length}.sqlite`);
	writeFileSync(path, template);
	const sqlite = new DatabaseSync(path);
	sqlite.exec(`PRAGMA foreign_keys=${foreignKeys ? "ON" : "OFF"}`);
	copies.push(sqlite);
	return sqlite;
}
