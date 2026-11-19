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
 * One row per MCP gateway tool call that changed something or was refused.
 * Append-only: rows are inserted and read. The one update is sealing: the
 * sealer job fills `record_digest` and `chain_hash` once, in sequence order
 * (null = not sealed yet). The daily retention job deletes old rows only when
 * a checkpoint covers them.
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

/**
 * One signed (or, without a signing key, unsigned) checkpoint per sealed run
 * of an organization's records. Never deleted, also not by retention: it
 * keeps `previous_chain_hash`, so the records after a deleted run can still
 * be verified. `envelope` is the DSSE envelope JSON, null when unsigned.
 */
export const gatewayChangeRecordCheckpoints = sqliteTable(
	"gateway_change_record_checkpoints",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		firstSequence: integer("first_sequence").notNull(),
		lastSequence: integer("last_sequence").notNull(),
		recordCount: integer("record_count").notNull(),
		headChainHash: text("head_chain_hash").notNull(),
		previousCheckpointDigest: text("previous_checkpoint_digest"),
		/** Chain hash of the record before `first_sequence`; null at genesis. */
		previousChainHash: text("previous_chain_hash"),
		/** Payload digest; the next checkpoint's `previous_checkpoint_digest`. */
		checkpointDigest: text("checkpoint_digest").notNull(),
		sealedAt: text("sealed_at").notNull(),
		envelope: text("envelope"),
		keyId: text("key_id"),
	},
	(t) => [
		index("idx_gateway_change_record_checkpoints_org_last_sequence").on(
			t.organizationId,
			t.lastSequence,
		),
		// Two sealer runs that start from the same checkpoint collide here, so
		// the later batch fails as a whole and the chain cannot fork.
		uniqueIndex("idx_gateway_change_record_checkpoints_org_first_sequence").on(
			t.organizationId,
			t.firstSequence,
		),
	],
);
