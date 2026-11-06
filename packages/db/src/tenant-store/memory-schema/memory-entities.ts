// Workspace-local memory tables keep local foreign keys. Object scope guards
// replace references to organization and tedi records in the control plane.

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	type AnySQLiteColumn,
	check,
	index,
	integer,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { memoryFacts } from "./memory-graph";

import {
	MEMORY_ENTITY_TYPES,
	MEMORY_ENTITY_ACTOR_TYPES,
	MEMORY_ENTITY_RESOLUTION_OPERATIONS,
	type MemoryEntityResolutionInverse,
} from "../../schema/memory-entities";

export const memoryEntities = sqliteTable(
	"memory_entities",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		entityType: text("entity_type", { enum: MEMORY_ENTITY_TYPES }).notNull(),
		displayName: text("display_name").notNull(),
		normalizedName: text("normalized_name").notNull(),
		status: text("status", {
			enum: ["active", "merged", "deprecated"],
		})
			.notNull()
			.default("active"),
		mergedIntoEntityId: text("merged_into_entity_id").references(
			(): AnySQLiteColumn => memoryEntities.id,
			{ onDelete: "restrict" },
		),
		version: integer("version").notNull().default(0),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_memory_entity_org_id").on(table.organizationId, table.id),
		index("idx_memory_entity_candidate").on(
			table.organizationId,
			table.entityType,
			table.normalizedName,
			table.status,
		),
		index("idx_memory_entity_merge_target").on(
			table.organizationId,
			table.mergedIntoEntityId,
		),
		check(
			"chk_memory_entity_name",
			sql`length(trim(${table.displayName})) > 0 AND length(${table.normalizedName}) > 0`,
		),
		check("chk_memory_entity_version", sql`${table.version} >= 0`),
		check(
			"chk_memory_entity_merge_state",
			sql`(${table.status} = 'merged' AND ${table.mergedIntoEntityId} IS NOT NULL AND ${table.mergedIntoEntityId} != ${table.id}) OR (${table.status} != 'merged' AND ${table.mergedIntoEntityId} IS NULL)`,
		),
	],
);

export const memoryEntityMentions = sqliteTable(
	"memory_entity_mentions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		occurrenceKey: text("occurrence_key").notNull(),
		sourceFactId: text("source_fact_id").references(() => memoryFacts.id, {
			onDelete: "restrict",
		}),
		sourceUri: text("source_uri"),
		sourceContentHash: text("source_content_hash"),
		sourceSessionId: text("source_session_id"),
		sourceRunId: text("source_run_id"),
		surfaceForm: text("surface_form").notNull(),
		normalizedForm: text("normalized_form").notNull(),
		proposedType: text("proposed_type", {
			enum: MEMORY_ENTITY_TYPES,
		}).notNull(),
		charStart: integer("char_start"),
		charEnd: integer("char_end"),
		extractor: text("extractor").notNull(),
		extractorVersion: text("extractor_version").notNull(),
		modelId: text("model_id"),
		harnessVersionId: text("harness_version_id"),
		confidence: real("confidence").notNull(),
		evidence: text("evidence", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_memory_entity_mention_occurrence").on(
			table.organizationId,
			table.occurrenceKey,
		),
		index("idx_memory_entity_mention_source_fact").on(
			table.organizationId,
			table.sourceFactId,
		),
		index("idx_memory_entity_mention_candidate").on(
			table.organizationId,
			table.proposedType,
			table.normalizedForm,
			table.createdAt,
		),
		check(
			"chk_memory_entity_mention_surface",
			sql`length(trim(${table.surfaceForm})) > 0 AND length(${table.normalizedForm}) > 0`,
		),
		check(
			"chk_memory_entity_mention_confidence",
			sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
		),
		check(
			"chk_memory_entity_mention_span",
			sql`(${table.charStart} IS NULL AND ${table.charEnd} IS NULL) OR (${table.charStart} >= 0 AND ${table.charEnd} > ${table.charStart})`,
		),
	],
);

