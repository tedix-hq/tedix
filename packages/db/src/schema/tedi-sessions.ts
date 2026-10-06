import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { tedis } from "./tedis";

export const tediSessionStates = sqliteTable(
	"tedi_session_states",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		userId: text("user_id").notNull(),
		sessionKey: text("session_key").notNull(),
		title: text("title"),
		pinnedAt: text("pinned_at"),
		deletedAt: text("deleted_at"),
		lastSeenAt: integer("last_seen_at"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		unique("tedi_session_states_scope_unique").on(
			table.organizationId,
			table.tediId,
			table.userId,
			table.sessionKey,
		),
		index("idx_tedi_session_states_pinned").on(
			table.tediId,
			table.userId,
			table.pinnedAt,
		),
		index("idx_tedi_session_states_deleted").on(
			table.tediId,
			table.userId,
			table.deletedAt,
		),
	],
);

export type TediSessionState = typeof tediSessionStates.$inferSelect;
export type NewTediSessionState = typeof tediSessionStates.$inferInsert;
