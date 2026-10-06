import { and, eq, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbQueryClient } from "../../query-client";
import { organizationMembers } from "../../schema/organization-members";
import {
	tediArtifactContributionReceipts,
	tediArtifacts,
} from "../../schema/cognitive-runtime";
import {
	artifactRedactionCandidates,
	artifactReleaseReviews,
	type ArtifactRedactionCandidateRow,
	type ArtifactReleaseReviewRow,
	type NewArtifactRedactionCandidateRow,
	type NewArtifactReleaseReviewRow,
} from "../../schema/artifact-releases";

export class ArtifactReleaseConflictError extends Error {
	constructor(message = "Artifact release state changed") {
		super(message);
		this.name = "ArtifactReleaseConflictError";
	}
}
const sameCandidate = (
	a: ArtifactRedactionCandidateRow,
	b: NewArtifactRedactionCandidateRow,
) =>
	a.organizationId === b.organizationId &&
	a.tediId === b.tediId &&
	a.parentArtifactId === b.parentArtifactId &&
	a.parentContentDigest === b.parentContentDigest &&
	a.childArtifactId === b.childArtifactId &&
	a.childContentDigest === b.childContentDigest &&
	a.idempotencyKey === b.idempotencyKey &&
	a.createdByMemberId === b.createdByMemberId &&
	a.createdByUserId === b.createdByUserId;
const sameReview = (
	a: ArtifactReleaseReviewRow,
	b: NewArtifactReleaseReviewRow,
) =>
	a.organizationId === b.organizationId &&
	a.tediId === b.tediId &&
	a.candidateId === b.candidateId &&
	a.eventType === b.eventType &&
	a.previousReviewId === b.previousReviewId &&
	a.targetApprovalId === (b.targetApprovalId ?? null) &&
	a.childContentDigest === b.childContentDigest &&
	a.reviewerMemberId === b.reviewerMemberId &&
	a.reviewerUserId === b.reviewerUserId &&
	a.reviewerDescopeUserId === b.reviewerDescopeUserId &&
	a.attestation === b.attestation;

export async function createArtifactRedactionCandidate(
	db: DbQueryClient,
	input: NewArtifactRedactionCandidateRow,
): Promise<{ candidate: ArtifactRedactionCandidateRow; created: boolean }> {
	const parent = alias(tediArtifacts, "release_parent_artifact");
	const child = alias(tediArtifacts, "release_child_artifact");
	const inserted = await db
		.insert(artifactRedactionCandidates)
		.select(
			db
				.select({
					id: sql<string>`${input.id}`.as("candidate_id"),
					organizationId: sql<string>`${parent.organizationId}`.as(
						"candidate_organization_id",
					),
					tediId: sql<string>`${parent.tediId}`.as("candidate_tedi_id"),
					parentArtifactId: sql<string>`${parent.id}`.as("parent_artifact_id"),
					parentContentDigest: sql<string>`${parent.contentDigest}`.as(
						"parent_content_digest",
					),
					childArtifactId: sql<string>`${child.id}`.as("child_artifact_id"),
					childContentDigest: sql<string>`${child.contentDigest}`.as(
						"child_content_digest",
					),
					idempotencyKey: sql<string>`${input.idempotencyKey}`.as(
						"idempotency_key",
					),
					createdByMemberId: sql<string>`${input.createdByMemberId}`.as(
						"created_by_member_id",
					),
					createdByUserId: sql<string>`${input.createdByUserId}`.as(
						"created_by_user_id",
					),
					createdAt:
						sql<string>`${input.createdAt ?? new Date().toISOString()}`.as(
							"created_at",
						),
				})
				.from(parent)
				.innerJoin(
					child,
					and(
						eq(child.id, input.childArtifactId!),
						eq(child.organizationId, parent.organizationId),
						eq(child.tediId, parent.tediId),
					),
				)
				.where(
					and(
						eq(parent.id, input.parentArtifactId!),
						eq(parent.organizationId, input.organizationId!),
						eq(parent.tediId, input.tediId!),
						eq(parent.contentDigest, input.parentContentDigest!),
						eq(parent.accessClassification, "runtime_private"),
						eq(parent.publicationState, "ready"),
						eq(child.contentDigest, input.childContentDigest!),
						eq(child.accessClassification, "runtime_private"),
						eq(child.publicationState, "ready"),
						sql`${parent.id} <> ${child.id}`,
					),
				),
		)
		.onConflictDoNothing()
		.returning();
	if (inserted[0]) return { candidate: inserted[0], created: true };
	const [existing] = await db
		.select()
		.from(artifactRedactionCandidates)
		.where(
			and(
				eq(artifactRedactionCandidates.organizationId, input.organizationId!),
				eq(
					artifactRedactionCandidates.parentArtifactId,
					input.parentArtifactId!,
				),
				eq(artifactRedactionCandidates.idempotencyKey, input.idempotencyKey),
			),
		)
		.limit(1);
	if (!existing || !sameCandidate(existing, input))
		throw new ArtifactReleaseConflictError("Candidate claim conflicts");
	return { candidate: existing, created: false };
}

