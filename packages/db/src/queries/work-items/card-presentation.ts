import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import type { DecisionCardPresentation } from "@tedix/api-contract/schemas/decision-card-presentation";
import {
	workInteractionCardPresentations,
	workInteractions,
} from "../../schema/work-factory";

/** Display copy is a projection; the canonical request and its version stay immutable. */
export async function saveDecisionCardPresentation(
	db: DbQueryClient,
	input: {
		orgId: string;
		requestId: string;
		personId: string;
		expectedVersion: number;
		presentation: DecisionCardPresentation;
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
						sql<DecisionCardPresentation>`json(${JSON.stringify(input.presentation)})`.as(
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
						eq(workInteractions.version, input.expectedVersion),
					),
				),
		)
		.onConflictDoUpdate({
			target: [
				workInteractionCardPresentations.orgId,
				workInteractionCardPresentations.interactionId,
			],
			set: {
				personId: input.personId,
				requestVersion: input.expectedVersion,
				presentation: input.presentation,
				updatedAt,
			},
		})
		.returning();
	return saved ?? null;
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
	for (let i = 0; i < requests.length; i += 50) {
		const rows = await db
			.select()
			.from(workInteractionCardPresentations)
			.where(
				and(
					eq(workInteractionCardPresentations.orgId, input.orgId),
					eq(workInteractionCardPresentations.personId, input.personId),
					inArray(
						workInteractionCardPresentations.interactionId,
						requests.slice(i, i + 50).map((r) => r.id),
					),
				),
			);
		result.push(
			...rows.filter(
				(row) => versions.get(row.interactionId) === row.requestVersion,
			),
		);
	}
	return result;
}
