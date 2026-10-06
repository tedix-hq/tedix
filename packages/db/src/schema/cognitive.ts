import type { OsDerivedAccessEnvelope } from "@tedix/api-contract/schemas/os-workspaces";
/**
 * Cognitive Stack Schema
 * Knowledge entries, skill entries, and muscle memory for tedi cognitive architecture.
 *
 * These are DIFFERENT from:
 * - content-sources.ts (content_sources — Firecrawl/Upstash for customer FAQs)
 * - tedi-skills (DELETED — R2 skills removed)
 *
 * This is the tedi's own synthesized expertise, procedure library, and muscle memory.
 */

import {
	MUSCLE_KIND,
	MUSCLE_ORIGIN,
} from "@tedix/api-contract/constants/enums";
import type { SkillRunCostSummary } from "@tedix/api-contract/contracts/cognitive";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	type AnySQLiteColumn,
	index,
	integer,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { apps } from "./apps";
import { memoryDomains } from "./memory-graph";
import { organizations } from "./organizations";
import { tedis } from "./tedis";

// ============================================================================
// Knowledge Entries — Synthesized expertise
// ============================================================================

export const KNOWLEDGE_ENTRY_TYPES = [
	"insight",
	"pattern",
	"anti_pattern",
	"convention",
	"opinion",
	"decision",
] as const;

export type KnowledgeEntryType = (typeof KNOWLEDGE_ENTRY_TYPES)[number];

export const COGNITIVE_VISIBILITIES = ["private", "shared", "org"] as const;
export type CognitiveVisibility = (typeof COGNITIVE_VISIBILITIES)[number];

export const knowledgeEntries = sqliteTable(
	"knowledge_entries",
	{
		id: text("id").primaryKey(),

		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "cascade",
		}),

		domainId: text("domain_id").references(() => memoryDomains.id, {
			onDelete: "set null",
		}),

		title: text("title").notNull(),
		content: text("content").notNull(),

		entryType: text("entry_type", {
			enum: [
				"insight",
				"pattern",
				"anti_pattern",
				"convention",
				"opinion",
				"decision",
			],
		}).notNull(),

		// Source tracking — which facts informed this entry
		sourceFactIds: text("source_fact_ids", { mode: "json" }).$type<string[]>(),
		sourceCount: integer("source_count").notNull().default(0),

		// Confidence and versioning
		confidence: real("confidence").notNull().default(0.8),
		revision: integer("revision").notNull().default(1),
		revisionReasoning: text("revision_reasoning"),
		supersedesId: text("supersedes_id"),

		visibility: text("visibility", {
			enum: ["private", "shared", "org"],
		})
			.notNull()
			.default("private"),

		tags: text("tags", { mode: "json" }).$type<string[]>(),
		lastValidatedAt: text("last_validated_at"),

		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_knowledge_entries_tedi").on(table.tediId),
		index("idx_knowledge_entries_domain").on(table.domainId),
		index("idx_knowledge_entries_type").on(table.entryType),
		index("idx_knowledge_entries_visibility").on(table.visibility),
		index("idx_knowledge_entries_org_domain").on(
			table.organizationId,
			table.domainId,
		),
		index("idx_knowledge_entries_supersedes").on(table.supersedesId),
	],
);

// ============================================================================
// Skill Entries — Procedure library
// ============================================================================

/**
 * Pace-layer classification (flywheel remodel WS6): a skill's strategic role,
 * which drives governance rigor (Gartner pace layering / Brand's shearing
 * layers — fast proposes, slow disposes).
 *
 * - `innovation`       — unproven experiments: drafts, mined proposals, stale
 *                        or archived rows re-entering through execution gates.
 * - `differentiation`  — executing routines with a track record: active/proven.
 * - `record`           — crystallized system-of-record routines.
 */
export const SKILL_PACE_LAYERS = [
	"innovation",
	"differentiation",
	"record",
] as const;

export type SkillPaceLayer = (typeof SKILL_PACE_LAYERS)[number];

