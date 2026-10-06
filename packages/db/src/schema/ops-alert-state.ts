/**
 * Ops Alert State — the platform-health digest's notification memory.
 *
 * Distinct from the cron-darkness work-item dedup (`sourceIntentId`, which
 * answers "is there a board card"); this answers "have we already PAGED a human
 * about this exact condition." One row per condition keyed by a deterministic
 * `conditionKey`, so the daily health digest emails NEW / ESCALATED / RESOLVED
 * transitions instead of re-sending an unchanged open condition every day — the
 * single mechanism that keeps an alert digest trustworthy over months. State
 * lives in D1 (not a cron DO's memory) so it survives daily runs and restarts.
 *
 * Consumer: apps/api/src/lib/health-digest.ts.
 */

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const OPS_ALERT_STATUS_VALUES = ["open", "resolved"] as const;
export type OpsAlertStatus = (typeof OPS_ALERT_STATUS_VALUES)[number];

export const opsAlertState = sqliteTable(
	"ops_alert_state",
	{
		/**
		 * Deterministic condition identity — e.g. `cost-ledger-dark`,
		 * `cron-dark:{tediId}:{cronName}`. One row per condition.
		 */
		conditionKey: text("condition_key").primaryKey(),
		/** Triage severity: P1 (pipeline/spend dark) | P2 (single dark cron). */
		severity: text("severity").notNull(),
		/**
		 * Escalation rank stored as text — the digest re-pages an already-open
		 * condition only when this rises to a materially worse bucket, never on
		 * every raw metric wobble.
		 */
		metricBucket: text("metric_bucket").notNull().default("0"),
		/** Human one-line describing the current condition (for the email body). */
		detail: text("detail").notNull().default(""),
		/** `open` while firing; `resolved` once it clears. */
		status: text("status", { enum: OPS_ALERT_STATUS_VALUES })
			.notNull()
			.default("open"),
		/** When this condition first started firing (ISO 8601). */
		firstSeenAt: text("first_seen_at").notNull(),
		/** Most recent run that observed it firing (ISO 8601). */
		lastSeenAt: text("last_seen_at").notNull(),
		/** Last run that emailed about it (ISO 8601); null if never notified. */
		lastNotifiedAt: text("last_notified_at"),
		/** How many times a human has been paged about this condition. */
		notifyCount: integer("notify_count").notNull().default(0),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [index("idx_ops_alert_state_status").on(table.status)],
);

export type OpsAlertStateRow = typeof opsAlertState.$inferSelect;
export type NewOpsAlertStateRow = typeof opsAlertState.$inferInsert;
