import {
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

/** Pseudonymous protocol continuity only; never account authorization or JWTs. */
export const personalAgentSessions = sqliteTable(
	"personal_agent_sessions",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		clientId: text("client_id").notNull(),
		sessionId: text("session_id").notNull(),
		userId: text("user_id").notNull(),
		agentId: text("agent_id"),
		version: text("version").notNull(),
		createdAt: integer("created_at").notNull(),
		endedAt: integer("ended_at"),
	},
	(t) => [
		primaryKey({
			columns: [t.organizationId, t.clientId, t.sessionId, t.userId],
		}),
	],
);

/** One fixed-window counter per client and organization, not per sid. */
export const personalAgentClientRates = sqliteTable(
	"personal_agent_client_rates",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		clientId: text("client_id").notNull(),
		windowStart: integer("window_start").notNull(),
		requests: integer("requests").notNull(),
	},
	(t) => [primaryKey({ columns: [t.organizationId, t.clientId] })],
);
