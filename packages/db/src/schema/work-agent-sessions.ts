/**
 * Local agent session status board.
 *
 * One row per local coding-agent session (Claude Code, Codex) that a human
 * runs on their own machine. The Tedix plugin reports the session's state at
 * each turn boundary so the human can see which sessions need them. Rows are
 * private to the reporting user inside one organization; the board derives
 * `idle` from age when it is read, so nothing here is swept. A session bound to
 * a Work project is also listed among that project's contributors.
 */

import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

export const WORK_AGENT_SESSION_HARNESS_VALUES = [
	"claude-code",
	"codex",
] as const;
export type WorkAgentSessionHarness =
	(typeof WORK_AGENT_SESSION_HARNESS_VALUES)[number];

export const WORK_AGENT_SESSION_STATE_VALUES = [
	"needs_you",
	"error",
	"done",
	"working",
	"ended",
] as const;
export type WorkAgentSessionState =
	(typeof WORK_AGENT_SESSION_STATE_VALUES)[number];

export const workAgentSessions = sqliteTable(
	"work_agent_sessions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		/** Canonical Tedix user id of the human who runs the session. */
		userId: text("user_id").notNull(),
		harness: text("harness", {
			enum: WORK_AGENT_SESSION_HARNESS_VALUES,
		}).notNull(),
		/** The host's own session id, such as Claude Code `session_id`. */
		sessionKey: text("session_key").notNull(),
		label: text("label").notNull().default(""),
		/**
		 * Work project the session's checkout is bound to, if any. A plain column,
		 * not a foreign key: adding one would rebuild this existing table. The
		 * report handler accepts only a project of the session's organization.
		 */
		projectId: text("project_id"),
		/** Work Item the session has selected, if any (same rule). */
		workItemId: text("work_item_id"),
		state: text("state", { enum: WORK_AGENT_SESSION_STATE_VALUES }).notNull(),
		summary: text("summary").notNull().default(""),
		/** When the stored state last changed (ISO 8601). */
		stateSince: text("state_since").notNull(),
		/** When the plugin last reported anything for this session (ISO 8601). */
		lastEventAt: text("last_event_at").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_work_agent_sessions_org_user_harness_session").on(
			table.organizationId,
			table.userId,
			table.harness,
			table.sessionKey,
		),
		index("idx_work_agent_sessions_org_user_last_event").on(
			table.organizationId,
			table.userId,
			table.lastEventAt,
		),
		index("idx_work_agent_sessions_org_project").on(
			table.organizationId,
			table.projectId,
		),
	],
);

export type WorkAgentSessionRow = typeof workAgentSessions.$inferSelect;
export type NewWorkAgentSessionRow = typeof workAgentSessions.$inferInsert;