export const skillEntries = sqliteTable(
	"skill_entries",
	{
		id: text("id").primaryKey(),

		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "cascade",
		}),

		domainId: text("domain_id").references(() => memoryDomains.id, {
			onDelete: "set null",
		}),

		title: text("title").notNull(),
		slug: text("slug"), // Auto-generated from title, unique per org. URI: skill://{slug}/SKILL.md
		/**
		 * Optional control-plane organization for the catalog UI. This is NOT part
		 * of SEP-2640 identity: moving a skill between folders never changes its
		 * slug, skill:// URI, workflow references, or revision chain.
		 */
		folderPath: text("folder_path"),
		description: text("description"),
		content: text("content").notNull(), // Full procedure markdown — served as SKILL.md
		/**
		 * Optional supporting files for folder-style skills (SEP-2640 directory model).
		 * Map of relative path → file content. Path keys MUST NOT include "SKILL.md"
		 * (the canonical SKILL.md is always served from `content`). Examples:
		 *   { "references/checklist.md": "...", "scripts/setup.sh": "..." }
		 * Served via the skill://<skill-path>/{+filePath} resource template.
		 */
		files: text("files", { mode: "json" }).$type<Record<string, string>>(),

		// Parameter definitions
		inputSchema: text("input_schema", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),

		// Usage stats
		successCount: integer("success_count").notNull().default(0),
		failureCount: integer("failure_count").notNull().default(0),
		lastUsedAt: text("last_used_at"),
		avgDurationMs: integer("avg_duration_ms"),

		// Versioning
		revision: integer("revision").notNull().default(1),
		revisionReasoning: text("revision_reasoning"),
		supersedesId: text("supersedes_id"),

		// Cross-copy lineage (modeled on tedi_muscle_memory.source_skill_id):
		// the canonical skill this entry was derived/copied from, and the source
		// revision at copy time — makes fleet drift enumerable so a blueprint-style
		// upgrade contract has a target list. Null = no known derivation (legacy).
		sourceSkillId: text("source_skill_id").references(
			(): AnySQLiteColumn => skillEntries.id,
			{ onDelete: "set null" },
		),
		sourceRevision: integer("source_revision"),

		visibility: text("visibility", {
			enum: ["private", "shared", "org"],
		})
			.notNull()
			.default("private"),

		// SKILL.md compatible export content
		agentSkillsFormat: text("agent_skills_format"),
		// Path to full skill in R2
		r2Path: text("r2_path"),

		// App-scoped skills (MCP progressive disclosure)
		appId: text("app_id").references(() => apps.id, { onDelete: "set null" }),
		toolIds: text("tool_ids", { mode: "json" }).$type<string[]>(),
		summary: text("summary"),

		tags: text("tags", { mode: "json" }).$type<string[]>(),
		audience: text("audience", { mode: "json" }).$type<string[]>(),

		/**
		 * Preconditions for skill applicability.
		 * - requires: other skill slugs or capabilities that must be present
		 * - notWhen: conditions under which this skill should NOT be used
		 * - validUntil: ISO 8601 date after which the skill should be re-validated
		 * - staleSince: ISO 8601 date when the skill was last flagged as potentially stale
		 */
		preconditions: text("preconditions", { mode: "json" }).$type<{
			requires?: string[];
			notWhen?: string[];
			validUntil?: string;
			staleSince?: string;
		}>(),

		/**
		 * Lifecycle state of the skill.
		 * draft → active → proven → crystallized → stale → archived
		 * Upward transitions are gated on the skill_usage_events ledger
		 * (execute-to-promote) — see queries/skill-lifecycle.ts.
		 */
		lifecycleState: text("lifecycle_state", {
			enum: ["draft", "active", "proven", "crystallized", "stale", "archived"],
		}).default("draft"),

		/**
		 * Record-layer safety valve: crystallized skills never auto-demote on
		 * failures — instead they get flagged here for human review.
		 * Set by recordSkillUsageEvent(); cleared manually after review.
		 */
		reviewFlaggedAt: text("review_flagged_at"),
		reviewFlagReason: text("review_flag_reason"),

		/**
		 * Pace-layer classification (WS6) — auto-derived from lifecycle on every
		 * transition (draft/stale/archived → innovation, active/proven →
		 * differentiation, crystallized → record) by `updateSkillEntry()` /
		 * `recordSkillUsageEvent()`. Manual override only via the force-authority
		 * path (human/operator API key).
		 */
		paceLayer: text("pace_layer", { enum: SKILL_PACE_LAYERS })
			.default("innovation")
			.notNull(),

		/**
		 * Disposer separation (agent-capability-mutation-gate ADR): the
		 * agent identity (`context.tediId`) that authored this entry at create
		 * time. Null = authored by a human/operator, or a pre-authorship-tracking row (unknown
		 * author — apply-time gating falls back to the scoped `tediId`).
		 * Deliberately NO tedis FK: authorship is provenance and must not be
		 * silently erased; it survives the apply step that clears `tediId`.
		 */
		proposedByTediId: text("proposed_by_tedi_id"),

		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_skill_entries_tedi").on(table.tediId),
		index("idx_skill_entries_domain").on(table.domainId),
		index("idx_skill_entries_visibility").on(table.visibility),
		index("idx_skill_entries_org_domain").on(
			table.organizationId,
			table.domainId,
		),
		index("idx_skill_entries_supersedes").on(table.supersedesId),
		index("idx_skill_entries_source_skill").on(table.sourceSkillId),
		index("idx_skill_entries_app").on(table.appId),
		index("idx_skill_entries_org_app").on(table.organizationId, table.appId),
		index("idx_skill_entries_org_folder").on(
			table.organizationId,
			table.folderPath,
		),
		index("idx_skill_entries_org_visibility").on(
			table.organizationId,
			table.visibility,
		),
		uniqueIndex("uniq_skill_entries_org_slug").on(
			table.organizationId,
			table.slug,
		),
		index("idx_skill_entries_lifecycle").on(table.lifecycleState),
		index("idx_skill_entries_pace_layer").on(table.paceLayer),
	],
);

