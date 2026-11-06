import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
	GRAPH_PROJECTION_ENTITY_KINDS,
	GRAPH_PROJECTION_OPERATIONS,
} from "../../schema/graph-projection";

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
