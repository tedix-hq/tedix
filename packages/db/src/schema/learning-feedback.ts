/**
 * Product interaction feedback and learning attribution ledger.
 *
 * This is deliberately separate from `memory_feedback`: memory feedback tunes
 * fact confidence, while this ledger preserves the raw user/product signal,
 * the scope it is allowed to influence, the component changed because of it,
 * and the baseline/follow-up proof that the change helped.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	LEARNING_CHANGE_KINDS,
	LEARNING_IMPROVEMENT_STATUSES,
	LEARNING_INTERACTION_KINDS,
	LEARNING_MEASUREMENT_WINDOWS,
	LEARNING_PROMOTION_ROUTES,
	LEARNING_SCOPE_KINDS,
	LEARNING_SIGNAL_CLASSES,
	LEARNING_SUBJECT_KINDS,
} from "@tedix/api-contract/schemas/learning-feedback";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { tedis } from "./tedis";

export const learningInteractionEvents = sqliteTable(
	"learning_interaction_events",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		actorType: text("actor_type", {
			enum: ["user", "tedi", "service", "api_key", "unknown"],
		}).notNull(),
		actorId: text("actor_id"),
		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "set null",
		}),
		clientEventId: text("client_event_id").notNull(),
		signalClass: text("signal_class", { enum: LEARNING_SIGNAL_CLASSES })
			.notNull()
			.default("quality"),
		eventKind: text("event_kind", {
			enum: LEARNING_INTERACTION_KINDS,
		}).notNull(),
		scopeKind: text("scope_kind", { enum: LEARNING_SCOPE_KINDS }).notNull(),
		scopeId: text("scope_id").notNull(),
		issueKey: text("issue_key"),
		surface: text("surface").notNull(),
		targetType: text("target_type"),
		targetId: text("target_id"),
		threadId: text("thread_id"),
		runId: text("run_id"),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		occurredAt: text("occurred_at").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_learning_event_org_client").on(
			table.organizationId,
			table.clientEventId,
		),
		index("idx_learning_event_org_occurred").on(
			table.organizationId,
			table.occurredAt,
		),
		index("idx_learning_event_tedi_occurred").on(
			table.tediId,
			table.occurredAt,
		),
		index("idx_learning_event_scope").on(
			table.organizationId,
			table.scopeKind,
			table.scopeId,
		),
		index("idx_learning_event_issue").on(table.organizationId, table.issueKey),
		// Standalone created_at for the retention sweep (WHERE created_at < cutoff).
		index("idx_learning_interaction_events_created").on(table.createdAt),
	],
);

export const learningFeedbackAttributions = sqliteTable(
	"learning_feedback_attributions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		clientAttributionId: text("client_attribution_id").notNull(),
		feedbackEventId: text("feedback_event_id")
			.notNull()
			.references(() => learningInteractionEvents.id, { onDelete: "cascade" }),
		subjectKind: text("subject_kind", {
			enum: LEARNING_SUBJECT_KINDS,
		}).notNull(),
		subjectId: text("subject_id").notNull(),
		changeKind: text("change_kind", { enum: LEARNING_CHANGE_KINDS }).notNull(),
		rationale: text("rationale"),
		evidenceRefs: text("evidence_refs", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		occurredAt: text("occurred_at").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_learning_attr_org_client_event").on(
			table.organizationId,
			table.clientAttributionId,
			table.feedbackEventId,
		),
		index("idx_learning_attr_subject").on(
			table.organizationId,
			table.subjectKind,
			table.subjectId,
		),
		index("idx_learning_attr_event").on(table.feedbackEventId),
	],
);

export const learningFeedbackMeasurements = sqliteTable(
	"learning_feedback_measurements",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		clientMeasurementId: text("client_measurement_id").notNull(),
		attributionId: text("attribution_id")
			.notNull()
			.references(() => learningFeedbackAttributions.id, {
				onDelete: "cascade",
			}),
		windowKind: text("window_kind", {
			enum: LEARNING_MEASUREMENT_WINDOWS,
		}).notNull(),
		windowStart: text("window_start").notNull(),
		windowEnd: text("window_end").notNull(),
		opportunityCount: integer("opportunity_count").notNull(),
		recurrenceCount: integer("recurrence_count").notNull(),
		successCount: integer("success_count").notNull().default(0),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_learning_measure_org_client").on(
			table.organizationId,
			table.clientMeasurementId,
		),
		index("idx_learning_measure_attr_window").on(
			table.attributionId,
			table.windowKind,
			table.windowEnd,
		),
	],
);

export const learningImprovementProposals = sqliteTable(
	"learning_improvement_proposals",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		clientProposalId: text("client_proposal_id").notNull(),
		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "set null",
		}),
		scopeKind: text("scope_kind", { enum: LEARNING_SCOPE_KINDS }).notNull(),
		scopeId: text("scope_id").notNull(),
		issueKey: text("issue_key").notNull(),
		subjectKind: text("subject_kind", {
			enum: LEARNING_SUBJECT_KINDS,
		}).notNull(),
		subjectId: text("subject_id").notNull(),
		status: text("status", {
			enum: LEARNING_IMPROVEMENT_STATUSES,
		})
			.notNull()
			.default("proposed"),
		promotionRoute: text("promotion_route", {
			enum: LEARNING_PROMOTION_ROUTES,
		}).notNull(),
		recommendation: text("recommendation").notNull(),
		evidenceEventIds: text("evidence_event_ids", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		attributionId: text("attribution_id").references(
			() => learningFeedbackAttributions.id,
			{ onDelete: "set null" },
		),
		baselineMeasurementId: text("baseline_measurement_id").references(
			() => learningFeedbackMeasurements.id,
			{ onDelete: "set null" },
		),
		followupMeasurementId: text("followup_measurement_id").references(
			() => learningFeedbackMeasurements.id,
			{ onDelete: "set null" },
		),
		// Kept for additive D1 compatibility with the first operator schema. This
		// field is no longer accepted from callers or treated as certification.
		certificationEvidenceRefs: text("certification_evidence_refs", {
			mode: "json",
		})
			.$type<string[]>()
			.notNull(),
		evaluationNote: text("evaluation_note"),
		reviewReason: text("review_reason"),
		proposedByType: text("proposed_by_type", {
			enum: ["user", "tedi", "service", "api_key", "unknown"],
		}).notNull(),
		proposedById: text("proposed_by_id"),
		reviewedById: text("reviewed_by_id"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		reviewedAt: text("reviewed_at"),
	},
	(table) => [
		uniqueIndex("uniq_learning_proposal_org_client").on(
			table.organizationId,
			table.clientProposalId,
		),
		index("idx_learning_proposal_org_status_updated").on(
			table.organizationId,
			table.status,
			table.updatedAt,
		),
		index("idx_learning_proposal_tedi_issue").on(table.tediId, table.issueKey),
		index("idx_learning_proposal_subject").on(
			table.organizationId,
			table.subjectKind,
			table.subjectId,
		),
	],
);

export type LearningInteractionEventRow =
	typeof learningInteractionEvents.$inferSelect;
export type NewLearningInteractionEvent =
	typeof learningInteractionEvents.$inferInsert;
export type LearningFeedbackAttributionRow =
	typeof learningFeedbackAttributions.$inferSelect;
export type NewLearningFeedbackAttribution =
	typeof learningFeedbackAttributions.$inferInsert;
export type LearningFeedbackMeasurementRow =
	typeof learningFeedbackMeasurements.$inferSelect;
export type NewLearningFeedbackMeasurement =
	typeof learningFeedbackMeasurements.$inferInsert;
export type LearningImprovementProposalRow =
	typeof learningImprovementProposals.$inferSelect;
export type NewLearningImprovementProposal =
	typeof learningImprovementProposals.$inferInsert;
