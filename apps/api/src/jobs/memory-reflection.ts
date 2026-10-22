/// <reference path="../../worker-configuration.d.ts" />
/**
 * 4am UTC per-org memory reflection dispatch, extracted from worker-app.ts's
 * scheduled() handler.
 */

const CITATION_BACKFILL_BUDGET = 2000;

export async function runMemoryReflection(
	env: CloudflareEnv,
	runId: string,
): Promise<Record<string, number>> {
	console.log(`[Scheduled] Starting MemoryReflectionWorkflow (${runId})`);
	const { createDbClient } = await import("@tedix/db/client");
	const { listOrganizations } = await import("@tedix/db/queries/organizations");
	const { backfillFactSearch } =
		await import("@tedix/db/queries/memory-graph/hybrid-recall");
	const { backfillFactCitations } =
		await import("@tedix/db/queries/memory-graph/fact-citations");
	const db = createDbClient(env.DB);

	const orgs = await listOrganizations(db);
	let searchRowsBackfilled = 0;
	let citationFactsBackfilled = 0;
	for (const org of orgs) {
		try {
			searchRowsBackfilled += await backfillFactSearch(db, org.id);
		} catch (error) {
			console.warn("[Scheduled] Memory search backfill unavailable", {
				orgId: org.id,
				error: error instanceof Error ? error.name : "unknown",
			});
		}
		try {
			// Drain each org in resumable 100-fact pages; recall skips the legacy
			// fallback once an org's marker is done, so finish within days, not years.
			while (citationFactsBackfilled < CITATION_BACKFILL_BUDGET) {
				const page = await backfillFactCitations(
					db,
					org.id,
					CITATION_BACKFILL_BUDGET - citationFactsBackfilled,
				);
				citationFactsBackfilled += page;
				if (page < 100) break;
			}
		} catch (error) {
			console.warn("[Scheduled] Memory citation backfill unavailable", {
				orgId: org.id,
				error: error instanceof Error ? error.name : "unknown",
			});
		}
		const instance = await env.MEMORY_REFLECTION_WORKFLOW.create({
			id: `reflection-${org.id}-${runId}`,
			params: {
				organizationId: org.id,
				scope: "full" as const,
			},
		});
		console.log(
			`[Scheduled] MemoryReflectionWorkflow started for org ${org.id}: ${instance.id}`,
		);
	}

	return {
		searchRowsBackfilled,
		citationFactsBackfilled,
		organizationsDispatched: orgs.length,
		workflowsDispatched: orgs.length,
	};
}
