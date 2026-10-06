import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
	checkMigrations as checkWithBaseline,
	findCascadeChildren,
} from "./check-migrations";

/** Fixture chains are judged in full, with no applied history. */
const checkMigrations = (directory: string) =>
	checkWithBaseline(directory, { appliedBaseline: null });

/** A parent with one ON DELETE CASCADE child and one ON DELETE SET NULL child. */
const EMAIL_TABLES_MIGRATION = [
	"CREATE TABLE `tedi_email_threads` (",
	"\t`id` text PRIMARY KEY,",
	"\t`subject` text",
	");--> statement-breakpoint",
	"CREATE TABLE `tedi_email_messages` (",
	"\t`id` text PRIMARY KEY,",
	"\t`thread_id` text NOT NULL,",
	"\tCONSTRAINT `fk_tedi_email_messages_thread_id_tedi_email_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `tedi_email_threads`(`id`) ON DELETE CASCADE",
	");--> statement-breakpoint",
	"CREATE TABLE `tedi_email_events` (",
	"\t`id` text PRIMARY KEY,",
	"\t`thread_id` text,",
	"\tCONSTRAINT `fk_tedi_email_events_thread_id_tedi_email_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `tedi_email_threads`(`id`) ON DELETE SET NULL",
	");",
].join("\n");

/**
 * A standard Drizzle table rebuild of the parent: the `PRAGMA foreign_keys=OFF`
 * header D1 ignores, then CREATE `__new_`, INSERT..SELECT, DROP, RENAME. It
 * carries a `destructive-reviewed` directive, which must not be enough.
 */
const PARENT_REBUILD = [
	"-- tedix: destructive-reviewed Work-Item: 00000000-0000-4000-8000-000000000000",
	"PRAGMA foreign_keys=OFF;--> statement-breakpoint",
	"CREATE TABLE `__new_tedi_email_threads` (",
	"\t`id` text PRIMARY KEY NOT NULL,",
	"\t`subject` text",
	");--> statement-breakpoint",
	"INSERT INTO `__new_tedi_email_threads`(`id`, `subject`) SELECT `id`, `subject` FROM `tedi_email_threads`;--> statement-breakpoint",
	"DROP TABLE `tedi_email_threads`;--> statement-breakpoint",
	"ALTER TABLE `__new_tedi_email_threads` RENAME TO `tedi_email_threads`;--> statement-breakpoint",
	"PRAGMA foreign_keys=ON;",
].join("\n");

const REVIEWED =
	"-- tedix: destructive-reviewed Work-Item: 00000000-0000-4000-8000-000000000000";

const directories: string[] = [];

function chain(...migrations: readonly (readonly [string, string])[]): string {
	const directory = mkdtempSync(path.join(tmpdir(), "tedix-cascade-gate-"));
	directories.push(directory);
	for (const [name, sql] of migrations) {
		mkdirSync(path.join(directory, name), { recursive: true });
		writeFileSync(path.join(directory, name, "migration.sql"), sql);
	}
	return directory;
}

function messageOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "";
}

