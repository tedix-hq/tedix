import type { GatewayChangeRecordBody } from "@tedix/api-contract/schemas/audit";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * One row per MCP gateway tool call that changed something or was refused.
 * Append-only: rows are inserted and read, never updated. The daily
 * retention job deletes rows older than the retention window.
 * `sequence` orders the ledger; readers always filter by organization.
 * `recorded_at` is always `Date.prototype.toISOString()`, so text order is
 * time order and range reads use the indexes below.
 */
export const gatewayChangeRecords = sqliteTable(
	"gateway_change_records",
	{
		sequence: integer("sequence").primaryKey({ autoIncrement: true }),
		id: text("id").notNull(),
		organizationId: text("organization_id").notNull(),
		resource: text("resource").notNull(),
		actorId: text("actor_id").notNull(),
		recordedAt: text("recorded_at").notNull(),
		record: text("record", { mode: "json" })
			.$type<GatewayChangeRecordBody>()
			.notNull(),
	},
	(t) => [
		uniqueIndex("idx_gateway_change_records_id").on(t.id),
		index("idx_gateway_change_records_org_sequence").on(
			t.organizationId,
			t.sequence,
		),
		// Time-range reads of one organization.
		index("idx_gateway_change_records_org_recorded_at").on(
			t.organizationId,
			t.recordedAt,
		),
		// Retention deletes the oldest rows across all organizations.
		index("idx_gateway_change_records_recorded_at").on(t.recordedAt),
	],
);
