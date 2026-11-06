import { sql } from "drizzle-orm";
import {
	index,
	integer,
	real,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import { memoryDomains } from "./memory-graph";

export const tediExpertise = sqliteTable(
	"tedi_expertise",
	{
		id: text("id").primaryKey(),

		tediId: text("tedi_id").notNull(),

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

export const tediCuriosityQueue = sqliteTable(
	"tedi_curiosity_queue",
	{
		id: text("id").primaryKey(),
		tediId: text("tedi_id").notNull(),
		organizationId: text("organization_id").notNull(),
		topic: text("topic").notNull(),
		domain: text("domain").notNull(),
		reason: text("reason").notNull(),
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
		status: text("status", {
			enum: ["queued", "exploring", "completed", "deferred"],
		})
			.notNull()
			.default("queued"),
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

export const tediOptimizationSignals = sqliteTable(
	"tedi_optimization_signals",
	{
		id: text("id").primaryKey(),
		tediId: text("tedi_id").notNull(),
		organizationId: text("organization_id").notNull(),

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
