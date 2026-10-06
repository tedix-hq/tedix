import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations";
import { tedis } from "./tedis";
import { tediArtifacts } from "./cognitive-runtime";

export const artifactRedactionCandidates = sqliteTable(
	"artifact_redaction_candidates",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id),
		parentArtifactId: text("parent_artifact_id")
			.notNull()
			.references(() => tediArtifacts.id),
		parentContentDigest: text("parent_content_digest").notNull(),
		childArtifactId: text("child_artifact_id")
			.notNull()
			.references(() => tediArtifacts.id),
		childContentDigest: text("child_content_digest").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		createdByMemberId: text("created_by_member_id").notNull(),
		createdByUserId: text("created_by_user_id").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_artifact_redaction_candidates_child").on(
			table.childArtifactId,
		),
		uniqueIndex("uniq_artifact_redaction_candidates_idempotency").on(
			table.organizationId,
			table.parentArtifactId,
			table.idempotencyKey,
		),
		index("idx_artifact_redaction_candidates_parent").on(
			table.organizationId,
			table.parentArtifactId,
			table.createdAt,
		),
	],
);

export const artifactReleaseReviews = sqliteTable(
	"artifact_release_reviews",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id),
		candidateId: text("candidate_id")
			.notNull()
			.references(() => artifactRedactionCandidates.id),
		eventType: text("event_type", { enum: ["approved", "revoked"] }).notNull(),
		previousReviewId: text("previous_review_id").notNull(),
		targetApprovalId: text("target_approval_id"),
		childContentDigest: text("child_content_digest").notNull(),
		reviewerMemberId: text("reviewer_member_id").notNull(),
		reviewerUserId: text("reviewer_user_id").notNull(),
		reviewerDescopeUserId: text("reviewer_descope_user_id").notNull(),
		attestation: text("attestation").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_artifact_release_reviews_previous").on(
			table.candidateId,
			table.previousReviewId,
		),
		index("idx_artifact_release_reviews_candidate").on(
			table.organizationId,
			table.candidateId,
			table.createdAt,
		),
		index("idx_artifact_release_reviews_target").on(table.targetApprovalId),
	],
);

export type ArtifactRedactionCandidateRow =
	typeof artifactRedactionCandidates.$inferSelect;
export type NewArtifactRedactionCandidateRow =
	typeof artifactRedactionCandidates.$inferInsert;
export type ArtifactReleaseReviewRow =
	typeof artifactReleaseReviews.$inferSelect;
export type NewArtifactReleaseReviewRow =
	typeof artifactReleaseReviews.$inferInsert;
