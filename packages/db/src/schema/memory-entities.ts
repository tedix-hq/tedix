/**
 * Governed entity identity for canonical D1 memory.
 *
 * Mentions are immutable extraction evidence. A mention becomes linked only
 * through a separately reviewed decision, and every accepted decision creates
 * a temporal resolution row. Neo4j may project these rows but never owns them.
 */

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
import { organizations } from "./organizations";

export const MEMORY_ENTITY_TYPES = [
	"person",
	"organization",
	"product",
	"service",
	"tool",
	"api",
	"repository",
	"document",
	"domain",
	"location",
	"event",
	"concept",
	"other",
] as const;
export type MemoryEntityType = (typeof MEMORY_ENTITY_TYPES)[number];

export const MEMORY_ENTITY_ACTOR_TYPES = [
	"user",
	"tedi",
	"service",
	"api_key",
	"external_agent",
	"system",
] as const;
export type MemoryEntityActorType = (typeof MEMORY_ENTITY_ACTOR_TYPES)[number];

export const MEMORY_ENTITY_RESOLUTION_OPERATIONS = [
	"link_mention",
	"reassign_mention",
	"link_alias",
	"merge_entities",
	"split_entity",
	"rollback",
] as const;
export type MemoryEntityResolutionOperation =
	(typeof MEMORY_ENTITY_RESOLUTION_OPERATIONS)[number];

export interface MemoryEntityResolutionInverse {
	entityId: string | null;
	resolutionId: string | null;
	confidence: number | null;
}

