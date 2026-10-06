/**
 * Durable D1 -> Neo4j projection control plane.
 *
 * D1 is canonical. Migration-owned triggers append an outbox row in the same
 * SQLite transaction as each canonical mutation. Consumers hydrate the latest
 * canonical row for upserts; `payload` is only a tombstone hint for deletes.
 *
 * These tables deliberately do not foreign-key `organization_id`: deletion
 * events must survive long enough to remove an organization's graph projection.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const GRAPH_PROJECTION_ENTITY_KINDS = [
	"fact",
	"edge",
	"domain",
	"tedi",
	"decision",
	"knowledge_entry",
	"skill",
	"tedi_expertise",
	"capability",
	"capability_link",
	"entity",
	"entity_resolution",
	"project",
	"work_item",
	"work_item_source",
] as const;
export type GraphProjectionEntityKind =
	(typeof GRAPH_PROJECTION_ENTITY_KINDS)[number];

export const GRAPH_PROJECTION_OPERATIONS = ["upsert", "delete"] as const;
export type GraphProjectionOperation =
	(typeof GRAPH_PROJECTION_OPERATIONS)[number];

export const GRAPH_PROJECTION_READINESS_STATES = [
	"disabled",
	"catching_up",
	"ready",
	"degraded",
] as const;
export type GraphProjectionReadinessState =
	(typeof GRAPH_PROJECTION_READINESS_STATES)[number];

export const GRAPH_PROJECTION_REPAIR_PHASES = [
	"domains",
	"facts",
	"edges",
	"tedis",
	"decisions",
	"decision_predecessors",
	"knowledge_entries",
	"skills",
	"tedi_expertise",
	"capabilities",
	"capability_links",
	"entities",
	"entity_resolutions",
	// Work graph last: Project before WorkItem before WorkItemSource, so each
	// phase's MERGE targets already exist rather than creating bare stubs.
	"projects",
	"work_items",
	"work_item_sources",
	"sweep",
	"complete",
] as const;
export type GraphProjectionRepairPhase =
	(typeof GRAPH_PROJECTION_REPAIR_PHASES)[number];

export const graphProjectionOutbox = sqliteTable(
	"graph_projection_outbox",
	{
		sequence: integer("sequence").primaryKey({ autoIncrement: true }),
		eventId: text("event_id").notNull().unique(),
		organizationId: text("organization_id").notNull(),
		entityKind: text("entity_kind", {
			enum: GRAPH_PROJECTION_ENTITY_KINDS,
		}).notNull(),
		entityId: text("entity_id").notNull(),
		operation: text("operation", {
			enum: GRAPH_PROJECTION_OPERATIONS,
		}).notNull(),
		payload: text("payload", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		schemaVersion: integer("schema_version").notNull().default(1),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAt: text("next_attempt_at"),
		lastError: text("last_error"),
		poisonedAt: text("poisoned_at"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_graph_projection_outbox_org_sequence").on(
			table.organizationId,
			table.sequence,
		),
		index("idx_graph_projection_outbox_entity").on(
			table.organizationId,
			table.entityKind,
			table.entityId,
			table.sequence,
		),
		index("idx_graph_projection_outbox_retry").on(
			table.poisonedAt,
			table.nextAttemptAt,
			table.sequence,
		),
	],
);

export type GraphProjectionOutboxEvent =
	typeof graphProjectionOutbox.$inferSelect;

/**
 * One strictly ordered consumer per organization. A failed/poisoned head event
 * blocks cursor advancement so later mutations can never be acknowledged past
 * an unapplied predecessor.
 */
export const graphProjectionConsumers = sqliteTable(
	"graph_projection_consumers",
	{
		organizationId: text("organization_id").primaryKey(),
		lastProjectedSequence: integer("last_projected_sequence")
			.notNull()
			.default(0),
		leaseToken: text("lease_token"),
		leaseUntil: text("lease_until"),
		lastSuccessAt: text("last_success_at"),
		lastError: text("last_error"),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_graph_projection_consumers_lease").on(table.leaseUntil),
	],
);

export type GraphProjectionConsumer =
	typeof graphProjectionConsumers.$inferSelect;

/**
 * Product graph reads are enabled only when this D1-owned certification row is
 * `ready`. Neo4j transport reachability alone never implies readiness.
 */
