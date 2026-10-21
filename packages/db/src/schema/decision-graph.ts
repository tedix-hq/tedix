/**
 * Decision graph edges: how Deck cards connect to earlier decisions, owner
 * instructions, Work, Outputs, people, systems and credential metadata.
 *
 * Endpoints are polymorphic (`kind` + existing row id), so they carry no
 * foreign keys. One row per (organization, from, kind, to); writers upsert.
 */

import {
	DECISION_GRAPH_EDGE_KINDS,
	DECISION_GRAPH_NODE_KINDS,
} from "@tedix/api-contract/schemas/decision-graph";
import {
	index,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

export const decisionEdges = sqliteTable(
	"decision_edges",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		fromKind: text("from_kind", { enum: DECISION_GRAPH_NODE_KINDS }).notNull(),
		fromId: text("from_id").notNull(),
		kind: text("kind", { enum: DECISION_GRAPH_EDGE_KINDS }).notNull(),
		toKind: text("to_kind", { enum: DECISION_GRAPH_NODE_KINDS }).notNull(),
		toId: text("to_id").notNull(),
		/** Writer that recorded the fact, e.g. `deck`, `approval`, `backfill`. */
		source: text("source").notNull(),
		confidence: real("confidence").notNull().default(1),
		evidenceRef: text("evidence_ref"),
		/** Short plain-English label for the target. Never a secret value. */
		note: text("note"),
		/** When the linked fact happened; drives "You decided this on …". */
		occurredAt: text("occurred_at").notNull(),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("uq_decision_edges_org_from_kind_to").on(
			table.orgId,
			table.fromId,
			table.fromKind,
			table.kind,
			table.toId,
			table.toKind,
		),
		index("idx_decision_edges_org_to_kind").on(
			table.orgId,
			table.toId,
			table.kind,
		),
	],
);

export type DecisionEdgeRow = typeof decisionEdges.$inferSelect;
export type NewDecisionEdgeRow = typeof decisionEdges.$inferInsert;