export const memoryEntityAliases = sqliteTable(
	"memory_entity_aliases",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		entityId: text("entity_id")
			.notNull()
			.references(() => memoryEntities.id, { onDelete: "restrict" }),
		surfaceForm: text("surface_form").notNull(),
		normalizedForm: text("normalized_form").notNull(),
		aliasKind: text("alias_kind", {
			enum: ["canonical", "acronym", "synonym", "former_name", "external_id"],
		}).notNull(),
		locale: text("locale").notNull().default("und"),
		confidence: real("confidence").notNull(),
		reviewStatus: text("review_status", {
			enum: ["pending", "confirmed", "rejected", "revoked"],
		})
			.notNull()
			.default("pending"),
		sourceMentionId: text("source_mention_id").references(
			() => memoryEntityMentions.id,
			{ onDelete: "restrict" },
		),
		validFrom: text("valid_from")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		validTo: text("valid_to"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_memory_entity_alias").on(
			table.organizationId,
			table.entityId,
			table.normalizedForm,
			table.locale,
		),
		index("idx_memory_entity_alias_lookup").on(
			table.organizationId,
			table.normalizedForm,
			table.reviewStatus,
		),
		check(
			"chk_memory_entity_alias_confidence",
			sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
		),
		check(
			"chk_memory_entity_alias_validity",
			sql`${table.validTo} IS NULL OR datetime(${table.validTo}) > datetime(${table.validFrom})`,
		),
	],
);

export const memoryEntityResolutionHeads = sqliteTable(
	"memory_entity_resolution_heads",
	{
		mentionId: text("mention_id")
			.primaryKey()
			.references(() => memoryEntityMentions.id, { onDelete: "cascade" }),
		organizationId: text("organization_id").notNull(),
		version: integer("version").notNull().default(0),
		currentResolutionId: text("current_resolution_id"),
		currentEntityId: text("current_entity_id").references(
			() => memoryEntities.id,
			{ onDelete: "restrict" },
		),
		lastDecisionId: text("last_decision_id"),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_memory_entity_head_org_mention").on(
			table.organizationId,
			table.mentionId,
		),
		index("idx_memory_entity_head_current").on(
			table.organizationId,
			table.currentEntityId,
		),
		check("chk_memory_entity_head_version", sql`${table.version} >= 0`),
		check(
			"chk_memory_entity_head_shape",
			sql`(${table.currentResolutionId} IS NULL AND ${table.currentEntityId} IS NULL AND ${table.lastDecisionId} IS NULL) OR (${table.currentResolutionId} IS NOT NULL AND ${table.lastDecisionId} IS NOT NULL)`,
		),
	],
);