export const graphProjectionReadiness = sqliteTable(
	"graph_projection_readiness",
	{
		organizationId: text("organization_id").primaryKey(),
		state: text("state", {
			enum: GRAPH_PROJECTION_READINESS_STATES,
		})
			.notNull()
			.default("disabled"),
		reason: text("reason"),
		projectionEpoch: text("projection_epoch"),
		persistedWatermark: integer("persisted_watermark").notNull().default(0),
		gdsWatermark: integer("gds_watermark").notNull().default(0),
		gdsEpoch: text("gds_epoch"),
		nodeMismatchCount: integer("node_mismatch_count"),
		edgeMismatchCount: integer("edge_mismatch_count"),
		lifecycleMismatchCount: integer("lifecycle_mismatch_count"),
		repairId: text("repair_id"),
		repairPhase: text("repair_phase", {
			enum: GRAPH_PROJECTION_REPAIR_PHASES,
		}),
		repairCursor: text("repair_cursor"),
		repairHighWater: integer("repair_high_water"),
		repairStartedAt: text("repair_started_at"),
		lastCertifiedAt: text("last_certified_at"),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_graph_projection_readiness_state").on(
			table.state,
			table.updatedAt,
		),
	],
);

export type GraphProjectionReadiness =
	typeof graphProjectionReadiness.$inferSelect;

export const GRAPH_PROJECTION_MAINTENANCE_OPERATIONS = ["gds_refresh"] as const;
export type GraphProjectionMaintenanceOperation =
	(typeof GRAPH_PROJECTION_MAINTENANCE_OPERATIONS)[number];
export const GRAPH_PROJECTION_MAINTENANCE_ENVIRONMENTS = [
	"development",
	"staging",
	"production",
] as const;
export type GraphProjectionMaintenanceEnvironment =
	(typeof GRAPH_PROJECTION_MAINTENANCE_ENVIRONMENTS)[number];

export const GRAPH_PROJECTION_MAINTENANCE_STATUSES = [
	"queued",
	"running",
	"cancel_requested",
	"completed",
	"failed",
	"canceled",
] as const;
export type GraphProjectionMaintenanceStatus =
	(typeof GRAPH_PROJECTION_MAINTENANCE_STATUSES)[number];

/**
 * Canonical lifecycle owner for asynchronous graph-maintenance operations.
 *
 * `id` is also the public MCP Task id and Cloudflare Workflow instance id.
 * The environment/org/idempotency unique key makes duplicate starts atomic
 * even though every deployment shares D1; the request fingerprint prevents a
 * caller from reusing one key for different work.
 */
export const graphProjectionMaintenanceRuns = sqliteTable(
	"graph_projection_maintenance_runs",
	{
		id: text("id").primaryKey(),
		runtimeEnvironment: text("runtime_environment", {
			enum: GRAPH_PROJECTION_MAINTENANCE_ENVIRONMENTS,
		}).notNull(),
		organizationId: text("organization_id").notNull(),
		operation: text("operation", {
			enum: GRAPH_PROJECTION_MAINTENANCE_OPERATIONS,
		}).notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		requestFingerprint: text("request_fingerprint").notNull(),
		workflowId: text("workflow_id").notNull().unique(),
		status: text("status", {
			enum: GRAPH_PROJECTION_MAINTENANCE_STATUSES,
		})
			.notNull()
			.default("queued"),
		result: text("result", { mode: "json" }).$type<Record<string, JsonValue>>(),
		error: text("error"),
		cancelReason: text("cancel_reason"),
		cancelRequestedAt: text("cancel_requested_at"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		startedAt: text("started_at"),
		completedAt: text("completed_at"),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uq_graph_projection_maintenance_org_idempotency").on(
			table.runtimeEnvironment,
			table.organizationId,
			table.idempotencyKey,
		),
		index("idx_graph_projection_maintenance_org_status").on(
			table.runtimeEnvironment,
			table.organizationId,
			table.status,
			table.updatedAt,
		),
		index("idx_graph_projection_maintenance_status_updated").on(
			table.runtimeEnvironment,
			table.status,
			table.updatedAt,
			table.id,
		),
	],
);

export type GraphProjectionMaintenanceRun =
	typeof graphProjectionMaintenanceRuns.$inferSelect;
