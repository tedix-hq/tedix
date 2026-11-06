// Workspace-local memory tables keep local foreign keys. Object scope guards
// replace references to organization and tedi records in the control plane.

import { MEMORY_FACT_TYPES } from "@tedix/api-contract/constants/enums";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	real,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";

export const memoryDomains = sqliteTable(
	"memory_domains",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),

		name: text("name").notNull(), // e.g., "drizzle", "cloudflare", "product"
		parentId: text("parent_id"), // self-referential for hierarchy
		description: text("description"),

		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		unique("uniq_domain_org_name").on(table.organizationId, table.name),
		index("idx_memory_domains_org").on(table.organizationId),
		index("idx_memory_domains_parent").on(table.parentId),
	],
);

export const memoryFacts = sqliteTable(
	"memory_facts",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		tediId: text("tedi_id"),
		domainId: text("domain_id").references(() => memoryDomains.id, {
			onDelete: "set null",
		}),
		content: text("content").notNull(),
		summary: text("summary"), // Optional short summary for quick recall
		factType: text("fact_type", { enum: MEMORY_FACT_TYPES }).notNull(),
		confidence: real("confidence").notNull().default(0.8),
		validFrom: text("valid_from").default(sql`(CURRENT_TIMESTAMP)`),
		validTo: text("valid_to"), // null = currently valid; set on contradiction
		status: text("status", {
			enum: ["probation", "active"],
		}).default("active"),
		source: text("source"), // structured URI: "doc://docs/mcp/runtime.md", "api://klarna/search", "conversation://session-123"
		sourceSessionId: text("source_session_id"), // Which conversation produced this fact
		sourceUrl: text("source_url"), // If from external source
		sourceHash: text("source_hash"), // SHA-256 hash of source content at learn time (for change detection)
		embeddingId: text("embedding_id"),
		topicKey: text("topic_key"), // stable state key, e.g. org:slug.connector.firecrawl.credential_state
		memoryScope: text("memory_scope", {
			enum: ["org", "tedi", "kernel", "session", "graph"],
		}).default("tedi"),
		usePolicy: text("use_policy", {
			enum: [
				"can_use_as_instruction",
				"can_use_as_evidence",
				"requires_user_confirmation",
				"do_not_inject_automatically",
			],
		}).default("can_use_as_evidence"),
		reviewStatus: text("review_status", {
			enum: [
				"pending",
				"confirmed",
				"evidence_only",
				"restricted",
				"stale",
				"disputed",
				"rejected",
				"superseded",
			],
		}).default("pending"),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		priority: text("priority", {
			enum: ["core", "active", "background"],
		}).default("active"),
		visibility: text("visibility", {
			enum: ["private", "shared", "org"],
		}).default("private"),
		promotedFrom: text("promoted_from"), // fact ID this was promoted from
		promotedAt: text("promoted_at"),
		lastVerifiedAt: text("last_verified_at"), // When fact was last confirmed true
		lastAccessedAt: text("last_accessed_at"), // When fact was last retrieved
		accessCount: integer("access_count").notNull().default(0),
		usageCount: integer("usage_count").notNull().default(0),
		archivedAt: text("archived_at"), // Soft delete — moved to cold storage
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_memory_facts_priority_rank").on(
			table.organizationId,
			table.priority,
			table.archivedAt,
			table.confidence,
			table.lastAccessedAt,
		),
		index("idx_memory_facts_domain").on(table.domainId),
		index("idx_memory_facts_type").on(table.factType),
		index("idx_memory_facts_confidence").on(table.confidence),
		index("idx_memory_facts_source").on(table.source),
		index("idx_memory_facts_org_source_id").on(
			table.organizationId,
			table.source,
			table.id,
		),
		index("idx_memory_facts_org_type_rank").on(
			table.organizationId,
			table.factType,
			table.archivedAt,
			table.validTo,
			table.confidence,
			table.lastAccessedAt,
			table.createdAt,
		),
		index("idx_memory_facts_org_live_rank").on(
			table.organizationId,
			table.archivedAt,
			table.validTo,
			table.confidence,
			table.lastAccessedAt,
			table.createdAt,
		),
		index("idx_memory_facts_org_recall_time").on(
			table.organizationId,
			sql`datetime(coalesce(${table.validFrom}, ${table.createdAt}))`,
		),
		index("idx_memory_facts_org_recall_until").on(
			table.organizationId,
			sql`datetime(${table.validTo})`,
		),
		index("idx_memory_facts_status").on(table.status),
		index("idx_memory_facts_org_domain").on(
			table.organizationId,
			table.domainId,
		),
		index("idx_memory_facts_visibility").on(table.visibility),
		index("idx_memory_facts_priority").on(table.priority),
		index("idx_memory_facts_topic_key").on(
			table.organizationId,
			table.topicKey,
		),
		index("idx_memory_facts_scope").on(table.organizationId, table.memoryScope),
		index("idx_memory_facts_flywheel_created").on(
			table.organizationId,
			table.tediId,
			table.createdAt,
		),
		index("idx_memory_facts_flywheel_accessed").on(
			table.organizationId,
			table.lastAccessedAt,
		),
		index("idx_memory_facts_flywheel_updated").on(
			table.organizationId,
			table.updatedAt,
		),
		index("idx_memory_facts_visibility_policy_updated").on(
			table.organizationId,
			table.visibility,
			table.reviewStatus,
			table.usePolicy,
			table.updatedAt,
		),
		index("idx_memory_facts_use_policy").on(table.usePolicy),
		index("idx_memory_facts_review_status").on(table.reviewStatus),
		index("memory_facts_tedi_domain_idx").on(table.tediId, table.domainId),
	],
);

export const memoryEdges = sqliteTable(
	"memory_edges",
	{
		id: text("id").primaryKey(),

		sourceFactId: text("source_fact_id")
			.notNull()
			.references(() => memoryFacts.id, { onDelete: "cascade" }),

		targetFactId: text("target_fact_id")
			.notNull()
			.references(() => memoryFacts.id, { onDelete: "cascade" }),

		relationType: text("relation_type", {
			enum: [
				"caused_by",
				"contradicts",
				"supersedes",
				"applies_to",
				"learned_from",
				"requires",
				"related_to",
				"promoted_from",
			],
		}).notNull(),
		strength: real("strength").notNull().default(0.5),
		context: text("context"),

		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		unique("uniq_edge").on(
			table.sourceFactId,
			table.targetFactId,
			table.relationType,
		),
		index("idx_memory_edges_source").on(table.sourceFactId),
		index("idx_memory_edges_target").on(table.targetFactId),
		index("idx_memory_edges_type").on(table.relationType),
	],
);