export async function getArtifactRedactionCandidate(
	db: DbQueryClient,
	input: {
		organizationId: string;
		candidateId?: string;
		childArtifactId?: string;
	},
): Promise<ArtifactRedactionCandidateRow | null> {
	const identity = input.candidateId
		? eq(artifactRedactionCandidates.id, input.candidateId)
		: input.childArtifactId
			? eq(artifactRedactionCandidates.childArtifactId, input.childArtifactId)
			: undefined;
	if (!identity) return null;
	const [row] = await db
		.select()
		.from(artifactRedactionCandidates)
		.where(
			and(
				eq(artifactRedactionCandidates.organizationId, input.organizationId),
				identity,
			),
		)
		.limit(1);
	return row ?? null;
}

export async function getArtifactContributionReceiptForRelease(
	db: DbQueryClient,
	input: { organizationId: string; artifactId: string },
) {
	const [row] = await db
		.select()
		.from(tediArtifactContributionReceipts)
		.where(
			and(
				eq(
					tediArtifactContributionReceipts.organizationId,
					input.organizationId,
				),
				eq(tediArtifactContributionReceipts.artifactId, input.artifactId),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function getArtifactReleaseReviewHead(
	db: DbQueryClient,
	input: { organizationId: string; candidateId: string },
): Promise<ArtifactReleaseReviewRow | null> {
	const successor = alias(
		artifactReleaseReviews,
		"artifact_release_review_successor",
	);
	const rows = await db
		.select()
		.from(artifactReleaseReviews)
		.where(
			and(
				eq(artifactReleaseReviews.organizationId, input.organizationId),
				eq(artifactReleaseReviews.candidateId, input.candidateId),
				notExists(
					db
						.select({ id: successor.id })
						.from(successor)
						.where(
							and(
								eq(
									successor.organizationId,
									artifactReleaseReviews.organizationId,
								),
								eq(successor.candidateId, artifactReleaseReviews.candidateId),
								eq(successor.previousReviewId, artifactReleaseReviews.id),
							),
						),
				),
			),
		)
		.limit(2);
	if (rows.length > 1)
		throw new ArtifactReleaseConflictError(
			"Artifact release review chain is ambiguous",
		);
	return rows[0] ?? null;
}

export async function appendArtifactReleaseReview(
	db: DbQueryClient,
	input: NewArtifactReleaseReviewRow,
): Promise<{ review: ArtifactReleaseReviewRow; created: boolean }> {
	const prior = alias(artifactReleaseReviews, "artifact_release_prior");
	const successor = alias(artifactReleaseReviews, "artifact_release_successor");
	const genesis = input.previousReviewId === input.candidateId;
	if (
		genesis
			? input.eventType !== "approved" || input.targetApprovalId != null
			: input.eventType === "approved"
				? input.targetApprovalId != null
				: input.targetApprovalId !== input.previousReviewId
	)
		throw new ArtifactReleaseConflictError(
			"Invalid artifact release transition",
		);
	const headCondition = genesis
		? notExists(
				db
					.select({ id: artifactReleaseReviews.id })
					.from(artifactReleaseReviews)
					.where(
						and(
							eq(artifactReleaseReviews.organizationId, input.organizationId!),
							eq(artifactReleaseReviews.candidateId, input.candidateId),
						),
					),
			)
		: and(
				eq(prior.id, input.previousReviewId),
				input.eventType === "revoked"
					? eq(prior.eventType, "approved")
					: eq(prior.eventType, "revoked"),
				notExists(
					db
						.select({ id: successor.id })
						.from(successor)
						.where(
							and(
								eq(successor.organizationId, input.organizationId!),
								eq(successor.candidateId, input.candidateId),
								eq(successor.previousReviewId, prior.id),
							),
						),
				),
			);
	const inserted = await db
		.insert(artifactReleaseReviews)
		.select(
			db
				.select({
					id: sql<string>`${input.id}`.as("id"),
					organizationId: artifactRedactionCandidates.organizationId,
					tediId: artifactRedactionCandidates.tediId,
					candidateId: artifactRedactionCandidates.id,
					eventType: sql<"approved" | "revoked">`${input.eventType}`.as(
						"event_type",
					),
					previousReviewId: sql<string>`${input.previousReviewId}`.as(
						"previous_review_id",
					),
					targetApprovalId: sql<
						string | null
					>`${input.targetApprovalId ?? null}`.as("target_approval_id"),
					childContentDigest: artifactRedactionCandidates.childContentDigest,
					reviewerMemberId: sql<string>`${input.reviewerMemberId}`.as(
						"reviewer_member_id",
					),
					reviewerUserId: sql<string>`${input.reviewerUserId}`.as(
						"reviewer_user_id",
					),
					reviewerDescopeUserId: sql<string>`${input.reviewerDescopeUserId}`.as(
						"reviewer_descope_user_id",
					),
					attestation: sql<string>`${input.attestation}`.as("attestation"),
					createdAt:
						sql<string>`${input.createdAt ?? new Date().toISOString()}`.as(
							"created_at",
						),
				})
				.from(artifactRedactionCandidates)
				.innerJoin(
					organizationMembers,
					and(
						eq(organizationMembers.id, input.reviewerMemberId),
						eq(
							organizationMembers.organizationId,
							artifactRedactionCandidates.organizationId,
						),
						eq(organizationMembers.userId, input.reviewerUserId),
						eq(organizationMembers.descopeUserId, input.reviewerDescopeUserId),
						eq(organizationMembers.role, "owner"),
						eq(organizationMembers.status, "active"),
					),
				)
				.leftJoin(
					prior,
					and(
						eq(prior.id, input.previousReviewId),
						eq(prior.candidateId, artifactRedactionCandidates.id),
						eq(
							prior.organizationId,
							artifactRedactionCandidates.organizationId,
						),
					),
				)
				.where(
					and(
						eq(artifactRedactionCandidates.id, input.candidateId),
						eq(
							artifactRedactionCandidates.organizationId,
							input.organizationId!,
						),
						eq(artifactRedactionCandidates.tediId, input.tediId!),
						eq(
							artifactRedactionCandidates.childContentDigest,
							input.childContentDigest,
						),
						headCondition,
					),
				),
		)
		.onConflictDoNothing()
		.returning();
	if (inserted[0]) return { review: inserted[0], created: true };
	const [existing] = await db
		.select()
		.from(artifactReleaseReviews)
		.where(eq(artifactReleaseReviews.id, input.id!))
		.limit(1);
	if (!existing || !sameReview(existing, input))
		throw new ArtifactReleaseConflictError();
	return { review: existing, created: false };
}

export async function getActiveArtifactReleaseApproval(
	db: DbQueryClient,
	input: {
		organizationId: string;
		childArtifactId: string;
		approvalId: string;
		childContentDigest: string;
	},
): Promise<{
	candidate: ArtifactRedactionCandidateRow;
	approval: ArtifactReleaseReviewRow;
} | null> {
	const candidate = await getArtifactRedactionCandidate(db, {
		organizationId: input.organizationId,
		childArtifactId: input.childArtifactId,
	});
	if (!candidate || candidate.childContentDigest !== input.childContentDigest)
		return null;
	const head = await getArtifactReleaseReviewHead(db, {
		organizationId: input.organizationId,
		candidateId: candidate.id,
	});
	if (
		!head ||
		head.id !== input.approvalId ||
		head.eventType !== "approved" ||
		head.childContentDigest !== input.childContentDigest
	)
		return null;
	const [member] = await db
		.select({ id: organizationMembers.id })
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.id, head.reviewerMemberId),
				eq(organizationMembers.organizationId, input.organizationId),
				eq(organizationMembers.userId, head.reviewerUserId),
				eq(organizationMembers.descopeUserId, head.reviewerDescopeUserId),
				eq(organizationMembers.role, "owner"),
				eq(organizationMembers.status, "active"),
			),
		)
		.limit(1);
	return member ? { candidate, approval: head } : null;
}
