import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * SEP-3415 `events/subscribe` webhook subscriptions for the ledger-backed MCP
 * events (`work.item.state_changed`, `work.approval.requested`,
 * `skill.run.failed`). One row is one caller's lease on one event filter and
 * callback in one organization. The MCP edge seals the caller's bearer and
 * the callback secret before they reach this row; the API never reads them.
 * `cursor` is the event feed position already delivered (at-least-once:
 * it advances only after the callback acknowledged a whole page).
 */
export const mcpEventSubscriptions = sqliteTable(
	"mcp_event_subscriptions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		ownerSubject: text("owner_subject").notNull(),
		mcpUrl: text("mcp_url").notNull(),
		eventName: text("event_name").notNull(),
		arguments: text("arguments", { mode: "json" })
			.$type<Record<string, string>>()
			.notNull(),
		callbackUrl: text("callback_url").notNull(),
		sealedCredential: text("sealed_credential").notNull(),
		cursor: text("cursor").notNull(),
		status: text("status", { enum: ["active", "unhealthy"] })
			.notNull()
			.default("active"),
		consecutiveFailures: integer("consecutive_failures").notNull().default(0),
		/** Next delivery attempt; a claim moves it forward as a short lease. */
		nextAttemptAt: text("next_attempt_at").notNull(),
		rateWindowStartedAt: text("rate_window_started_at"),
		rateWindowCount: integer("rate_window_count").notNull().default(0),
		lastDeliveredAt: text("last_delivered_at"),
		lastStatus: integer("last_status"),
		expiresAt: text("expires_at").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_mcp_event_subscriptions_due").on(
			table.status,
			table.nextAttemptAt,
		),
		index("idx_mcp_event_subscriptions_org_owner").on(
			table.organizationId,
			table.ownerSubject,
		),
	],
);

export type McpEventSubscriptionRow = typeof mcpEventSubscriptions.$inferSelect;
export type NewMcpEventSubscriptionRow =
	typeof mcpEventSubscriptions.$inferInsert;
