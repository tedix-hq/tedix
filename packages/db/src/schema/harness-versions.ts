/**
 * Harness Versioning + Trace Bundle Schema (D1)
 *
 * Storage for harness versions and trace bundles (`docs/cognition/harness.md`):
 *
 * - `harness_versions` — one row per `HarnessVersion` (content-hashed snapshot
 *   of a tedi's active harness config). The runtime loads whichever row is
 *   `active`; lineage is `parent_version_id` + `created_at`. `components`
 *   stored as a JSON record (component-name → contentHash|version).
 * - `trace_bundles` — one row per work episode (one `runId`). References
 *   canonical rows by id (event/rationale/artifact ids) — duplicates nothing.
 *
 * The api-contract `HarnessVersion` / `TraceBundle` zod schemas
 * (`@tedix/api-contract/schemas/harness-version`) are the canonical shapes;
 * these tables persist them. Created through the versioned D1 migration ledger.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { HarnessEvalRunReport } from "@tedix/api-contract/schemas/harness-version";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	real,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { tedis } from "./tedis";

export const HARNESS_PROMOTION_STATUS_VALUES = [
	"proposed",
	"evaluated",
	"canary",
	"active",
	"promoted",
	"rejected",
	"rolled_back",
] as const;

export const TRACE_BUNDLE_OUTCOME_VALUES = [
	"success",
	"partial",
	"failure",
	"escalated",
	"aborted",
	"unknown",
] as const;

export const HARNESS_SUBJECT_KIND_VALUES = ["tedi", "kernel"] as const;

export type HarnessPromotionStatusDb =
	(typeof HARNESS_PROMOTION_STATUS_VALUES)[number];
export type TraceBundleOutcomeDb = (typeof TRACE_BUNDLE_OUTCOME_VALUES)[number];
export type HarnessSubjectKindDb = (typeof HARNESS_SUBJECT_KIND_VALUES)[number];

export const harnessVersions = sqliteTable(
	"harness_versions",
	{
		id: text("id").primaryKey(),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		orgId: text("org_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		/** Monotonic int or semver, as a string — caller picks the scheme. */
		version: text("version").notNull(),
		/** Runtime body class this version targets, if pinned (isolate/container). */
		runtimeKind: text("runtime_kind"),
		/** component-name → content-hash | version string (open record). */
		components: text("components", { mode: "json" })
			.$type<Record<string, string>>()
			.notNull()
			.default({}),
		/** Previous version this was forked/bumped from — lineage for diff/rollback. */
		parentVersionId: text("parent_version_id"),
		/** Why the version was bumped ("directive promoted", "model swap"). */
		reason: text("reason"),
		/** Artifacts commit SHA for the replayable source tree. */
		artifactCommitSha: text("artifact_commit_sha"),
		/** Trace-safety policy in force for trace writers under this version. */
		traceSafetyPolicyId: text("trace_safety_policy_id"),
		promotionStatus: text("promotion_status", {
			enum: HARNESS_PROMOTION_STATUS_VALUES,
		})
			.notNull()
			.default("proposed"),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_harness_versions_tedi_created").on(
			table.tediId,
			table.createdAt,
		),
		// Per-tedi active-pointer lookup: filter by (tedi_id, promotion_status).
		index("idx_harness_versions_tedi_status").on(
			table.tediId,
			table.promotionStatus,
		),
		index("idx_harness_versions_org").on(table.orgId),
	],
);

/**
 * Forward subject-keyed harness version ledger for actors that are not tedis.
 *
 * `harness_versions` remains the live tedi-body table today. This table carries
 * the same version envelope behind an explicit `(subject_kind, subject_id)` key
 * so the Home Kernel can be versioned without fabricating a tedi row. For kernel
 * rows, `subject_id = kernel:{orgId}` and `tedi_id` is null.
 */