// ============================================================================
// Skill Usage Events — canonical per-execution usage ledger
// ============================================================================

export const SKILL_USAGE_SOURCES = [
	"workflow_run",
	"muscle_memory",
	"direct",
] as const;

export type SkillUsageSource = (typeof SKILL_USAGE_SOURCES)[number];

export const SKILL_USAGE_OUTCOMES = ["success", "failure"] as const;

export type SkillUsageOutcome = (typeof SKILL_USAGE_OUTCOMES)[number];

/**
 * One row per skill execution, regardless of execution path (executable skill
 * workflow run, muscle-memory invocation derived from a skill, or a direct
 * self-report via `skills.usage`). This ledger is the canonical source for
 * usage/failure signals: `skill_entries.success_count`/`failure_count` are
 * rollups maintained by `recordSkillUsageEvent()` and the flywheel pulse
 * counts rows here. The (run_id, execution_epoch) unique index makes stamping
 * idempotent — concurrent reconcilers can observe the same terminal run and
 * only one increments the counters.
 */
export const skillUsageEvents = sqliteTable(
	"skill_usage_events",
	{
		id: text("id").primaryKey(),

		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		// Nullable only for direct human/org-level reports where no tedi executed
		// the skill. Every automated execution path stamps a tedi.
		tediId: text("tedi_id").references(() => tedis.id, { onDelete: "cascade" }),

		skillId: text("skill_id")
			.notNull()
			.references((): AnySQLiteColumn => skillEntries.id, {
				onDelete: "cascade",
			}),

		// skill_runs.id for workflow runs; a generated event id for muscle/direct
		// usages. Failing runs are retrievable by (skill_id, outcome='failure').
		runId: text("run_id").notNull(),
		executionEpoch: integer("execution_epoch").notNull().default(0),

		source: text("source", { enum: SKILL_USAGE_SOURCES }).notNull(),
		outcome: text("outcome", { enum: SKILL_USAGE_OUTCOMES }).notNull(),
		error: text("error"),

		startedAt: text("started_at"),
		finishedAt: text("finished_at"),
		durationMs: integer("duration_ms"),

		// Always written as an ISO-8601 string by recordSkillUsageEvent so
		// time-window comparisons against ISO bounds are safe.
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_skill_usage_events_run").on(
			table.runId,
			table.executionEpoch,
		),
		index("idx_skill_usage_events_skill_outcome").on(
			table.skillId,
			table.outcome,
		),
		index("idx_skill_usage_events_tedi_created").on(
			table.tediId,
			table.createdAt,
		),
		index("idx_skill_usage_events_org_created").on(
			table.organizationId,
			table.createdAt,
		),
		// Standalone created_at for the retention sweep (WHERE created_at < cutoff).
		index("idx_skill_usage_events_created").on(table.createdAt),
	],
);

