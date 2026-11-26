/**
 * Read Marks — the daily "last read" date for rows that are only ever read.
 *
 * Running a skill writes `skill_usage_events` and bumps `lastUsedAt`, but
 * reading one (a `skills.get`, a tedi prompt injection, a lesson delivery, a
 * policy-pack or Output fetch) leaves no trace — so cleanup tools and the
 * automatic judges treated rows read every day as unused (the 20 Nov 2026
 * "Lane rules" incident; see the looks-unused audit). This table records, at
 * most once per row per UTC day, the last date each row was read. It is a
 * deliberately cheap store: one guarded upsert per row per day, gated by an
 * in-isolate cache so repeat reads cost no write at all.
 *
 * `kind` names the row family: `skill`, `output`, `policy_pack`, `lesson`.
 * `row_id` is the row's primary key in its own table (a memory-fact id for
 * lessons). `last_read_on` is a UTC calendar date (`YYYY-MM-DD`), not a
 * timestamp — daily granularity is the contract; judges compare it against
 * their own windows.
 *
 * Consumer: packages/db/src/queries/read-marks.ts.
 */

import { sql } from "drizzle-orm";
import { check, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

export const READ_MARK_KINDS = [
	"skill",
	"output",
	"policy_pack",
	"lesson",
] as const;
export type ReadMarkKind = (typeof READ_MARK_KINDS)[number];

export const readMarks = sqliteTable(
	"read_marks",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: READ_MARK_KINDS }).notNull(),
		/** Primary key of the read row in its own table. */
		rowId: text("row_id").notNull(),
		/** UTC calendar date (`YYYY-MM-DD`) of the most recent recorded read. */
		lastReadOn: text("last_read_on").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.organizationId, table.kind, table.rowId],
		}),
		check(
			"chk_read_marks_strings",
			sql`length(${table.rowId}) BETWEEN 1 AND 128
				AND length(${table.lastReadOn}) = 10
				AND length(${table.updatedAt}) BETWEEN 1 AND 64`,
		),
	],
);

export type ReadMarkRow = typeof readMarks.$inferSelect;
export type NewReadMarkRow = typeof readMarks.$inferInsert;
