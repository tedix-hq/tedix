/**
 * Memory Graph Schema
 * Knowledge graph for tedi long-term memory — facts, edges, and domains.
 *
 * Every tedi accumulates domain expertise as structured facts with
 * typed relationships. This is the foundation of the memory layer.
 */

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
import { organizations } from "./organizations";
import { tedis } from "./tedis";

// ============================================================================
// Memory Domains — Knowledge areas with hierarchy
// ============================================================================

export const memoryDomains = sqliteTable(
	"memory_domains",
	{
		id: text("id").primaryKey(),

		// Multi-tenant scope
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

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

// ============================================================================
// Memory Facts — Atomic pieces of knowledge
// ============================================================================

/**
 * Fact types:
 * - technical: code patterns, API quirks, configuration gotchas
 * - strategic: business decisions, positioning, competitive insights
 * - pattern: recurring bugs, anti-patterns, best practices
 * - decision: architecture/design decisions with rationale
 * - preference: user preferences, communication style
 * - feedback: direct user feedback, corrections
 * - procedural: how-to knowledge, workflow steps
 * - episode: structured episodic record (session/task with outcome)
 */
export const memoryFacts = sqliteTable(
	"memory_facts",
	{
		id: text("id").primaryKey(),

		// Multi-tenant scope
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		// Optional tedi scope (null = org-wide fact)
		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "cascade",
		}),

		// Knowledge domain
		domainId: text("domain_id").references(() => memoryDomains.id, {
			onDelete: "set null",
		}),

		// The actual knowledge
		content: text("content").notNull(),
		summary: text("summary"), // Optional short summary for quick recall

		// Classification
		factType: text("fact_type", { enum: MEMORY_FACT_TYPES }).notNull(),

		// Confidence scoring (0.0 to 1.0)
		// Decays over time, boosted by verification/usage
		confidence: real("confidence").notNull().default(0.8),

		// Bi-temporal validity (Graphiti pattern)
		// validFrom: when the fact became true in the real world
		// validTo: when it stopped being true (null = still valid)
		validFrom: text("valid_from").default(sql`(CURRENT_TIMESTAMP)`),
		validTo: text("valid_to"), // null = currently valid; set on contradiction

		// Fact lifecycle status: probation → active → archived
		// New facts enter "probation" — promoted to "active" after validation
		status: text("status", {
			enum: ["probation", "active"],
		}).default("active"),

		// Source tracking
		source: text("source"), // structured URI: "doc://docs/mcp/runtime.md", "api://klarna/search", "conversation://session-123"
		sourceSessionId: text("source_session_id"), // Which conversation produced this fact
		sourceUrl: text("source_url"), // If from external source
		sourceHash: text("source_hash"), // SHA-256 hash of source content at learn time (for change detection)

		// Rebuildable semantic-projection reference. D1 remains canonical;
		// Cloudflare Agent Memory sessions use the deterministic fact ID.
		embeddingId: text("embedding_id"),

		// Learning governance
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

		// Metadata (flexible JSON for domain-specific data)
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),

		// Priority (core = protected from decay, active = default, background = deprioritized)
		priority: text("priority", {
			enum: ["core", "active", "background"],
		}).default("active"),

		// Visibility (private = tedi-only, shared = all tedis, org = org-wide baseline)
		visibility: text("visibility", {
			enum: ["private", "shared", "org"],
		}).default("private"),
		promotedFrom: text("promoted_from"), // fact ID this was promoted from
		promotedAt: text("promoted_at"),

		// Lifecycle
		lastVerifiedAt: text("last_verified_at"), // When fact was last confirmed true
		lastAccessedAt: text("last_accessed_at"), // When fact was last retrieved
		accessCount: integer("access_count").notNull().default(0),
		usageCount: integer("usage_count").notNull().default(0),
		archivedAt: text("archived_at"), // Soft delete — moved to cold storage

		// Timestamps
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		// Serves `getTopPlatformFacts`, which runs on every Home turn. The three
		// leading columns are all equality-constrained (`archived_at IS NULL`
		// counts), so SQLite can walk the remaining two in index order and stop at
		// the LIMIT instead of sorting the organization's entire fact set. This
		// only works because the caller asks for ONE priority per query -- a
		// `CASE`/`OR` over priority reintroduces the temp B-tree even with this
		// index present, which is why the index and the split query ship together.
		index("idx_memory_facts_priority_rank").on(
			table.organizationId,
			table.priority,
			table.archivedAt,
			table.confidence,
			table.lastAccessedAt,
		),
		// `idx_memory_facts_org` (organization_id) and `idx_memory_facts_tedi`
		// (tedi_id) were strict prefixes of indexes that already existed, so every
		// seek they served was served identically by a longer one; they only cost
		// write amplification on the platform's hottest table.
		index("idx_memory_facts_domain").on(table.domainId),
		index("idx_memory_facts_type").on(table.factType),
		index("idx_memory_facts_confidence").on(table.confidence),
		index("idx_memory_facts_source").on(table.source),
		index("idx_memory_facts_archived").on(table.archivedAt),
		index("idx_memory_facts_valid_to").on(table.validTo),
		index("idx_memory_facts_status").on(table.status),
		index("idx_memory_facts_org_type").on(table.organizationId, table.factType),
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
		index("idx_memory_facts_use_policy").on(table.usePolicy),
		index("idx_memory_facts_review_status").on(table.reviewStatus),
		index("memory_facts_tedi_domain_idx").on(table.tediId, table.domainId),
	],
);

