import type { GatewayChangeRecordBody } from "@tedix/api-contract/schemas/audit";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * The `LOGS_DB` copy of the gateway change ledger table (logs migration 0017).
 * It is not part of the main database: each organization's change records
 * live in its log store (`docs/engineering/organization-log-store.md`), and
 * the main tables were dropped on 21 Nov 2026. Kept so the logs databases'
 * checked-in DDL stays in step (`scripts/logs-db-schema.test.ts`) and history
 * export can read any rows they hold.
 * `sequence` orders the ledger; readers always filter by organization.
 * `recorded_at` is always `Date.prototype.toISOString()`.
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
		/** `recordDigest` from `@tedix/agent-governance/seal`; null until sealed. */
		recordDigest: text("record_digest"),
		/** `chainHash` from `@tedix/agent-governance/seal`; null until sealed. */
		chainHash: text("chain_hash"),
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
		// The sealer's work queue: only rows not sealed yet are indexed.
		index("idx_gateway_change_records_unsealed")
			.on(t.organizationId, t.sequence)
			.where(sql`chain_hash is null`),
		// The sealer's last-sealed guard: only sealed rows, so the check does
		// not walk the unsealed backlog for every row it seals.
		index("idx_gateway_change_records_sealed")
			.on(t.organizationId, t.sequence)
			.where(sql`chain_hash is not null`),
	],
);
