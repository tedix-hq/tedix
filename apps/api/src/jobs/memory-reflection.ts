/// <reference path="../../worker-configuration.d.ts" />
/**
 * 4am UTC per-org memory reflection + catalog enrichment dispatch, extracted
 * verbatim from worker-app.ts's scheduled() handler.
 */

export async function runMemoryReflectionAndEnrichment(
	env: CloudflareEnv,
	runId: string,
): Promise<Record<string, number>> {
	console.log(`[Scheduled] Starting MemoryReflectionWorkflow (${runId})`);
	const { createDbClient } = await import("@tedix/db/client");
	const { listOrganizations } = await import("@tedix/db/queries/organizations");
	const db = createDbClient(env.DB);

	const orgs = await listOrganizations(db);
	for (const org of orgs) {
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

	// Catalog Enrichment (runs after memory reflection in the 4am slot)
	console.log(`[Scheduled] Starting CatalogEnrichmentWorkflow (${runId})`);
	const enrichInstance = await env.CATALOG_ENRICHMENT_WORKFLOW.create({
		id: `enrich-cron-${runId}`,
		params: {
			limit: 10,
			drainAll: false,
			mode: "logo-repair",
			maxChainDepth: 0,
		},
	});
	console.log(
		`[Scheduled] CatalogEnrichmentWorkflow started: ${enrichInstance.id}`,
	);
	return {
		organizationsDispatched: orgs.length,
		workflowsDispatched: orgs.length + 1,
	};
}