export type SkillUsageEvent = typeof skillUsageEvents.$inferSelect;
export type NewSkillUsageEvent = typeof skillUsageEvents.$inferInsert;

// ============================================================================
// Tedi Muscle Memory — Muscle memory registry
// ============================================================================

export const MUSCLE_MEMORY_KINDS = [
	"action_template",
	"correction_hook",
	"project_prime",
] as const;

export type MuscleMemoryKind = (typeof MUSCLE_MEMORY_KINDS)[number];

export const MUSCLE_MEMORY_ORIGINS = [
	"manual",
	"crystallized",
	"from_skill",
	"from_correction",
] as const;

export type MuscleMemoryOrigin = (typeof MUSCLE_MEMORY_ORIGINS)[number];

export const tediMuscleMemory = sqliteTable(
	"tedi_muscle_memory",
	{
		id: text("id").primaryKey(),

		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),

		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		kind: text("kind", { enum: MUSCLE_KIND }).notNull(),

		name: text("name").notNull(),
		description: text("description"),

		// R2 path relative to tedi workspace
		r2Path: text("r2_path"),

		// Usage stats
		usageCount: integer("usage_count").notNull().default(0),
		successCount: integer("success_count").notNull().default(0),
		failureCount: integer("failure_count").notNull().default(0),
		lastUsedAt: text("last_used_at"),

		// Origin tracking
		origin: text("origin", { enum: MUSCLE_ORIGIN }).notNull(),

		// MetaClaw-style skill versioning — auto-increments on upsert (same tediId + name)
		version: integer("version").notNull().default(1),

		sourceSkillId: text("source_skill_id").references(() => skillEntries.id, {
			onDelete: "set null",
		}),

		// Stored procedural code; persistence does not execute it.
		codeModule: text("code_module"),

		// Caller-declared namespaces. Registration requires a nonempty list when
		// codeModule is present. Tedi prompt hydration excludes executable entries
		// without an explicit list; persistence does not validate live capabilities.
		allowedNamespaces: text("allowed_namespaces", { mode: "json" }).$type<
			string[]
		>(),

		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_muscle_memory_org").on(table.organizationId),
		index("idx_muscle_memory_kind").on(table.kind),
		index("idx_muscle_memory_origin").on(table.origin),
		index("idx_muscle_memory_source_skill").on(table.sourceSkillId),
		index("idx_muscle_memory_tedi_name").on(table.tediId, table.name),
	],
);

// ============================================================================
// Inferred Types
// ============================================================================

export type KnowledgeEntry = typeof knowledgeEntries.$inferSelect;
export type NewKnowledgeEntry = typeof knowledgeEntries.$inferInsert;

export type SkillEntry = typeof skillEntries.$inferSelect;
export type NewSkillEntry = typeof skillEntries.$inferInsert;

// ============================================================================
// Skill Schedules — manifest-owned workflow firing projection
// ============================================================================

