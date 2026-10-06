/**
 * Business Capability Map Schema
 *
 * Value-stream-derived capabilities: WHAT the org does to deliver value
 * (LeanIX capability-map precondition, Porter linkage refinement — flywheel
 * remodel P5 #2). Capabilities form an org-scoped tree (max depth 3) with a
 * pace layer and optional maturity score per node; skills/apps/tedis/
 * objectives map onto capabilities through one generic link table so
 * coverage and relevance-filter gaps are queryable.
 *
 * D1 is canonical; the Neo4j `Capability` node + `SUPPORTS` edges are a
 * projection (apps/api/src/integrations/graph-db).
 */

import {
	type AnySQLiteColumn,
	index,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

// =============================================================================
// ENUMS
// =============================================================================

/**
 * Pace-layer classification per capability (Gartner pace layering), matching
 * SKILL_PACE_LAYERS semantics: record = systems of record, differentiation =
 * competitive routines, innovation = experiments.
 */
export const CAPABILITY_PACE_LAYERS = [
	"innovation",
	"differentiation",
	"record",
] as const;
export type CapabilityPaceLayer = (typeof CAPABILITY_PACE_LAYERS)[number];

export const CAPABILITY_STATUS_VALUES = ["active", "archived"] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUS_VALUES)[number];

/** Entity kinds a capability can be realized by. One generic link table, not four. */
export const CAPABILITY_LINK_KINDS = [
	"skill",
	"app",
	"tedi",
	"external_agent",
	"objective",
] as const;
export type CapabilityLinkKind = (typeof CAPABILITY_LINK_KINDS)[number];

/** Hard tree-depth ceiling (root = depth 1). Enforced in queries/capabilities.ts. */
export const MAX_CAPABILITY_DEPTH = 3;

// =============================================================================
// TABLES
// =============================================================================

export const orgCapabilities = sqliteTable(
	"org_capabilities",
	{
		id: text("id").primaryKey(),

		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		/** Parent capability — null for value-stream roots. Max depth 3. */
		parentId: text("parent_id").references(
			(): AnySQLiteColumn => orgCapabilities.id,
			{ onDelete: "cascade" },
		),

		/** Short business-facing name — "Deploy & Release" */
		name: text("name").notNull(),

		/** URL-safe identifier, unique per org */
		slug: text("slug").notNull(),

		description: text("description"),

		/** Which tenant value stream this capability serves (Porter: derive from value streams, not abstract taxonomy) */
		valueStream: text("value_stream"),

		/** innovation, differentiation, record — governance rigor scales by layer */
		paceLayer: text("pace_layer", { enum: CAPABILITY_PACE_LAYERS }).notNull(),

		/** 0-1 self-assessed maturity; null = not yet assessed */
		maturityScore: real("maturity_score"),

		/** active, archived — archive is a soft subtree operation */
		status: text("status", { enum: CAPABILITY_STATUS_VALUES })
			.notNull()
			.default("active"),

		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at"),
		archivedAt: text("archived_at"),
	},
	(table) => [
		index("idx_org_capabilities_parent").on(table.parentId),
		index("idx_org_capabilities_org_status").on(
			table.organizationId,
			table.status,
		),
		uniqueIndex("uniq_org_capabilities_org_slug").on(
			table.organizationId,
			table.slug,
		),
	],
);

export type OrgCapability = typeof orgCapabilities.$inferSelect;
export type NewOrgCapability = typeof orgCapabilities.$inferInsert;

export const capabilityLinks = sqliteTable(
	"capability_links",
	{
		id: text("id").primaryKey(),

		capabilityId: text("capability_id")
			.notNull()
			.references(() => orgCapabilities.id, { onDelete: "cascade" }),

		/** Denormalized org scope so unmapped-entity reads never join through the capability */
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		/** skill, app, tedi, external_agent, objective */
		entityKind: text("entity_kind", { enum: CAPABILITY_LINK_KINDS }).notNull(),

		/** ID in the entity's own table (skill_entries, apps, tedis, tedi_objectives). No FK — kinds are polymorphic. */
		entityId: text("entity_id").notNull(),

		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("uniq_capability_links_target").on(
			table.capabilityId,
			table.entityKind,
			table.entityId,
		),
		index("idx_capability_links_org_entity").on(
			table.organizationId,
			table.entityKind,
			table.entityId,
		),
	],
);

export type CapabilityLink = typeof capabilityLinks.$inferSelect;
export type NewCapabilityLink = typeof capabilityLinks.$inferInsert;