// ============================================================================
// Memory Edges — Relationships between facts
// ============================================================================

/**
 * Relation types:
 * - caused_by: fact A was caused by fact B
 * - contradicts: fact A contradicts fact B (newer should supersede)
 * - supersedes: fact A replaces fact B (version evolution)
 * - applies_to: fact A is relevant when fact B's context is active
 * - learned_from: fact A was derived from fact B (pattern from bug)
 * - requires: fact A depends on fact B being true
 * - related_to: general relationship without specific direction
 */
export type RelationType =
	| "caused_by"
	| "contradicts"
	| "supersedes"
	| "applies_to"
	| "learned_from"
	| "requires"
	| "related_to"
	| "promoted_from";

export const RELATION_TYPES = [
	"caused_by",
	"contradicts",
	"supersedes",
	"applies_to",
	"learned_from",
	"requires",
	"related_to",
	"promoted_from",
] as const;

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

		// Edge strength (0.0 to 1.0) — how strong the relationship is
		// Can be updated by reflection workflow
		strength: real("strength").notNull().default(0.5),

		// Optional context for why this relationship exists
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

// ============================================================================
// Tedi Expertise — Per-tedi knowledge profile per domain
// ============================================================================

export type ExpertiseLevel = "novice" | "familiar" | "proficient" | "expert";

export const EXPERTISE_LEVELS = [
	"novice",
	"familiar",
	"proficient",
	"expert",
] as const;

export type FactPriority = "core" | "active" | "background";

export const FACT_PRIORITIES = ["core", "active", "background"] as const;

export type FactVisibility = "private" | "shared" | "org";

export const FACT_VISIBILITIES = ["private", "shared", "org"] as const;

export type MemoryScope = "org" | "tedi" | "kernel" | "session" | "graph";

export const MEMORY_SCOPES = [
	"org",
	"tedi",
	"kernel",
	"session",
	"graph",
] as const;

export type MemoryUsePolicy =
	| "can_use_as_instruction"
	| "can_use_as_evidence"
	| "requires_user_confirmation"
	| "do_not_inject_automatically";

export const MEMORY_USE_POLICIES = [
	"can_use_as_instruction",
	"can_use_as_evidence",
	"requires_user_confirmation",
	"do_not_inject_automatically",
] as const;

export type MemoryReviewStatus =
	| "pending"
	| "confirmed"
	| "evidence_only"
	| "restricted"
	| "stale"
	| "disputed"
	| "rejected"
	| "superseded";

export const MEMORY_REVIEW_STATUSES = [
	"pending",
	"confirmed",
	"evidence_only",
	"restricted",
	"stale",
	"disputed",
	"rejected",
	"superseded",
] as const;

export const tediExpertise = sqliteTable(
	"tedi_expertise",
	{
		id: text("id").primaryKey(),

		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),

		domainId: text("domain_id")
			.notNull()
			.references(() => memoryDomains.id),

		factCount: integer("fact_count").notNull().default(0),
		avgConfidence: real("avg_confidence").notNull().default(0),
		expertiseLevel: text("expertise_level", {
			enum: ["novice", "familiar", "proficient", "expert"],
		})
			.notNull()
			.default("novice"),

		lastActivityAt: text("last_activity_at"),

		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		unique("uniq_tedi_domain").on(table.tediId, table.domainId),
		index("idx_tedi_expertise_tedi").on(table.tediId),
		index("idx_tedi_expertise_domain").on(table.domainId),
	],
);

// ============================================================================
// Curiosity Queue — Tracks what a tedi should explore next
// ============================================================================

export type CuriositySource =
	| "gap_detection"
	| "adjacent_domain"
	| "cross_tedi"
	| "human_request"
	| "self_test"
	| "reflection";

export const CURIOSITY_SOURCES = [
	"gap_detection",
	"adjacent_domain",
	"cross_tedi",
	"human_request",
	"self_test",
	"reflection",
] as const;

export type CuriosityStatus = "queued" | "exploring" | "completed" | "deferred";

export const CURIOSITY_STATUSES = [
	"queued",
	"exploring",
	"completed",
	"deferred",
] as const;

