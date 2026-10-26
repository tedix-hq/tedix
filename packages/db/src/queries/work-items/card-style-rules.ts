import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { learningImprovementProposals } from "../../schema/learning-feedback";
import { memoryFacts } from "../../schema/memory-graph";
import { organizationMembers } from "../../schema/organization-members";

export async function resolveCardStyleOwner(
	db: DbQueryClient,
	orgId: string,
	personId: string,
) {
	const rows = await db
		.select({
			subject: organizationMembers.descopeUserId,
			userId: organizationMembers.userId,
		})
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, orgId),
				eq(organizationMembers.status, "active"),
				or(
					eq(organizationMembers.userId, personId),
					eq(organizationMembers.descopeUserId, personId),
				),
			),
		)
		.limit(2);
	if (rows.length > 1) throw new Error("Personal style owner is ambiguous");
	return rows[0]?.subject ?? rows[0]?.userId ?? personId;
}
/** The active member's Tedix user id, which keys their own OS preferences. */
export async function resolveCardReaderUserId(
	db: DbQueryClient,
	orgId: string,
	personId: string,
) {
	const rows = await db
		.select({ userId: organizationMembers.userId })
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, orgId),
				eq(organizationMembers.status, "active"),
				or(
					eq(organizationMembers.userId, personId),
					eq(organizationMembers.descopeUserId, personId),
				),
			),
		)
		.limit(2);
	return rows.length === 1 ? (rows[0]!.userId ?? null) : null;
}

function scope(orgId: string, ownerUserId: string) {
	return and(
		eq(memoryFacts.organizationId, orgId),
		eq(memoryFacts.visibility, "private"),
		sql`json_extract(${memoryFacts.metadata},'$.cardStyle.version')=1`,
		sql`json_extract(${memoryFacts.metadata},'$.learningFeed.ownerUserId')=${ownerUserId}`,
	);
}
export async function listPersonalCardStyleRules(
	db: DbQueryClient,
	orgId: string,
	ownerUserId: string,
) {
	return db
		.select()
		.from(memoryFacts)
		.where(
			and(
				scope(orgId, ownerUserId),
				isNull(memoryFacts.archivedAt),
				eq(memoryFacts.reviewStatus, "confirmed"),
				eq(memoryFacts.usePolicy, "can_use_as_instruction"),
			),
		)
		.orderBy(desc(memoryFacts.updatedAt))
		.limit(50);
}
export async function getPersonalCardStyleRule(
	db: DbQueryClient,
	orgId: string,
	ownerUserId: string,
	id: string,
) {
	const [row] = await db
		.select()
		.from(memoryFacts)
		.where(and(scope(orgId, ownerUserId), eq(memoryFacts.id, id)))
		.limit(1);
	return row ?? null;
}
export async function reviewPersonalCardStyleRule(
	db: DbQueryClient,
	orgId: string,
	ownerUserId: string,
	id: string,
	keep: boolean,
) {
	const now = new Date().toISOString();
	const [row] = await db
		.update(memoryFacts)
		.set({
			reviewStatus: keep ? "confirmed" : "rejected",
			usePolicy: keep ? "can_use_as_instruction" : "can_use_as_evidence",
			archivedAt: keep ? null : now,
			updatedAt: now,
			lastVerifiedAt: now,
		})
		.where(
			and(
				scope(orgId, ownerUserId),
				eq(memoryFacts.id, id),
				isNull(memoryFacts.archivedAt),
			),
		)
		.returning();
	return row ?? null;
}

export async function getPersonalCardStyleProposal(
	db: DbQueryClient,
	orgId: string,
	ownerUserId: string,
	eventId: string,
) {
	const [row] = await db
		.select()
		.from(learningImprovementProposals)
		.where(
			and(
				eq(learningImprovementProposals.organizationId, orgId),
				eq(learningImprovementProposals.scopeKind, "personal"),
				eq(learningImprovementProposals.scopeId, ownerUserId),
				eq(learningImprovementProposals.subjectKind, "directive"),
				eq(learningImprovementProposals.subjectId, eventId),
			),
		)
		.limit(1);
	return row ?? null;
}
