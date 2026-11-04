/**
 * Audit Events Schema
 * Tracks all significant platform actions for compliance and debugging
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const auditEvents = sqliteTable(
	"audit_events",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		actorId: text("actor_id").notNull(),
		actorType: text("actor_type").notNull(), // "user" | "service" | "tedi" | "m2m"
		action: text("action").notNull(), // "app.created" | "tedi.deleted" | "secret.accessed" | "tool.invoked"
		resourceType: text("resource_type").notNull(), // "app" | "tedi" | "secret" | "api_key" | "tool"
		resourceId: text("resource_id"), // nullable for list operations
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(), // JSON with action-specific details
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
	},
	(table) => [
		// search_audit / governance-overview / home-reflection-producer all filter
		// organization_id and ORDER BY timestamp DESC.
		index("idx_audit_events_org_timestamp").on(
			table.organizationId,
			table.timestamp,
		),
		// Retention (queries/d1-retention.ts) walks the rowid b-tree; this index
		// still serves cross-org time-window reads with timestamp leading.
		index("idx_audit_events_timestamp").on(table.timestamp),
		// getAuditEventsByResource pins all three columns. Without this it fell back
		// to the org/timestamp index and scanned every event in the organization,
		// filtering resource_type/resource_id row by row (measured 338,510 rows to
		// return none). Trailing timestamp keeps the ORDER BY index-served too.
		index("idx_audit_events_resource").on(
			table.organizationId,
			table.resourceType,
			table.resourceId,
			table.timestamp,
		),
		// queries/analytics-audit.ts looks MCP telemetry up by metadata fields.
		// Without these expression indexes each lookup walked the whole tenant
		// over idx_audit_events_org_timestamp in both stores and applied
		// json_extract row by row (measured 1,679,000 rows read and 7 s on the
		// logs database to return one trace). The expressions must match the
		// query text exactly for SQLite to use them.
		// Trace and execution ids are unique across tenants, so the index leads
		// with the id and serves platform-wide (no organization) reads too;
		// trailing timestamp keeps the ORDER BY index-served.
		index("idx_audit_events_trace_timestamp").on(
			sql`json_extract(${table.metadata}, '$.traceId')`,
			table.timestamp,
		),
		index("idx_audit_events_execution_timestamp").on(
			sql`json_extract(${table.metadata}, '$.executionId')`,
			table.timestamp,
		),
		// Recent activity by app and by actor: organization leads so the planner
		// prefers this over the tenant index when both equalities are present.
		index("idx_audit_events_org_app_timestamp").on(
			table.organizationId,
			sql`json_extract(${table.metadata}, '$.appId')`,
			table.timestamp,
		),
		index("idx_audit_events_org_actor_timestamp").on(
			table.organizationId,
			table.actorId,
			table.timestamp,
		),
	],
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
