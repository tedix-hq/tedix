/**
 * Audit Events Schema
 * Tracks all significant platform actions for compliance and debugging
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
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
		// deleteOldAuditEvents sweeps `WHERE timestamp < cutoff` with no org filter —
		// needs timestamp as the leading column.
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
	],
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
