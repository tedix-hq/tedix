import { DECISION_GRAPH_EDGE_KINDS } from "@tedix/api-contract/schemas/decision-graph";
import {
	DecisionGraphBackfillCursorSchema,
	type DecisionGraphBackfillCursor,
} from "@tedix/api-contract/schemas/decision-graph-backfill";
import type { DbQueryClient } from "@tedix/db/query-client";
import { upsertDecisionEdges } from "@tedix/db/queries/decision-graph";
import {
	planDecisionGraphBackfillPage,
	getDecisionGraphBackfillCheckpoint,
	advanceDecisionGraphBackfillCheckpoint,
	nextDecisionGraphBackfillOrganization,
} from "@tedix/db/queries/decision-graph-backfill";

export async function runDecisionGraphBackfillPage(
	db: DbQueryClient,
	orgId: string,
	input: {
		dryRun: boolean;
		cursor: DecisionGraphBackfillCursor | null;
		limit: number;
	},
) {
	const page = await planDecisionGraphBackfillPage(db, orgId, input);
	const counts = Object.fromEntries(
		DECISION_GRAPH_EDGE_KINDS.map((kind) => [kind, 0]),
	) as Record<(typeof DECISION_GRAPH_EDGE_KINDS)[number], number>;
	for (const edge of page.edges) counts[edge.kind]++;
	if (!input.dryRun)
		for (let i = 0; i < page.edges.length; i += 50)
			await upsertDecisionEdges(db, orgId, page.edges.slice(i, i + 50));
	return { scanned: page.scanned, counts, nextCursor: page.nextCursor };
}

/** One organization and <=50 source rows per tick, round-robin across tenants. */
export async function runScheduledDecisionGraphBackfill(db: DbQueryClient) {
	const previousOrg = await getDecisionGraphBackfillCheckpoint(
		db,
		"organizations",
	);
	const orgId =
		(await nextDecisionGraphBackfillOrganization(db, previousOrg ?? "")) ??
		(await nextDecisionGraphBackfillOrganization(db, ""));
	if (!orgId) return { backfillScanned: 0, backfillEdges: 0 };
	const previous = await getDecisionGraphBackfillCheckpoint(db, `org:${orgId}`);
	if (previous !== "done") {
		const cursor = previous
			? DecisionGraphBackfillCursorSchema.parse(JSON.parse(previous))
			: null;
		const result = await runDecisionGraphBackfillPage(db, orgId, {
			dryRun: false,
			cursor,
			limit: 50,
		});
		await advanceDecisionGraphBackfillCheckpoint(
			db,
			`org:${orgId}`,
			previous,
			result.nextCursor ? JSON.stringify(result.nextCursor) : "done",
		);
		await advanceDecisionGraphBackfillCheckpoint(
			db,
			"organizations",
			previousOrg,
			orgId,
		);
		return {
			backfillScanned: result.scanned,
			backfillEdges: Object.values(result.counts).reduce(
				(sum, n) => sum + n,
				0,
			),
		};
	}
	await advanceDecisionGraphBackfillCheckpoint(
		db,
		"organizations",
		previousOrg,
		orgId,
	);
	return { backfillScanned: 0, backfillEdges: 0 };
}
