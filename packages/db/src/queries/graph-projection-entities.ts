import { coreTable } from "../core-store/client";
import { and, eq } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	memoryEntities as d1MemoryEntities,
	memoryEntityMentions as d1MemoryEntityMentions,
	memoryEntityResolutions as d1MemoryEntityResolutions,
} from "../schema/memory-entities";

export async function getMemoryEntityProjection(
	db: DbClient,
	input: { organizationId: string; entityId: string },
) {
	const memoryEntities = coreTable(db, d1MemoryEntities);
	const [row] = await db
		.select()
		.from(memoryEntities)
		.where(
			and(
				eq(memoryEntities.id, input.entityId),
				eq(memoryEntities.organizationId, input.organizationId),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function getMemoryEntityResolutionProjection(
	db: DbClient,
	input: { organizationId: string; resolutionId: string },
) {
	const memoryEntityResolutions = coreTable(db, d1MemoryEntityResolutions);
	const memoryEntityMentions = coreTable(db, d1MemoryEntityMentions);
	const [row] = await db
		.select({
			id: memoryEntityResolutions.id,
			organizationId: memoryEntityResolutions.organizationId,
			mentionId: memoryEntityResolutions.mentionId,
			entityId: memoryEntityResolutions.entityId,
			decisionId: memoryEntityResolutions.decisionId,
			resolutionKind: memoryEntityResolutions.resolutionKind,
			status: memoryEntityResolutions.status,
			confidence: memoryEntityResolutions.confidence,
			validFrom: memoryEntityResolutions.validFrom,
			validTo: memoryEntityResolutions.validTo,
			sourceFactId: memoryEntityMentions.sourceFactId,
		})
		.from(memoryEntityResolutions)
		.innerJoin(
			memoryEntityMentions,
			and(
				eq(memoryEntityMentions.id, memoryEntityResolutions.mentionId),
				eq(
					memoryEntityMentions.organizationId,
					memoryEntityResolutions.organizationId,
				),
			),
		)
		.where(
			and(
				eq(memoryEntityResolutions.id, input.resolutionId),
				eq(memoryEntityResolutions.organizationId, input.organizationId),
			),
		)
		.limit(1);
	return row ?? null;
}

export type MemoryEntityProjection = NonNullable<
	Awaited<ReturnType<typeof getMemoryEntityProjection>>
>;

export type MemoryEntityResolutionProjection = NonNullable<
	Awaited<ReturnType<typeof getMemoryEntityResolutionProjection>>
>;
