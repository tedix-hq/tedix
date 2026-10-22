import { sql } from "drizzle-orm";
import {
	integer,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

/**
 * Daily call-cost rollup: one row per organization, closed UTC day and the
 * attribution grain that organization usage reports group by. Built from the
 * effective call-cost relation (reviewed provider estimates and retained
 * snapshots included), so a rollup row folds exactly the raw rows it replaces.
 *
 * Raw columns are stored unnormalized; readers apply the same normalization as
 * they do to raw rows. Triggers in the migration mark a day `stale` when a raw
 * row or provider cost evidence for it changes; readers never use stale rows.
 */
export const billingCostRollups = sqliteTable(
	"billing_cost_rollups",
	{
		id: integer("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		/** UTC calendar day, `YYYY-MM-DD`; always before the day it was built. */
		day: text("day").notNull(),
		tediId: text("tedi_id"),
		sessionType: text("session_type").notNull(),
		source: text("source").notNull(),
		model: text("model").notNull(),
		provider: text("provider"),
		providerResource: text("provider_resource"),
		providerBaseUrl: text("provider_base_url"),
		deployment: text("deployment"),
		costBasis: text("cost_basis").notNull(),
		success: integer("success", { mode: "boolean" }).notNull(),

		inputTokens: integer("input_tokens").notNull(),
		outputTokens: integer("output_tokens").notNull(),
		cacheReadTokens: integer("cache_read_tokens").notNull(),
		cacheWriteTokens: integer("cache_write_tokens").notNull(),
		totalTokens: integer("total_tokens").notNull(),
		/** Sum of effective attested cost over priced calls (unpriced count as 0). */
		estimatedCostUsd: real("estimated_cost_usd").notNull(),
		callCount: integer("call_count").notNull(),
		pricedCallCount: integer("priced_call_count").notNull(),
		unpricedTokens: integer("unpriced_tokens").notNull(),
		reviewedCallCount: integer("reviewed_call_count").notNull(),
		reviewedTokens: integer("reviewed_tokens").notNull(),
		reviewedCostMicros: integer("reviewed_cost_micros").notNull(),
		retiredCallCount: integer("retired_call_count").notNull(),
		/** Newest call in the grain, in ledger order (snapshot, then id). */
		latestSnapshotAt: text("latest_snapshot_at").notNull(),
		latestCallId: text("latest_call_id").notNull(),

		stale: integer("stale", { mode: "boolean" }).notNull().default(false),
		computedAt: text("computed_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		// Leads with (organization, day), so it also serves day-range reads.
		uniqueIndex("idx_billing_cost_rollups_grain").on(
			table.organizationId,
			table.day,
			table.tediId,
			table.sessionType,
			table.source,
			table.model,
			table.provider,
			table.providerResource,
			table.providerBaseUrl,
			table.deployment,
			table.costBasis,
			table.success,
		),
	],
);

export type BillingCostRollupRow = typeof billingCostRollups.$inferSelect;
export type NewBillingCostRollupRow = typeof billingCostRollups.$inferInsert;
