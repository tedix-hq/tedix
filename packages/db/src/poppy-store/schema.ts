/**
 * Poppy (signed-out Company Agent) conversation protocol state, stored in the
 * tedi runtime Durable Object's own SQLite next to its other tables. Generate
 * migrations with `bun run db:poppy-store:generate -- --name <change>`.
 */
import {
	index,
	integer,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";

/** One conversation's state as JSON. */
export const poppyConversations = sqliteTable("poppy_conversations", {
	id: text("id").primaryKey(),
	value: text("value").notNull(),
});

/** Accepted client requests; `pending` 1 waits for the agent, 2 for a person. */
export const poppyRequests = sqliteTable(
	"poppy_requests",
	{
		sequence: integer("sequence").primaryKey({ autoIncrement: true }),
		owner: text("owner").notNull(),
		id: text("id").notNull(),
		conversation: text("conversation").notNull(),
		path: text("path").notNull(),
		body: text("body").notNull(),
		status: integer("status").notNull(),
		pending: integer("pending").notNull(),
		context: text("context").notNull(),
		throughSequence: integer("through_sequence").notNull(),
		acceptedAt: integer("accepted_at").notNull(),
	},
	(table) => [
		unique().on(table.owner, table.id),
		index("poppy_pending").on(table.pending, table.sequence),
	],
);

/** Each conversation's event log, as JSON, in sequence order. */
export const poppyEvents = sqliteTable(
	"poppy_events",
	{
		sequence: integer("sequence").primaryKey({ autoIncrement: true }),
		conversation: text("conversation").notNull(),
		id: text("id").notNull().unique(),
		value: text("value").notNull(),
	},
	(table) => [
		index("poppy_events_conversation").on(table.conversation, table.sequence),
	],
);

/** Human handoff desks; a desk covers requests up to `through_sequence`. */
export const poppyDesks = sqliteTable("poppy_desks", {
	id: text("id").primaryKey(),
	conversation: text("conversation").notNull(),
	root: text("root").notNull(),
	pending: integer("pending").notNull(),
	throughSequence: integer("through_sequence").notNull(),
});