export const memoryEntities = sqliteTable(
	"memory_entities",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
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

/**
 * One immutable source occurrence. Corrections never rewrite this row; they
 * create a new resolution decision over it.
 */
export const memoryEntityMentions = sqliteTable(
	"memory_entity_mentions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
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
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
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

/**
 * Mutable CAS pointer is deliberately separate from the immutable mention.
 * Every accepted decision increments this version exactly once.
 */
export const memoryEntityResolutionHeads = sqliteTable(
	"memory_entity_resolution_heads",
	{
		mentionId: text("mention_id")
			.primaryKey()
			.references(() => memoryEntityMentions.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
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
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
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

/**
 * Temporal accepted state. `entityId = null` is an explicit unresolved
 * tombstone created when rollback restores a mention that was previously
 * unlinked; it is still a real, review-backed state transition.
 */
export const memoryEntityResolutions = sqliteTable(
	"memory_entity_resolutions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
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

/**
 * Drizzle does not model SQLite triggers. These statements are part of the
 * required migration contract and are exported so real-SQLite tests exercise
 * the same immutable/acceptance fences production D1 must install.
 */
export const MEMORY_ENTITY_GOVERNANCE_TRIGGER_SQL = [
	`CREATE TRIGGER memory_entities_org_immutable
		BEFORE UPDATE OF organization_id ON memory_entities
		WHEN NEW.organization_id != OLD.organization_id
		BEGIN
			SELECT RAISE(ABORT, 'memory entity organization is immutable');
		END`,
	`CREATE TRIGGER memory_entity_aliases_org_immutable
		BEFORE UPDATE OF organization_id ON memory_entity_aliases
		WHEN NEW.organization_id != OLD.organization_id
		BEGIN
			SELECT RAISE(ABORT, 'memory entity alias organization is immutable');
		END`,
	`CREATE TRIGGER memory_entity_mentions_no_update
		BEFORE UPDATE ON memory_entity_mentions
		BEGIN
			SELECT RAISE(ABORT, 'memory_entity_mentions are immutable');
		END`,
	`CREATE TRIGGER memory_entity_mentions_no_delete
		BEFORE DELETE ON memory_entity_mentions
		BEGIN
			SELECT RAISE(ABORT, 'memory_entity_mentions are immutable');
		END`,
	`CREATE TRIGGER memory_entity_decisions_terminal_no_update
		BEFORE UPDATE ON memory_entity_resolution_decisions
		WHEN OLD.status IN ('accepted', 'rejected')
		BEGIN
			SELECT RAISE(ABORT, 'terminal entity resolution decisions are immutable');
		END`,
	`CREATE TRIGGER memory_entity_decisions_terminal_no_delete
		BEFORE DELETE ON memory_entity_resolution_decisions
		WHEN OLD.status IN ('accepted', 'rejected')
		BEGIN
			SELECT RAISE(ABORT, 'terminal entity resolution decisions are immutable');
		END`,
	`CREATE TRIGGER memory_entity_decisions_org_immutable
		BEFORE UPDATE OF organization_id ON memory_entity_resolution_decisions
		WHEN NEW.organization_id != OLD.organization_id
		BEGIN
			SELECT RAISE(ABORT, 'entity resolution decision organization is immutable');
		END`,
	`CREATE TRIGGER memory_entity_heads_org_immutable
		BEFORE UPDATE OF organization_id ON memory_entity_resolution_heads
		WHEN NEW.organization_id != OLD.organization_id
		BEGIN
			SELECT RAISE(ABORT, 'entity resolution head organization is immutable');
		END`,
	`CREATE TRIGGER memory_entity_resolution_acceptance_guard
		BEFORE INSERT ON memory_entity_resolutions
		WHEN NOT EXISTS (
			SELECT 1
			FROM memory_entity_resolution_decisions d
			JOIN memory_entity_resolution_heads h
			  ON h.organization_id = d.organization_id
			 AND h.mention_id = d.mention_id
			WHERE d.id = NEW.decision_id
			  AND d.organization_id = NEW.organization_id
			  AND d.mention_id = NEW.mention_id
			  AND d.status = 'accepted'
			  AND h.current_resolution_id = NEW.id
			  AND h.current_entity_id IS NEW.entity_id
			  AND h.last_decision_id = d.id
			  AND (
					(NEW.entity_id IS NULL
					 AND d.operation = 'rollback'
					 AND d.target_entity_id IS NULL)
					OR EXISTS (
						SELECT 1
						FROM memory_entities e
						WHERE e.id = NEW.entity_id
						  AND e.organization_id = NEW.organization_id
						  AND e.id = d.target_entity_id
						  AND e.status = 'active'
						  AND e.version = d.expected_entity_version
					)
			  )
		)
		BEGIN
			SELECT RAISE(ABORT, 'entity resolution acceptance fence failed');
		END`,
	`CREATE TRIGGER memory_entity_resolutions_update_guard
		BEFORE UPDATE ON memory_entity_resolutions
		WHEN NEW.organization_id != OLD.organization_id
		  OR NEW.mention_id != OLD.mention_id
		  OR NEW.entity_id IS NOT OLD.entity_id
		  OR NEW.decision_id != OLD.decision_id
		  OR NEW.resolution_kind != OLD.resolution_kind
		  OR NEW.confidence != OLD.confidence
		  OR NEW.valid_from != OLD.valid_from
		  OR NEW.created_at != OLD.created_at
		  OR OLD.status != 'active'
		  OR NEW.status != 'revoked'
		  OR NEW.valid_to IS NULL
		BEGIN
			SELECT RAISE(ABORT, 'entity resolutions only permit active-to-revoked closure');
		END`,
	`CREATE TRIGGER memory_entity_resolutions_no_delete
		BEFORE DELETE ON memory_entity_resolutions
		BEGIN
			SELECT RAISE(ABORT, 'entity resolutions are immutable');
		END`,
	`CREATE TRIGGER graph_projection_memory_entities_insert
		AFTER INSERT ON memory_entities
		BEGIN
			INSERT INTO graph_projection_outbox
				(event_id, organization_id, entity_kind, entity_id, operation)
			VALUES
				(lower(hex(randomblob(16))), NEW.organization_id, 'entity', NEW.id, 'upsert');
		END`,
	`CREATE TRIGGER graph_projection_memory_entities_update
		AFTER UPDATE ON memory_entities
		BEGIN
			INSERT INTO graph_projection_outbox
				(event_id, organization_id, entity_kind, entity_id, operation)
			VALUES
				(lower(hex(randomblob(16))), NEW.organization_id, 'entity', NEW.id, 'upsert');
		END`,
	`CREATE TRIGGER graph_projection_memory_entities_delete
		AFTER DELETE ON memory_entities
		BEGIN
			INSERT INTO graph_projection_outbox
				(event_id, organization_id, entity_kind, entity_id, operation)
			VALUES
				(lower(hex(randomblob(16))), OLD.organization_id, 'entity', OLD.id, 'delete');
		END`,
	`CREATE TRIGGER graph_projection_memory_entity_resolutions_insert
		AFTER INSERT ON memory_entity_resolutions
		WHEN NEW.resolution_kind = 'linked'
		BEGIN
			INSERT INTO graph_projection_outbox
				(event_id, organization_id, entity_kind, entity_id, operation)
			VALUES
				(lower(hex(randomblob(16))), NEW.organization_id, 'entity_resolution', NEW.id, 'upsert');
		END`,
	`CREATE TRIGGER graph_projection_memory_entity_resolutions_revoke
		AFTER UPDATE OF status, valid_to ON memory_entity_resolutions
		WHEN OLD.status = 'active' AND NEW.status = 'revoked'
		BEGIN
			INSERT INTO graph_projection_outbox
				(event_id, organization_id, entity_kind, entity_id, operation, payload)
			VALUES (
				lower(hex(randomblob(16))),
				NEW.organization_id,
				'entity_resolution',
				NEW.id,
				'delete',
				json_object(
					'mentionId', NEW.mention_id,
					'factId', (
						SELECT source_fact_id
						FROM memory_entity_mentions
						WHERE id = NEW.mention_id
						  AND organization_id = NEW.organization_id
					),
					'entityId', NEW.entity_id,
					'decisionId', NEW.decision_id,
					'validTo', NEW.valid_to
				)
			);
		END`,
] as const;

export type MemoryEntity = typeof memoryEntities.$inferSelect;
export type MemoryEntityMention = typeof memoryEntityMentions.$inferSelect;
export type MemoryEntityAlias = typeof memoryEntityAliases.$inferSelect;
export type MemoryEntityResolutionHead =
	typeof memoryEntityResolutionHeads.$inferSelect;
export type MemoryEntityResolutionDecision =
	typeof memoryEntityResolutionDecisions.$inferSelect;
export type MemoryEntityResolution =
	typeof memoryEntityResolutions.$inferSelect;
