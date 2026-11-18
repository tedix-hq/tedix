import type { GatewayChangeRecordBody } from "@tedix/api-contract/schemas/audit";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * One row per tool call through the MCP gateway, allowed or refused.
 * Append-only: rows are inserted and read, never updated or deleted.
 * `sequence` orders the ledger; readers always filter by organization.
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
	],
);