export const harnessSubjectVersions = sqliteTable(
	"harness_subject_versions",
	{
		id: text("id").primaryKey(),
		subjectKind: text("subject_kind", {
			enum: HARNESS_SUBJECT_KIND_VALUES,
		}).notNull(),
		subjectId: text("subject_id").notNull(),
		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "cascade",
		}),
		orgId: text("org_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		version: text("version").notNull(),
		runtimeKind: text("runtime_kind"),
		components: text("components", { mode: "json" })
			.$type<Record<string, string>>()
			.notNull()
			.default({}),
		parentVersionId: text("parent_version_id"),
		reason: text("reason"),
		artifactCommitSha: text("artifact_commit_sha"),
		traceSafetyPolicyId: text("trace_safety_policy_id"),
		promotionStatus: text("promotion_status", {
			enum: HARNESS_PROMOTION_STATUS_VALUES,
		})
			.notNull()
			.default("proposed"),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_harness_subject_versions_subject_created").on(
			table.subjectKind,
			table.subjectId,
			table.createdAt,
		),
		index("idx_harness_subject_versions_subject_status").on(
			table.subjectKind,
			table.subjectId,
			table.promotionStatus,
		),
		index("idx_harness_subject_versions_org").on(table.orgId),
		index("idx_harness_subject_versions_tedi").on(table.tediId),
	],
);

