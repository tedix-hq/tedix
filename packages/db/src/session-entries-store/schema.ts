/**
 * The tedi session repo's append-only recent-turn and compaction log
 * (packages/tedi-session `TediSessionRepo`), in the tedi runtime Durable
 * Object's SQLite. Generate migrations with
 * `bun run db:session-entries-store:generate -- --name <change>`.
 */
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const sessionEntries = sqliteTable(
	"session_entries",
	{
		id: text("id").primaryKey(),
		sessionKey: text("session_key").notNull(),
		parentId: text("parent_id"),
		type: text("type").notNull().default("message"),
		role: text("role").notNull(),
		content: text("content").notNull(),
		/** Ledger-derived `{runId}:{seq}` key; only keyed appends are unique. */
		idempotencyKey: text("idempotency_key"),
		/** Epoch milliseconds. */
		ts: integer("ts").notNull(),
		firstKeptEntryId: text("first_kept_entry_id"),
		tokensBefore: integer("tokens_before"),
		modelProvider: text("model_provider"),
		modelId: text("model_id"),
	},
	(table) => [
		index("idx_session_entries_key_ts").on(table.sessionKey, table.ts),
		uniqueIndex("uq_session_entries_key_idem")
			.on(table.sessionKey, table.idempotencyKey)
			.where(sql`${table.idempotencyKey} IS NOT NULL`),
	],
);
