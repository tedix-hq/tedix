import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { platformCronCheckpoints } from "../../schema/platform-cron-executions";
import type { DbQueryClient } from "../../query-client";
import { chunkForBoundParams } from "../../utils/batch";
import type { DecisionCardPresentation } from "@tedix/api-contract/schemas/decision-card-presentation";
import {
	workInteractionCardPresentations,
	workInteractions,
} from "../../schema/work-factory";

function displayCopy(presentation: DecisionCardPresentation) {
	const { copyHistory: _, ...copy } =
		presentation as DecisionCardPresentation & { copyHistory?: unknown[] };
	return copy;
}

/** Display copy is a projection; the canonical request and its version stay immutable. */
export async function saveDecisionCardPresentation(
	db: DbQueryClient,
	input: {
		orgId: string;
		requestId: string;
		personId: string;
		expectedVersion: number;
		presentation: DecisionCardPresentation;
		onlyMissing?: boolean;
	},
) {
	const updatedAt = new Date().toISOString();
	const [saved] = await db
		.insert(workInteractionCardPresentations)
		.select(
			db
				.select({
					orgId: workInteractions.orgId,
					interactionId: workInteractions.id,
					personId: sql<string>`${workInteractions.targetId}`.as("person_id"),
					requestVersion: workInteractions.version,
					presentation:
						sql<DecisionCardPresentation>`json_set(json(${JSON.stringify(input.presentation)}), '$.copyHistory',
 case when json_type(${workInteractions.metadata}, '$.cardPresentation') = 'object'
 then json_array(json_extract(${workInteractions.metadata}, '$.cardPresentation')) else json('[]') end)`.as(
							"presentation",
						),
					updatedAt: sql<string>`${updatedAt}`.as("updated_at"),
				})
				.from(workInteractions)
				.where(
					and(
						eq(workInteractions.orgId, input.orgId),
						eq(workInteractions.id, input.requestId),
						eq(workInteractions.targetType, "user"),
						eq(workInteractions.targetId, input.personId),
						eq(workInteractions.status, "open"),
						or(
							isNull(workInteractions.expiresAt),
							gt(workInteractions.expiresAt, updatedAt),
						),
						eq(workInteractions.version, input.expectedVersion),
					),
				),
		)
		.onConflictDoUpdate({
			target: [
				workInteractionCardPresentations.orgId,
				workInteractionCardPresentations.interactionId,
			],
			setWhere: input.onlyMissing
				? sql`${workInteractionCardPresentations.requestVersion}<>${input.expectedVersion}`
				: undefined,
			set: {
				personId: input.personId,
				requestVersion: input.expectedVersion,
				// Append the previous projection atomically with its replacement.
				presentation: sql<DecisionCardPresentation>`json_set(json(${JSON.stringify(input.presentation)}), '$.copyHistory',
 json_insert(coalesce(json_extract(${workInteractionCardPresentations.presentation}, '$.copyHistory'), json('[]')),
 '$[#]', json_remove(${workInteractionCardPresentations.presentation}, '$.copyHistory')))`,
				updatedAt,
			},
		})
		.returning();
	return saved
		? { ...saved, presentation: displayCopy(saved.presentation) }
		: null;
}

export async function listDecisionCardPresentations(
	db: DbQueryClient,
	input: {
		orgId: string;
		personId: string | null;
		requests: Pick<
			typeof workInteractions.$inferSelect,
			"id" | "version" | "targetType" | "targetId"
		>[];
	},
) {
	const requests = input.requests.filter(
		(r) => r.targetType === "user" && r.targetId === input.personId,
	);
	if (!input.personId || !requests.length) return [];
	const versions = new Map(requests.map((r) => [r.id, r.version]));
	const result: (typeof workInteractionCardPresentations.$inferSelect)[] = [];
	for (const ids of chunkForBoundParams(
		requests.map((r) => r.id),
		50,
	)) {
		const rows = await db
			.select()
			.from(workInteractionCardPresentations)
			.where(
				and(
					eq(workInteractionCardPresentations.orgId, input.orgId),
					eq(workInteractionCardPresentations.personId, input.personId),
					inArray(workInteractionCardPresentations.interactionId, ids),
				),
			);
		result.push(
			...rows
				.filter((row) => versions.get(row.interactionId) === row.requestVersion)
				.map((row) => ({
					...row,
					presentation: displayCopy(row.presentation),
				})),
		);
	}
	return result;
}

const SUMMARY_BACKFILL = "decision-card-summary-backfill:v1";

/** Platform maintenance scans at most five missing projections across tenants per tick. */
export async function listMissingCardSummaries(db: DbQueryClient, now: string) {
	const [checkpoint] = await db
		.select()
		.from(platformCronCheckpoints)
		.where(eq(platformCronCheckpoints.scheduleId, SUMMARY_BACKFILL))
		.limit(1);
	const previous = checkpoint?.through ?? null;
	const rows = await db
		.select()
		.from(workInteractions)
		.where(
			and(
				eq(workInteractions.status, "open"),
				eq(workInteractions.targetType, "user"),
				or(
					isNull(workInteractions.expiresAt),
					gt(workInteractions.expiresAt, now),
				),
				sql`(${workInteractions.orgId} || ':' || ${workInteractions.id}) > ${previous ?? ""}`,
				sql`json_type(${workInteractions.metadata},'$.cardPresentation') IS NOT 'object'`,
				sql`NOT EXISTS (SELECT 1 FROM work_interaction_card_presentations face
   WHERE face.org_id=${workInteractions.orgId} AND face.interaction_id=${workInteractions.id}
   AND face.person_id=${workInteractions.targetId} AND face.request_version=${workInteractions.version})`,
			),
		)
		.orderBy(workInteractions.orgId, workInteractions.id)
		.limit(5);
	return { rows, previous };
}

/** CAS cursor keeps overlapping maintenance ticks from rewinding progress. Empty pages restart a pass. */
export async function advanceCardSummaryBackfill(
	db: DbQueryClient,
	previous: string | null,
	next: string,
) {
	await db
		.insert(platformCronCheckpoints)
		.values({ scheduleId: SUMMARY_BACKFILL, through: next })
		.onConflictDoUpdate({
			target: platformCronCheckpoints.scheduleId,
			set: { through: next },
			setWhere:
				previous === null
					? sql`0`
					: eq(platformCronCheckpoints.through, previous),
		});
}