describe("D1 cascade safety", () => {
	afterAll(() => {
		for (const directory of directories) {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects a parent rebuild and names the cascade path", () => {
		const message = messageOf(() =>
			checkMigrations(
				chain(
					["20260101000000_email_tables", EMAIL_TABLES_MIGRATION],
					["20260102000000_rebuild_threads", PARENT_REBUILD],
				),
			),
		);

		expect(message).toContain("20260102000000_rebuild_threads/migration.sql");
		// The blast radius, not just a refusal: child table, FK column, parent.
		expect(message).toContain(
			"tedi_email_messages.thread_id -> tedi_email_threads ON DELETE CASCADE",
		);
		expect(message).toContain("DROP TABLE `tedi_email_threads`");
		expect(message).toContain("every row of tedi_email_messages is deleted");
		// `destructive-reviewed` does not satisfy this gate; a per-table
		// acknowledgement is demanded instead.
		expect(message).toContain(
			"cascade-reviewed Work-Item: <uuid> Table: tedi_email_threads",
		);
	});

	it("ignores an ON DELETE SET NULL child", () => {
		const message = messageOf(() =>
			checkMigrations(
				chain(
					["20260101000000_email_tables", EMAIL_TABLES_MIGRATION],
					[
						"20260102000000_drop_threads",
						`${REVIEWED}\nDROP TABLE \`tedi_email_threads\`;`,
					],
				),
			),
		);
		expect(message).toContain("tedi_email_messages.thread_id");
		expect(message).not.toContain("tedi_email_events");
	});

	it("allows dropping a table nothing cascades from", () => {
		const directory = chain(
			[
				"20260101000000_standalone",
				"CREATE TABLE `retired_telemetry` (`id` text PRIMARY KEY);",
			],
			[
				"20260102000000_drop_standalone",
				`${REVIEWED}\nDROP TABLE \`retired_telemetry\`;`,
			],
		);
		expect(() => checkMigrations(directory)).not.toThrow();
	});

	it("accepts a per-table cascade-reviewed directive", () => {
		const directory = chain(
			["20260101000000_email_tables", EMAIL_TABLES_MIGRATION],
			[
				"20260102000000_drop_threads",
				[
					REVIEWED,
					"-- tedix: cascade-reviewed Work-Item: 00000000-0000-4000-8000-000000000000 Table: tedi_email_threads",
					"DROP TABLE `tedi_email_threads`;",
				].join("\n"),
			],
		);
		expect(() => checkMigrations(directory)).not.toThrow();
	});

	it("does not let a directive for one table cover a different table", () => {
		const directory = chain(
			["20260101000000_email_tables", EMAIL_TABLES_MIGRATION],
			[
				"20260102000000_drop_threads",
				[
					REVIEWED,
					"-- tedix: cascade-reviewed Work-Item: 00000000-0000-4000-8000-000000000000 Table: some_other_table",
					"DROP TABLE `tedi_email_threads`;",
				].join("\n"),
			],
		);
		expect(() => checkMigrations(directory)).toThrow(
			/tedi_email_messages\.thread_id/,
		);
	});

	it("rejects renaming a cascade parent, not only dropping it", () => {
		const directory = chain(
			["20260101000000_email_tables", EMAIL_TABLES_MIGRATION],
			[
				"20260102000000_rename_threads",
				`${REVIEWED}\nALTER TABLE \`tedi_email_threads\` RENAME TO \`tedi_email_conversations\`;`,
			],
		);
		expect(() => checkMigrations(directory)).toThrow(
			/table rename `tedi_email_threads` cascades into/,
		);
	});

	it("reports a table's cascade children from the replayed chain", () => {
		const database = new DatabaseSync(":memory:");
		try {
			for (const statement of EMAIL_TABLES_MIGRATION.split(
				"--> statement-breakpoint",
			)) {
				database.exec(statement);
			}
			expect(findCascadeChildren(database, "tedi_email_threads")).toEqual([
				{
					child: "tedi_email_messages",
					column: "thread_id",
					parent: "tedi_email_threads",
				},
			]);
			expect(findCascadeChildren(database, "tedi_email_messages")).toEqual([]);
		} finally {
			database.close();
		}
	});

	it("passes the real migration chain", () => {
		expect(() => checkWithBaseline()).not.toThrow();
	});
});

describe("foreign-key pragma rejection", () => {
	it("rejects a new migration carrying the pragma even with a review directive", () => {
		// A reviewer cannot approve a no-op into working.
		const directory = chain(
			["20260901000000_base", "CREATE TABLE `leaf` (`id` text PRIMARY KEY);"],
			[
				"20260901000001_rebuild",
				`${REVIEWED}\nPRAGMA foreign_keys=OFF;--> statement-breakpoint\nALTER TABLE \`leaf\` ADD \`note\` text;`,
			],
		);
		expect(messageOf(() => checkMigrations(directory))).toContain(
			"remove `PRAGMA foreign_keys=OFF`",
		);
	});

	it("accepts a migration that does not disable foreign keys", () => {
		const directory = chain([
			"20260901000000_additive",
			"CREATE TABLE `leaf` (`id` text PRIMARY KEY);",
		]);
		expect(() => checkMigrations(directory)).not.toThrow();
	});

	it("reports the cascade path first when a migration has both problems", () => {
		// The cascade path names the rows at risk, so it must not be masked by
		// the pragma complaint.
		const directory = chain(
			["20260901000000_base", EMAIL_TABLES_MIGRATION],
			["20260901000001_rebuild", PARENT_REBUILD],
		);
		expect(messageOf(() => checkMigrations(directory))).toContain(
			"tedi_email_messages.thread_id",
		);
	});
});
