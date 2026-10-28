/// <reference types="node" />
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export interface MigratedSqliteTemplateOptions {
	/** Applied in ledger order, before each migration is executed. */
	transformMigration?: (sql: string, name: string) => string;
	/** Historical migration tests seed rows before applying this migration. */
	beforeMigration?: string;
	foreignKeys?: boolean;
}

const migrationRoot = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../drizzle",
);
const migrations = readdirSync(migrationRoot)
	.filter((name) => /^\d{14}_/.test(name))
	.sort()
	.map((name) => ({
		name,
		sql: readFileSync(join(migrationRoot, name, "migration.sql"), "utf8"),
	}));
// Vitest isolates files in separate processes, so the exact ledger key must
// bridge workers without sharing a mutable database.
const cacheRoot = join(tmpdir(), "tedix-db-migrated-sqlite-v1");
const memoryTemplates = new Map<string, Uint8Array>();

export function getMigratedSqliteTemplate({
	transformMigration,
	beforeMigration,
	foreignKeys = true,
}: MigratedSqliteTemplateOptions = {}): Uint8Array {
	const statements = migrations
		.filter(({ name }) => !beforeMigration || name < beforeMigration)
		.map(({ name, sql }) => ({
			name,
			sql: transformMigration?.(sql, name) ?? sql,
		}));
	const key = createHash("sha256")
		.update(
			JSON.stringify([
				process.versions.node,
				process.versions.sqlite,
				foreignKeys,
				statements,
			]),
		)
		.digest("hex");
	const memoryTemplate = memoryTemplates.get(key);
	if (memoryTemplate) return memoryTemplate;

	mkdirSync(cacheRoot, { recursive: true });
	const cachePath = join(cacheRoot, `${key}.sqlite`);
	if (existsSync(cachePath)) {
		const template = readFileSync(cachePath);
		memoryTemplates.set(key, template);
		return template;
	}

	const sqlite = new DatabaseSync(":memory:");
	let template: Uint8Array;
	try {
		sqlite.exec(`PRAGMA foreign_keys=${foreignKeys ? "ON" : "OFF"}`);
		for (const { sql } of statements) sqlite.exec(sql);
		template = sqlite.serialize();
	} finally {
		sqlite.close();
	}

	const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, template);
		renameSync(temporaryPath, cachePath);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
	memoryTemplates.set(key, template);
	return template;
}
