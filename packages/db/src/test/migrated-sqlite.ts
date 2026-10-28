/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { afterAll } from "vite-plus/test";
import {
	getMigratedSqliteTemplate,
	type MigratedSqliteTemplateOptions,
} from "./migrated-sqlite-template";

const copies: DatabaseSync[] = [];

afterAll(() => {
	for (const sqlite of copies.splice(0)) {
		if (sqlite.isOpen) sqlite.close();
	}
});

/** An independent, writable copy of the production migration ledger. */
export function createMigratedSqlite({
	transformMigration,
	beforeMigration,
	foreignKeys = true,
}: MigratedSqliteTemplateOptions = {}): DatabaseSync {
	const template = getMigratedSqliteTemplate({
		transformMigration,
		beforeMigration,
		foreignKeys,
	});

	const sqlite = new DatabaseSync(":memory:");
	sqlite.deserialize(template);
	sqlite.exec(`PRAGMA foreign_keys=${foreignKeys ? "ON" : "OFF"}`);
	copies.push(sqlite);
	return sqlite;
}
