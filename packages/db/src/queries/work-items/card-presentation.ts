import { and, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { workInteractions } from "../../schema/work-factory";

/** Only the addressed person can refresh copy on an unchanged, open request. */
export async function saveDecisionCardPresentation(
	db: DbQueryClient,
	input: {
		orgId: string;
		requestId: string;
		personId: string;
		expectedVersion: number;
		presentation: Record<string, JsonValue>;
	},
) {
	const [saved] = await db
		.update(workInteractions)
		.set({
			metadata: sql`json_set(${workInteractions.metadata}, '$.cardPresentation', json(${JSON.stringify(input.presentation)}))`,
			version: sql`${workInteractions.version} + 1`,
		})
		.where(
			and(
				eq(workInteractions.orgId, input.orgId),
				eq(workInteractions.id, input.requestId),
				eq(workInteractions.targetType, "user"),
				eq(workInteractions.targetId, input.personId),
				eq(workInteractions.status, "open"),
				eq(workInteractions.version, input.expectedVersion),
			),
		)
		.returning();
	return saved ?? null;
}
