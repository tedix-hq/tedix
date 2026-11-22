import { and, desc, eq, gte, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { memoryFacts } from "../../schema/memory-graph";
import { normalizeTenantScope, type TenantScope } from "../../tenant-scope";

function lessonPredicate(scope: TenantScope, viewerUserId: string | null): SQL {
	const { organizationId } = normalizeTenantScope(scope);
	return and(
		eq(memoryFacts.organizationId, organizationId),
		gte(memoryFacts.topicKey, "learning-feed:"),
		lt(memoryFacts.topicKey, "learning-feed;"),
		isNull(memoryFacts.validTo),
		or(
			and(
				isNull(memoryFacts.tediId),
				or(
					sql`${memoryFacts.visibility} IS NOT 'private'`,
					sql`json_extract(${memoryFacts.metadata}, '$.learningFeed.ownerUserId') IS NULL`,
				),
			),
			viewerUserId
				? and(
						eq(memoryFacts.visibility, "private"),
						sql`json_extract(${memoryFacts.metadata}, '$.learningFeed.ownerUserId') = ${viewerUserId}`,
					)
				: sql`0`,
		),
	)!;
}

export async function getRule(
	db: DbQueryClient,
	scope: TenantScope,
	viewerUserId: string | null,
	id: string,
) {
	const [row] = await db
		.select()
		.from(memoryFacts)
		.where(and(lessonPredicate(scope, viewerUserId), eq(memoryFacts.id, id)))
		.limit(1);
	return row ?? null;
}

export async function listRules(
	db: DbQueryClient,
	scope: TenantScope,
	viewerUserId: string | null,
	options: {
		scope?: "organization" | "personal";
		state?: "pending" | "active" | "retired" | "rejected";
		limit: number;
		offset: number;
	},
) {
	const state = sql`CASE WHEN ${memoryFacts.archivedAt} IS NOT NULL THEN 'retired' WHEN ${memoryFacts.reviewStatus} = 'confirmed' AND ${memoryFacts.status} = 'active' AND ${memoryFacts.usePolicy} IN ('can_use_as_instruction', 'requires_user_confirmation') THEN 'active' WHEN ${memoryFacts.reviewStatus} = 'pending' THEN 'pending' ELSE 'rejected' END`;
	return db
		.select()
		.from(memoryFacts)
		.where(
			and(
				lessonPredicate(scope, viewerUserId),
				options.scope === "personal"
					? and(
							eq(memoryFacts.visibility, "private"),
							sql`json_extract(${memoryFacts.metadata}, '$.learningFeed.ownerUserId') IS NOT NULL`,
						)
					: options.scope === "organization"
						? or(
								sql`${memoryFacts.visibility} IS NOT 'private'`,
								sql`json_extract(${memoryFacts.metadata}, '$.learningFeed.ownerUserId') IS NULL`,
							)
						: undefined,
				options.state ? sql`${state} = ${options.state}` : undefined,
			),
		)
		.orderBy(desc(memoryFacts.updatedAt), desc(memoryFacts.id))
		.limit(options.limit + 1)
		.offset(options.offset);
}

/** Managed rules are settled even when pending or retired; miners cannot rewrite them. */
export async function listRuleMiningGuards(
	db: DbQueryClient,
	scope: TenantScope,
	ownerUserId: string | null,
) {
	return db
		.select({
			id: memoryFacts.id,
			topicKey: memoryFacts.topicKey,
			content: memoryFacts.content,
			reviewStatus: memoryFacts.reviewStatus,
			metadata: memoryFacts.metadata,
		})
		.from(memoryFacts)
		.where(
			and(
				lessonPredicate(scope, ownerUserId),
				sql`json_extract(${memoryFacts.metadata}, '$.managedRule') IS NOT NULL`,
			),
		);
}