export const skillSchedules = sqliteTable(
	"skill_schedules",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		skillId: text("skill_id")
			.notNull()
			.references(() => skillEntries.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		cron: text("cron").notNull(),
		params: text("params", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull(),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		nextFireAt: text("next_fire_at").notNull(),
		lastFireAt: text("last_fire_at"),
		lastRunId: text("last_run_id"),
		lastError: text("last_error"),
		lastBudgetBlockedAt: text("last_budget_blocked_at"),
		lastBudgetBlockedReason: text("last_budget_blocked_reason"),
		lastBudgetResetAt: text("last_budget_reset_at"),
		lastBudgetAdmissionClass: text("last_budget_admission_class").$type<
			"background" | "governed_learning"
		>(),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_skill_schedules_skill").on(table.skillId),
		index("idx_skill_schedules_due").on(table.enabled, table.nextFireAt),
		index("idx_skill_schedules_org").on(table.organizationId),
		index("idx_skill_schedules_tedi").on(table.tediId),
	],
);

export type SkillSchedule = typeof skillSchedules.$inferSelect;
export type NewSkillSchedule = typeof skillSchedules.$inferInsert;

export type TediMuscleMemoryItem = typeof tediMuscleMemory.$inferSelect;
export type NewTediMuscleMemoryItem = typeof tediMuscleMemory.$inferInsert;

// ============================================================================
// Skill Runs — Workflow execution tracking
// ============================================================================

export const SKILL_RUN_STATUSES = [
	"queued",
	"running",
	"paused",
	"completed",
	"failed",
	"canceled",
] as const;

export type SkillRunStatus = (typeof SKILL_RUN_STATUSES)[number];

export const skillRuns = sqliteTable(
	"skill_runs",
	{
		id: text("id").primaryKey(),

		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		skillId: text("skill_id")
			.notNull()
			.references(() => skillEntries.id, { onDelete: "cascade" }),

		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),

		// Cloudflare Workflow instance ID returned by the engine
		workflowInstanceId: text("workflow_instance_id").notNull(),

		// Monotonic operator-restart epoch. Epoch 0 is the original execution;
		// every restart command reserves a value before the engine call so an
		// ambiguous delivery can never collide with a later execution's evidence.
		executionEpoch: integer("execution_epoch").notNull().default(0),
		restartRequestedAt: text("restart_requested_at"),
		restartCommandId: text("restart_command_id"),
		// Permanent tombstone for a Cloudflare Workflow instance that can no
		// longer be safely entered or restarted (operator-aborted ambiguity or
		// run revocation). This lives on the audit row so artifact revocation
		// cannot remove the execution fence.
		workflowRetiredAt: text("workflow_retired_at"),
		// Workflow binding namespace used for dispatch and reconciliation.
		runtimeEnvironment: text("runtime_environment", {
			enum: ["development", "staging", "production"],
		}).notNull(),
		lastReconciledAt: text("last_reconciled_at"),

		status: text("status", {
			enum: ["queued", "running", "paused", "completed", "failed", "canceled"],
		})
			.notNull()
			.default("queued"),

		// Input params at run start
		params: text("params", { mode: "json" }).$type<Record<string, JsonValue>>(),

		// Output payload (when completed)
		result: text("result", { mode: "json" }).$type<JsonValue>(),

		// Error message + stack (when failed)
		error: text("error"),

		/** Canonical source bindings admitted by API; workflow params cannot establish credential authority. */
		resourceAccessEnvelope: text("resource_access_envelope", {
			mode: "json",
		}).$type<OsDerivedAccessEnvelope>(),
		// Snapshot of declared capabilities at run time, for audit
		capabilityManifest: text("capability_manifest", {
			mode: "json",
		}).$type<Record<string, JsonValue>>(),

		// Best-effort cost/effort rollup computed from durable step evidence at
		// the first terminal observation (completed/failed). Null until then.
		// Shape (schemaVersion 1): { schemaVersion, steps, attempts, retries,
		// toolCalls, toolCallsByNamespace, stepDurationMs, wallMs }.
		costSummary: text("cost_summary", {
			mode: "json",
		}).$type<SkillRunCostSummary>(),

		// G0 — Run-pinned workflow source. Captured at dispatch time so the
		// run loads the exact code it was started with, even if the skill is
		// revised mid-run (notably across step.waitForEvent hibernations).
		// The current SkillWorkflow factory requires workflow_source. Missing
		// snapshots are invalid executable runs; there is no live skill fallback.
		workflowSource: text("workflow_source"),
		skillDoc: text("skill_doc"),
		skillRevision: integer("skill_revision"),
		skillSlug: text("skill_slug"),

		startedAt: text("started_at").default(sql`(CURRENT_TIMESTAMP)`),
		completedAt: text("completed_at"),
		pausedAt: text("paused_at"),

		// `tediId` or descope user id of invoker
		createdBy: text("created_by"),
		/** Work Item admitted with this run and propagated to every MCP call. */
		workItemId: text("work_item_id"),
		/** Chat turn that dispatched this run; attribution still requires runtime evidence. */
		originTediRunId: text("origin_tedi_run_id"),
	},
	(table) => [
		index("idx_skill_runs_org_status").on(table.organizationId, table.status),
		index("idx_skill_runs_skill").on(table.skillId),
		index("idx_skill_runs_tedi_started").on(table.tediId, table.startedAt),
		index("idx_skill_runs_reconcile").on(
			table.runtimeEnvironment,
			table.lastReconciledAt,
		),
		uniqueIndex("uniq_skill_runs_workflow_instance").on(
			table.workflowInstanceId,
		),
	],
);

