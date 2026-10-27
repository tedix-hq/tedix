/**
 * Request ledger for local agent sessions.
 *
 * One row per distinct request, question or decision a person sent to their
 * own Claude Code or Codex session, extracted from the message by a small
 * observer model, then moved by a reflector model as the agent's turns answer
 * it. Agent turns also supply asks, promises and open loops. An open row is shown to the
 * agent before every prompt and to the person in Tedix OS. Rows are private to
 * the person inside one organization, and are linked to the Agent-Session by
 * (harness, session key), the same identity as `work_agent_sessions`.
 */

import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { WORK_AGENT_SESSION_HARNESS_VALUES } from "./work-agent-sessions";

export const AGENT_SESSION_REQUEST_KIND_VALUES = [
	"request",
	"question",
	"decision",
	"idea",
	"issue",
	"ask",
	"promise",
	"open_loop",
] as const;
export type AgentSessionRequestKind =
	(typeof AGENT_SESSION_REQUEST_KIND_VALUES)[number];

export const AGENT_SESSION_REQUEST_STATUS_VALUES = [
	"open",
	"in_progress",
	"waiting_on_user",
	"dropped_risk",
	"done",
	"cancelled",
] as const;
export type AgentSessionRequestStatus =
	(typeof AGENT_SESSION_REQUEST_STATUS_VALUES)[number];

export const agentSessionRequests = sqliteTable(
	"agent_session_requests",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		/** Canonical Tedix user id of the person who sent the message. */
		userId: text("user_id").notNull(),
		harness: text("harness", {
			enum: WORK_AGENT_SESSION_HARNESS_VALUES,
		}).notNull(),
		/** The host's own session id, such as Claude Code `session_id`. */
		sessionKey: text("session_key").notNull(),
		/** Repository name or working folder label, when known. */
		repository: text("repository"),
		projectId: text("project_id"),
		kind: text("kind", { enum: AGENT_SESSION_REQUEST_KIND_VALUES }).notNull(),
		/** The request in plain words. */
		text: text("text").notNull(),
		status: text("status", {
			enum: AGENT_SESSION_REQUEST_STATUS_VALUES,
		}).notNull(),
		/** Commit SHA, link or quote that proves the latest status. */
		evidence: text("evidence"),
		/** Agent turns that ended without touching this open row. */
		turnsUnaddressed: integer("turns_unaddressed").notNull().default(0),
		/** A running lane for this request prevents silence-based risk. */
		laneRunning: integer("lane_running", { mode: "boolean" })
			.notNull()
			.default(false),
		/** Source event already accounted for in the silence counter. */
		lastReflectedAt: text("last_reflected_at"),
		/** When the person sent the message (ISO 8601). */
		sourceAt: text("source_at").notNull(),
		/** Idempotency key: one message's nth request is recorded once. */
		sourceKey: text("source_key").notNull(),
		statusChangedAt: text("status_changed_at").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_agent_session_requests_org_user_source").on(
			table.organizationId,
			table.userId,
			table.sourceKey,
		),
		index("idx_agent_session_requests_org_user_status").on(
			table.organizationId,
			table.userId,
			table.status,
			table.sourceAt,
		),
		index("idx_agent_session_requests_org_user_session").on(
			table.organizationId,
			table.userId,
			table.harness,
			table.sessionKey,
		),
	],
);

export type AgentSessionRequestRow = typeof agentSessionRequests.$inferSelect;
export type NewAgentSessionRequestRow =
	typeof agentSessionRequests.$inferInsert;

export const AGENT_SESSION_EVENT_KIND_VALUES = ["prompt", "turn"] as const;
export type AgentSessionEventKind =
	(typeof AGENT_SESSION_EVENT_KIND_VALUES)[number];

export const AGENT_SESSION_EVENT_STATUS_VALUES = [
	"pending",
	"processed",
	"failed",
] as const;
export type AgentSessionEventStatus =
	(typeof AGENT_SESSION_EVENT_STATUS_VALUES)[number];

/**
 * Redacted session events the plugin hooks upload: each typed message
 * (`prompt`) and each agent turn end (`turn`, with a digest of its tool
 * failures and delegated lanes). The upload only stores the event; the
 * observer and reflector process pending events in the background, in
 * session order, and write the ledger above. Private to the person.
 */
export const agentSessionEvents = sqliteTable(
	"agent_session_events",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		userId: text("user_id").notNull(),
		harness: text("harness", {
			enum: WORK_AGENT_SESSION_HARNESS_VALUES,
		}).notNull(),
		sessionKey: text("session_key").notNull(),
		repository: text("repository"),
		kind: text("kind", { enum: AGENT_SESSION_EVENT_KIND_VALUES }).notNull(),
		/** The redacted message or turn text. */
		body: text("body").notNull(),
		/** Redacted activity digest of a turn, if any. */
		activity: text("activity"),
		sourceAt: text("source_at").notNull(),
		/** Idempotency key: a re-uploaded event is stored once. */
		sourceKey: text("source_key").notNull(),
		status: text("status", {
			enum: AGENT_SESSION_EVENT_STATUS_VALUES,
		}).notNull(),
		attempts: integer("attempts").notNull().default(0),
		/** Processing lease start; a stale lease may be taken over. */
		claimedAt: text("claimed_at"),
		processedAt: text("processed_at"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_agent_session_events_org_user_source").on(
			table.organizationId,
			table.userId,
			table.sourceKey,
		),
		index("idx_agent_session_events_org_user_status").on(
			table.organizationId,
			table.userId,
			table.status,
			table.sourceAt,
		),
		index("idx_agent_session_events_org_user_source_at").on(
			table.organizationId,
			table.userId,
			table.sourceAt,
			table.id,
		),
	],
);

export type AgentSessionEventRow = typeof agentSessionEvents.$inferSelect;