export const memoryEntityResolutionDecisions = sqliteTable(
	"memory_entity_resolution_decisions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		clientProposalKey: text("client_proposal_key").notNull(),
		operation: text("operation", {
			enum: MEMORY_ENTITY_RESOLUTION_OPERATIONS,
		}).notNull(),
		mentionId: text("mention_id").references(() => memoryEntityMentions.id, {
			onDelete: "restrict",
		}),
		aliasId: text("alias_id").references(() => memoryEntityAliases.id, {
			onDelete: "restrict",
		}),
		sourceEntityId: text("source_entity_id").references(
			() => memoryEntities.id,
			{ onDelete: "restrict" },
		),
		targetEntityId: text("target_entity_id").references(
			() => memoryEntities.id,
			{ onDelete: "restrict" },
		),
		status: text("status", {
			enum: ["proposed", "accepted", "rejected"],
		})
			.notNull()
			.default("proposed"),
		confidence: real("confidence").notNull(),
		rationale: text("rationale").notNull(),
		evidence: text("evidence", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		proposedByType: text("proposed_by_type", {
			enum: MEMORY_ENTITY_ACTOR_TYPES,
		}).notNull(),
		proposedById: text("proposed_by_id").notNull(),
		reviewedByType: text("reviewed_by_type", {
			enum: MEMORY_ENTITY_ACTOR_TYPES,
		}),
		reviewedById: text("reviewed_by_id"),
		reviewRationale: text("review_rationale"),
		sourceRunId: text("source_run_id"),
		expectedMentionVersion: integer("expected_mention_version").notNull(),
		expectedHeadDecisionId: text("expected_head_decision_id"),
		expectedEntityVersion: integer("expected_entity_version"),
		version: integer("version").notNull().default(0),
		supersedesDecisionId: text("supersedes_decision_id").references(
			(): AnySQLiteColumn => memoryEntityResolutionDecisions.id,
			{ onDelete: "restrict" },
		),
		rollbackOfDecisionId: text("rollback_of_decision_id").references(
			(): AnySQLiteColumn => memoryEntityResolutionDecisions.id,
			{ onDelete: "restrict" },
		),
		inverse: text("inverse", { mode: "json" })
			.$type<MemoryEntityResolutionInverse>()
			.notNull(),
		proposedAt: text("proposed_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		reviewedAt: text("reviewed_at"),
		appliedAt: text("applied_at"),
	},
	(table) => [
		uniqueIndex("uniq_memory_entity_resolution_proposal").on(
			table.organizationId,
			table.clientProposalKey,
		),
		uniqueIndex("uniq_memory_entity_resolution_rollback").on(
			table.rollbackOfDecisionId,
		),
		index("idx_memory_entity_resolution_mention").on(
			table.organizationId,
			table.mentionId,
			table.proposedAt,
		),
		index("idx_memory_entity_resolution_status").on(
			table.organizationId,
			table.status,
			table.proposedAt,
		),
		check(
			"chk_memory_entity_resolution_confidence",
			sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
		),
		check(
			"chk_memory_entity_resolution_versions",
			sql`${table.expectedMentionVersion} >= 0 AND ${table.version} >= 0 AND (${table.expectedEntityVersion} IS NULL OR ${table.expectedEntityVersion} >= 0)`,
		),
		check(
			"chk_memory_entity_resolution_review_pair",
			sql`(${table.reviewedByType} IS NULL AND ${table.reviewedById} IS NULL) OR (${table.reviewedByType} IS NOT NULL AND ${table.reviewedById} IS NOT NULL)`,
		),
		check(
			"chk_memory_entity_resolution_independence",
			sql`${table.reviewedById} IS NULL OR ${table.reviewedByType} != ${table.proposedByType} OR ${table.reviewedById} != ${table.proposedById}`,
		),
		check(
			"chk_memory_entity_resolution_review_state",
			sql`(${table.status} = 'proposed' AND ${table.reviewedById} IS NULL AND ${table.reviewedAt} IS NULL AND ${table.appliedAt} IS NULL) OR (${table.status} = 'rejected' AND ${table.reviewedById} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.appliedAt} IS NULL) OR (${table.status} = 'accepted' AND ${table.reviewedById} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.appliedAt} IS NOT NULL)`,
		),
		check(
			"chk_memory_entity_resolution_operation_shape",
			sql`(${table.operation} IN ('link_mention', 'reassign_mention') AND ${table.mentionId} IS NOT NULL AND ${table.targetEntityId} IS NOT NULL AND ${table.rollbackOfDecisionId} IS NULL) OR (${table.operation} = 'rollback' AND ${table.mentionId} IS NOT NULL AND ${table.rollbackOfDecisionId} IS NOT NULL) OR (${table.operation} = 'link_alias' AND ${table.aliasId} IS NOT NULL AND ${table.targetEntityId} IS NOT NULL) OR (${table.operation} IN ('merge_entities', 'split_entity') AND ${table.sourceEntityId} IS NOT NULL)`,
		),
	],
);

export const memoryEntityResolutions = sqliteTable(
	"memory_entity_resolutions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		mentionId: text("mention_id")
			.notNull()
			.references(() => memoryEntityMentions.id, { onDelete: "restrict" }),
		entityId: text("entity_id").references(() => memoryEntities.id, {
			onDelete: "restrict",
		}),
		decisionId: text("decision_id")
			.notNull()
			.references(() => memoryEntityResolutionDecisions.id, {
				onDelete: "restrict",
			}),
		resolutionKind: text("resolution_kind", {
			enum: ["linked", "unresolved"],
		}).notNull(),
		status: text("status", { enum: ["active", "revoked"] })
			.notNull()
			.default("active"),
		confidence: real("confidence").notNull(),
		validFrom: text("valid_from").notNull(),
		validTo: text("valid_to"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_memory_entity_resolution_decision").on(table.decisionId),
		uniqueIndex("uniq_memory_entity_resolution_active")
			.on(table.organizationId, table.mentionId)
			.where(sql`${table.status} = 'active'`),
		index("idx_memory_entity_resolution_entity").on(
			table.organizationId,
			table.entityId,
			table.status,
		),
		index("idx_memory_entity_resolution_temporal").on(
			table.organizationId,
			table.mentionId,
			table.validFrom,
			table.validTo,
		),
		check(
			"chk_memory_entity_resolution_shape",
			sql`(${table.resolutionKind} = 'linked' AND ${table.entityId} IS NOT NULL) OR (${table.resolutionKind} = 'unresolved' AND ${table.entityId} IS NULL)`,
		),
		check(
			"chk_memory_entity_resolution_confidence",
			sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
		),
		check(
			"chk_memory_entity_resolution_validity",
			sql`(${table.status} = 'active' AND ${table.validTo} IS NULL) OR (${table.status} = 'revoked' AND ${table.validTo} IS NOT NULL AND datetime(${table.validTo}) >= datetime(${table.validFrom}))`,
		),
	],
);