export const tediCuriosityQueue = sqliteTable(
	"tedi_curiosity_queue",
	{
		id: text("id").primaryKey(),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		// What to explore
		topic: text("topic").notNull(),
		domain: text("domain").notNull(),
		reason: text("reason").notNull(),

		// Priority (0-1)
		priority: real("priority").notNull().default(0.5),
		source: text("source", {
			enum: [
				"gap_detection",
				"adjacent_domain",
				"cross_tedi",
				"human_request",
				"self_test",
				"reflection",
			],
		}).notNull(),

		// Lifecycle
		status: text("status", {
			enum: ["queued", "exploring", "completed", "deferred"],
		})
			.notNull()
			.default("queued"),

		// Results
		factsLearned: integer("facts_learned").notNull().default(0),
		gapsFound: integer("gaps_found").notNull().default(0),
		completedAt: text("completed_at"),

		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_curiosity_queue_tedi").on(table.tediId),
		index("idx_curiosity_queue_org").on(table.organizationId),
		index("idx_curiosity_queue_status").on(table.status),
		index("idx_curiosity_queue_priority").on(table.priority),
	],
);

// ============================================================================
// Optimization Signals — Friction detection and improvement tracking
// ============================================================================

export type OptimizationSignalType =
	| "repeated_correction"
	| "understanding_gap"
	| "efficiency_regression"
	| "confidence_mismatch"
	| "judgment_override"
	| "error_rate_increase"
	| "unused_capability"
	| "cross_tedi_delta"
	| "compiled_pattern"
	| "approval_fatigue";

export const OPTIMIZATION_SIGNAL_TYPES = [
	"repeated_correction",
	"understanding_gap",
	"efficiency_regression",
	"confidence_mismatch",
	"judgment_override",
	"error_rate_increase",
	"unused_capability",
	"cross_tedi_delta",
	"compiled_pattern",
	"approval_fatigue",
] as const;

export type OptimizationSignalSource =
	| "self_detected"
	| "human_feedback"
	| "cross_tedi"
	| "metric_alert"
	| "atlas_compilation";

export const OPTIMIZATION_SIGNAL_SOURCES = [
	"self_detected",
	"human_feedback",
	"cross_tedi",
	"metric_alert",
	"atlas_compilation",
] as const;

export type OptimizationSignalStatus =
	| "detected"
	| "proposed"
	| "approved"
	| "executing"
	| "completed"
	| "dismissed";

export const OPTIMIZATION_SIGNAL_STATUSES = [
	"detected",
	"proposed",
	"approved",
	"executing",
	"completed",
	"dismissed",
] as const;

export const tediOptimizationSignals = sqliteTable(
	"tedi_optimization_signals",
	{
		id: text("id").primaryKey(),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		type: text("type", {
			enum: [
				"repeated_correction",
				"understanding_gap",
				"efficiency_regression",
				"confidence_mismatch",
				"judgment_override",
				"error_rate_increase",
				"unused_capability",
				"cross_tedi_delta",
				"compiled_pattern",
				"approval_fatigue",
			],
		}).notNull(),

		source: text("source", {
			enum: [
				"self_detected",
				"human_feedback",
				"cross_tedi",
				"metric_alert",
				"atlas_compilation",
			],
		}).notNull(),

		domain: text("domain").notNull(),
		evidence: text("evidence", { mode: "json" }).$type<string[]>().notNull(),
		suggestedAction: text("suggested_action").notNull(),

		estimatedImpact: real("estimated_impact").notNull().default(0.5),
		estimatedEffort: real("estimated_effort").notNull().default(0.5),
		roi: real("roi").notNull().default(1.0),

		status: text("status", {
			enum: [
				"detected",
				"proposed",
				"approved",
				"executing",
				"completed",
				"dismissed",
			],
		})
			.notNull()
			.default("detected"),

		resolvedAt: text("resolved_at"),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_optimization_signals_tedi").on(table.tediId),
		index("idx_optimization_signals_org").on(table.organizationId),
		index("idx_optimization_signals_status").on(table.status),
		index("idx_optimization_signals_roi").on(table.roi),
	],
);

// ============================================================================
// Inferred Types
// ============================================================================

export type MemoryDomain = typeof memoryDomains.$inferSelect;
export type NewMemoryDomain = typeof memoryDomains.$inferInsert;

export type MemoryFact = typeof memoryFacts.$inferSelect;
export type NewMemoryFact = typeof memoryFacts.$inferInsert;

export type MemoryEdge = typeof memoryEdges.$inferSelect;
export type NewMemoryEdge = typeof memoryEdges.$inferInsert;

export type TediExpertise = typeof tediExpertise.$inferSelect;
export type NewTediExpertise = typeof tediExpertise.$inferInsert;

export type TediCuriosityItem = typeof tediCuriosityQueue.$inferSelect;
export type NewTediCuriosityItem = typeof tediCuriosityQueue.$inferInsert;

export type TediOptimizationSignal =
	typeof tediOptimizationSignals.$inferSelect;
export type NewTediOptimizationSignal =
	typeof tediOptimizationSignals.$inferInsert;