export type SkillRun = typeof skillRuns.$inferSelect;
export type NewSkillRun = typeof skillRuns.$inferInsert;

/**
 * Short-lived admission fence for callers that omitted an explicit runId or
 * idempotency key.
 *
 * This row intentionally has no FK to skill_runs: the fence must be claimed
 * before the canonical run row is inserted so concurrent requests cannot both
 * cross into Workflow engine creation. A creator that dies between those two
 * writes leaves only a bounded fence which may be replaced after expires_at.
 */
export const skillRunAdmissionDedup = sqliteTable(
	"skill_run_admission_dedup",
	{
		fingerprint: text("fingerprint").primaryKey(),
		runId: text("run_id").notNull(),
		expiresAt: text("expires_at").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_skill_run_admission_dedup_expires").on(table.expiresAt),
		index("idx_skill_run_admission_dedup_run").on(table.runId),
	],
);

export type SkillRunAdmissionDedup = typeof skillRunAdmissionDedup.$inferSelect;
export type NewSkillRunAdmissionDedup =
	typeof skillRunAdmissionDedup.$inferInsert;

// ----------------------------------------------------------------------------
// SKILL RUN ARTIFACTS
// ----------------------------------------------------------------------------
//
// Per-step artifacts produced by an executable skill workflow. Resolved at
// `skill://{slug}/runs/{runId}/{path}` MCP resource URIs by
// apps/mcp's handleSkillFile() — the same URI grammar memory facts use as
// `source = ...` keys, so brain feedback compounds traceably.
//
// Inline payloads ≤ INLINE_THRESHOLD_BYTES live in `content_inline` (TEXT).
// Larger payloads spill to R2 with `content_r2_key` set; `content_inline` is
// then null. `mime_type` defaults to `application/json` (most step.do return
// values are JSON). The (run_id, path) UNIQUE index lets summary records
// upsert idempotently; durable step evidence encodes execution epoch, occurrence,
// and attempt in the path so retries and explicit restarts do not collide.
export const skillRunArtifacts = sqliteTable(
	"skill_run_artifacts",
	{
		id: text("id").primaryKey(),
		runId: text("run_id")
			.notNull()
			.references(() => skillRuns.id, { onDelete: "cascade" }),
		path: text("path").notNull(),
		mimeType: text("mime_type").notNull().default("application/json"),
		sizeBytes: integer("size_bytes").notNull().default(0),
		contentInline: text("content_inline"),
		contentR2Key: text("content_r2_key"),
		sha256: text("sha256"),
		attempt: integer("attempt").notNull().default(1),
		outcome: text("outcome", {
			enum: ["pending", "success", "failure"],
		})
			.notNull()
			.default("success"),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_skill_run_artifacts_path").on(table.runId, table.path),
	],
);

export type SkillRunArtifact = typeof skillRunArtifacts.$inferSelect;
export type NewSkillRunArtifact = typeof skillRunArtifacts.$inferInsert;
