/**
 * Tables of one organization's wallet Durable Object SQLite database
 * (`wallet:v1:<org>` in apps/mcp). Generate migrations with
 * `bun run db:wallet-store:generate -- --name <change>`.
 */
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** One Code Mode run charge or one model-call hold, until 48 h after its flush. */
export const walletEvents = sqliteTable(
	"wallet_events",
	{
		eventId: text("event_id").primaryKey(),
		tediId: text("tedi_id"),
		userId: text("user_id"),
		credits: integer("credits").notNull(),
		microUsdPerEur: integer("micro_usd_per_eur").notNull(),
		anonymousLoads: integer("anonymous_loads").notNull().default(0),
		namedLoads: integer("named_loads").notNull().default(0),
		settled: integer("settled", { mode: "boolean" }).notNull().default(false),
		periodStart: text("period_start").notNull(),
		periodEnd: text("period_end").notNull(),
		/** Epoch milliseconds. */
		at: integer("at").notNull(),
		flushId: text("flush_id"),
		flushedAt: integer("flushed_at"),
		kind: text("kind", { enum: ["code_run", "ai"] })
			.notNull()
			.default("code_run"),
		/** A model-call hold stops counting at this epoch millisecond unless settled. */
		expiresAt: integer("expires_at"),
		holdContext: text("hold_context", { mode: "json" }).$type<{
			runId: string | null;
			metadata: Record<string, unknown>;
		}>(),
		idempotencyKey: text("idempotency_key"),
	},
	(table) => [
		index("wallet_events_pending").on(table.flushedAt, table.at),
		uniqueIndex("wallet_events_idempotency").on(table.idempotencyKey),
	],
);

/** Which credit budgets each charge counts against. */
export const walletEventBudgets = sqliteTable(
	"wallet_event_budgets",
	{
		eventId: text("event_id").notNull(),
		budgetId: text("budget_id").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.eventId, table.budgetId] }),
		index("wallet_event_budgets_budget").on(table.budgetId),
	],
);

/** What each budget has spent once flushed; outlives the 48 h events. */
export const walletBudgetSpend = sqliteTable("wallet_budget_spend", {
	budgetId: text("budget_id").primaryKey(),
	microCredits: integer("micro_credits").notNull(),
});

/** 80% and 100% crossings waiting for the alarm to tell owners, once per budget, limit and percent. */
export const walletBudgetAlerts = sqliteTable(
	"wallet_budget_alerts",
	{
		budgetId: text("budget_id").notNull(),
		limitMicros: integer("limit_micros").notNull(),
		percent: integer("percent").notNull().$type<80 | 100>(),
		spentMicros: integer("spent_micros").notNull(),
		workItemId: text("work_item_id"),
		at: integer("at").notNull(),
		deliveredAt: integer("delivered_at"),
	},
	(table) => [
		primaryKey({
			columns: [table.budgetId, table.limitMicros, table.percent],
		}),
	],
);