export const traceBundles = sqliteTable(
	"trace_bundles",
	{
		id: text("id").primaryKey(),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		orgId: text("org_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		conversationId: text("conversation_id"),
		runId: text("run_id").notNull(),
		/** Which harness produced this episode — the join key for eval/attribution. */
		harnessVersionId: text("harness_version_id").notNull(),
		/** Refs into tedi_runtime_events (curated, ordered subset for this episode). */
		eventIds: text("event_ids", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		/** Refs into the rationale journal (decisions made during this episode). */
		rationaleRecordIds: text("rationale_record_ids", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		/** Refs into tedi_artifacts (files/widgets created during this episode). */
		artifactIds: text("artifact_ids", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		/** Optional link to the eval result scored against this bundle. */
		evalResultId: text("eval_result_id"),
		/** Artifacts/R2 URI for the replayable raw evidence folder (redacted). */
		bundleUri: text("bundle_uri"),
		/** Human/navigation summary — NOT a replacement for raw trace retention. */
		summary: text("summary"),
		outcome: text("outcome", { enum: TRACE_BUNDLE_OUTCOME_VALUES }),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		// Primary access pattern: all bundles for one run / one tedi.
		index("idx_trace_bundles_tedi_run").on(table.tediId, table.runId),
		index("idx_trace_bundles_tedi_created").on(table.tediId, table.createdAt),
		// Before/after comparison: all bundles produced by one harness version.
		index("idx_trace_bundles_version").on(table.harnessVersionId),
		index("idx_trace_bundles_org").on(table.orgId),
		// Standalone created_at for the retention sweep (WHERE created_at < cutoff).
		index("idx_trace_bundles_created").on(table.createdAt),
	],
);

/**
 * Subject-keyed TraceBundle ledger for non-tedi actors such as the Home Kernel.
 *
 * `trace_bundles` remains the live tedi-body table today and keeps its
 * `tedi_id NOT NULL` invariant. This table carries the same evidence envelope
 * behind an explicit `(subject_kind, subject_id)` key so kernel/router episodes
 * can be evaluated without inventing a tedi identity.
 */
export const harnessSubjectTraceBundles = sqliteTable(
	"harness_subject_trace_bundles",
	{
		id: text("id").primaryKey(),
		subjectKind: text("subject_kind", {
			enum: HARNESS_SUBJECT_KIND_VALUES,
		}).notNull(),
		subjectId: text("subject_id").notNull(),
		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "cascade",
		}),
		orgId: text("org_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		conversationId: text("conversation_id"),
		runId: text("run_id").notNull(),
		harnessVersionId: text("harness_version_id").notNull(),
		eventIds: text("event_ids", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		rationaleRecordIds: text("rationale_record_ids", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		artifactIds: text("artifact_ids", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		evalResultId: text("eval_result_id"),
		bundleUri: text("bundle_uri"),
		summary: text("summary"),
		outcome: text("outcome", { enum: TRACE_BUNDLE_OUTCOME_VALUES }),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_harness_subject_trace_bundles_subject_run").on(
			table.subjectKind,
			table.subjectId,
			table.runId,
		),
		index("idx_harness_subject_trace_bundles_subject_created").on(
			table.subjectKind,
			table.subjectId,
			table.createdAt,
		),
		index("idx_harness_subject_trace_bundles_version").on(
			table.harnessVersionId,
		),
		index("idx_harness_subject_trace_bundles_org").on(table.orgId),
		index("idx_harness_subject_trace_bundles_tedi").on(table.tediId),
	],
);

/**
 * `harness_eval_results` — the leaf RECORD layer of the harness eval ledger.
 *
 * One row per scored evaluation of a harness version (docs/cognition/harness.md §
 * "Harness Evaluation Ledger"). Persists the api-contract `HarnessEvalResult`
 * shape. `gates` is a per-protected-metric pass map; `passed` is the AND over
 * the required gates the eval runner enforced. This table is the substrate the
 * promotion gate reads (`evalGateForCertification`) when deciding whether a
 * harness version may advance toward `certified` — it is NOT the eval runner.
 *
 * Writes are conflict-do-nothing on `id` so a retried emission is idempotent.
 */
export const harnessEvalResults = sqliteTable(
	"harness_eval_results",
	{
		id: text("id").primaryKey(),
		harnessVersionId: text("harness_version_id").notNull(),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		orgId: text("org_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		/** Aggregate score (scheme-defined; higher is better unless gates say otherwise). */
		score: real("score").notNull(),
		/** Per-metric pass/fail map — protected metrics that gate promotion. */
		gates: text("gates", { mode: "json" })
			.$type<Record<string, boolean>>()
			.notNull()
			.default({}),
		/** AND over required gates the eval runner enforced. */
		passed: integer("passed", { mode: "boolean" }).notNull().default(false),
		/** Which eval lane produced this (search/validation/locked-test/canary). */
		lane: text("lane"),
		/** Task set this was scored against. */
		taskSetId: text("task_set_id"),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		// Before/after / promotion-gate read: all evals for one harness version.
		index("idx_harness_eval_results_version").on(table.harnessVersionId),
		// Per-tedi recency feed for Tedix OS.
		index("idx_harness_eval_results_tedi_created").on(
			table.tediId,
			table.createdAt,
		),
		index("idx_harness_eval_results_org").on(table.orgId),
		// Standalone created_at for the retention sweep (WHERE created_at < cutoff).
		index("idx_harness_eval_results_created").on(table.createdAt),
	],
);

/**
 * One execution of a task set against one harness version on one lane — the
 * grouping an eval runner produces. N
 * `harness_eval_results` roll up into one run; `eligible` is the run-level gate
 * (did the lane pass). The promotion workflow reads these + the per-version eval
 * summary. See `@tedix/api-contract` `HarnessEvalRunSchema`.
 */
export const harnessEvalRuns = sqliteTable(
	"harness_eval_runs",
	{
		id: text("id").primaryKey(),
		harnessVersionId: text("harness_version_id").notNull(),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		orgId: text("org_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		/** Lane this run scored (search/validation/locked-test/canary). */
		lane: text("lane").notNull(),
		taskSetId: text("task_set_id").notNull(),
		total: integer("total").notNull().default(0),
		passed: integer("passed").notNull().default(0),
		failed: integer("failed").notNull().default(0),
		meanScore: real("mean_score").notNull().default(0),
		/** Run-level gate: did the lane pass (no failing task)? */
		eligible: integer("eligible", { mode: "boolean" }).notNull().default(false),
		report: text("report", { mode: "json" }).$type<HarnessEvalRunReport>(),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_harness_eval_runs_version").on(table.harnessVersionId),
		index("idx_harness_eval_runs_tedi_created").on(
			table.tediId,
			table.createdAt,
		),
		index("idx_harness_eval_runs_org").on(table.orgId),
		// Standalone created_at for the retention sweep (WHERE created_at < cutoff).
		index("idx_harness_eval_runs_created").on(table.createdAt),
	],
);

export type HarnessVersionRow = typeof harnessVersions.$inferSelect;
export type NewHarnessVersionRow = typeof harnessVersions.$inferInsert;
export type HarnessSubjectVersionRow =
	typeof harnessSubjectVersions.$inferSelect;
export type NewHarnessSubjectVersionRow =
	typeof harnessSubjectVersions.$inferInsert;
export type TraceBundleRow = typeof traceBundles.$inferSelect;
export type NewTraceBundleRow = typeof traceBundles.$inferInsert;
export type HarnessSubjectTraceBundleRow =
	typeof harnessSubjectTraceBundles.$inferSelect;
export type NewHarnessSubjectTraceBundleRow =
	typeof harnessSubjectTraceBundles.$inferInsert;
export type HarnessEvalResultRow = typeof harnessEvalResults.$inferSelect;
export type NewHarnessEvalResultRow = typeof harnessEvalResults.$inferInsert;
export type HarnessEvalRunRow = typeof harnessEvalRuns.$inferSelect;
export type NewHarnessEvalRunRow = typeof harnessEvalRuns.$inferInsert;

// ============================================================================
// Subject-keyed eval result + eval run tables (kernel / non-tedi actors)
// ============================================================================

/**
 * `harness_subject_eval_results` — the leaf RECORD layer for non-tedi
 * harness subjects (kernel, future actor types).
 *
 * Mirrors `harness_eval_results` column-for-column except:
 * - Uses `(subject_kind, subject_id)` instead of `tedi_id NOT NULL`.
 * - `tedi_id` is nullable with NO FK (kernel rows set it null).
 * - `harness_version_id` references a `harness_subject_versions.id` (loose ref,
 *   no FK constraint).
 * - `org_id` keeps its nullable FK to organizations.
 *
 * Writes are conflict-do-nothing on `id`; callers pass a stable deterministic
 * id (e.g. `kser:{harnessVersionId}:{runId}`) so re-runs are idempotent.
 */
export const harnessSubjectEvalResults = sqliteTable(
	"harness_subject_eval_results",
	{
		id: text("id").primaryKey(),
		subjectKind: text("subject_kind", {
			enum: HARNESS_SUBJECT_KIND_VALUES,
		}).notNull(),
		subjectId: text("subject_id").notNull(),
		/** Nullable — null for kernel rows which have no tedi identity. No FK. */
		tediId: text("tedi_id"),
		orgId: text("org_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		/** References a harness_subject_versions.id (loose — no FK constraint). */
		harnessVersionId: text("harness_version_id").notNull(),
		score: real("score").notNull(),
		gates: text("gates", { mode: "json" })
			.$type<Record<string, boolean>>()
			.notNull()
			.default({}),
		passed: integer("passed", { mode: "boolean" }).notNull().default(false),
		lane: text("lane"),
		taskSetId: text("task_set_id"),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_harness_subject_eval_results_subject").on(
			table.subjectKind,
			table.subjectId,
			table.createdAt,
		),
		index("idx_harness_subject_eval_results_org").on(table.orgId),
		index("idx_harness_subject_eval_results_version").on(
			table.harnessVersionId,
		),
		index("idx_harness_subject_eval_results_created").on(table.createdAt),
	],
);

/**
 * `harness_subject_eval_runs` — one execution of a task set against one
 * subject harness version on one lane.
 *
 * Mirrors `harness_eval_runs` column-for-column with the same subject-keyed
 * substitutions as `harness_subject_eval_results` above.
 */
export const harnessSubjectEvalRuns = sqliteTable(
	"harness_subject_eval_runs",
	{
		id: text("id").primaryKey(),
		subjectKind: text("subject_kind", {
			enum: HARNESS_SUBJECT_KIND_VALUES,
		}).notNull(),
		subjectId: text("subject_id").notNull(),
		/** Nullable — null for kernel rows. No FK. */
		tediId: text("tedi_id"),
		orgId: text("org_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		/** References a harness_subject_versions.id (loose — no FK constraint). */
		harnessVersionId: text("harness_version_id").notNull(),
		lane: text("lane").notNull(),
		taskSetId: text("task_set_id").notNull(),
		total: integer("total").notNull().default(0),
		passed: integer("passed").notNull().default(0),
		failed: integer("failed").notNull().default(0),
		meanScore: real("mean_score").notNull().default(0),
		eligible: integer("eligible", { mode: "boolean" }).notNull().default(false),
		report: text("report", { mode: "json" }).$type<HarnessEvalRunReport>(),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_harness_subject_eval_runs_subject").on(
			table.subjectKind,
			table.subjectId,
			table.createdAt,
		),
		index("idx_harness_subject_eval_runs_org").on(table.orgId),
		index("idx_harness_subject_eval_runs_version").on(table.harnessVersionId),
		index("idx_harness_subject_eval_runs_created").on(table.createdAt),
	],
);

export type HarnessSubjectEvalResultRow =
	typeof harnessSubjectEvalResults.$inferSelect;
export type NewHarnessSubjectEvalResultRow =
	typeof harnessSubjectEvalResults.$inferInsert;
export type HarnessSubjectEvalRunRow =
	typeof harnessSubjectEvalRuns.$inferSelect;
export type NewHarnessSubjectEvalRunRow =
	typeof harnessSubjectEvalRuns.$inferInsert;
