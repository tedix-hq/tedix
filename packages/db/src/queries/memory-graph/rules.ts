import { jsonRead } from "../../core-store/dialect";
import { coreTable } from "../../core-store/client";
import { and, desc, eq, gte, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { memoryFacts as d1MemoryFacts } from "../../schema/memory-graph";
import { normalizeTenantScope, type TenantScope } from "../../tenant-scope";

function lessonPredicate(
	db: DbQueryClient,
	scope: TenantScope,
	viewerUserId: string | null,
): SQL {
	const memoryFacts = coreTable(db, d1MemoryFacts);
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
					sql`(${memoryFacts.visibility} <> 'private' OR ${memoryFacts.visibility} IS NULL)`,
					sql`${jsonRead(db, memoryFacts.metadata, ["learningFeed", "ownerUserId"])} IS NULL`,
				),
			),
			viewerUserId
				? and(
						eq(memoryFacts.visibility, "private"),
						sql`${jsonRead(db, memoryFacts.metadata, ["learningFeed", "ownerUserId"])} = ${viewerUserId}`,
					)
				: sql`false`,
		),
	)!;
}

export async function getRule(
	db: DbQueryClient,
	scope: TenantScope,
	viewerUserId: string | null,
	id: string,
) {
	const memoryFacts = coreTable(db, d1MemoryFacts);
	const [row] = await db
		.select()
		.from(memoryFacts)
		.where(
			and(lessonPredicate(db, scope, viewerUserId), eq(memoryFacts.id, id)),
		)
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
	const memoryFacts = coreTable(db, d1MemoryFacts);
	const state = sql`CASE WHEN ${memoryFacts.archivedAt} IS NOT NULL THEN 'retired' WHEN ${memoryFacts.reviewStatus} = 'confirmed' AND ${memoryFacts.status} = 'active' AND ${memoryFacts.usePolicy} IN ('can_use_as_instruction', 'requires_user_confirmation') THEN 'active' WHEN ${memoryFacts.reviewStatus} = 'pending' THEN 'pending' ELSE 'rejected' END`;
	return db
		.select()
		.from(memoryFacts)
		.where(
			and(
				lessonPredicate(db, scope, viewerUserId),
				options.scope === "personal"
					? and(
							eq(memoryFacts.visibility, "private"),
							sql`${jsonRead(db, memoryFacts.metadata, ["learningFeed", "ownerUserId"])} IS NOT NULL`,
						)
					: options.scope === "organization"
						? or(
								sql`(${memoryFacts.visibility} <> 'private' OR ${memoryFacts.visibility} IS NULL)`,
								sql`${jsonRead(db, memoryFacts.metadata, ["learningFeed", "ownerUserId"])} IS NULL`,
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
	const memoryFacts = coreTable(db, d1MemoryFacts);
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
				lessonPredicate(db, scope, ownerUserId),
				sql`${jsonRead(db, memoryFacts.metadata, ["managedRule"], "json")} IS NOT NULL`,
			),
		);
}
