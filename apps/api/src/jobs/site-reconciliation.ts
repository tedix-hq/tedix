/// <reference path="../../worker-configuration.d.ts" />

export async function runSiteReconciliationTick(
	env: CloudflareEnv,
): Promise<Record<string, number>> {
	const { coreDb } = await import("@tedix/db/core-store/scope");
	const { listSiteReconciliationOrganizations } =
		await import("@tedix/db/queries/site-reconciliation");
	const { reconcileOrganizationSites } =
		await import("../services/site-reconciliation");
	const { inspectCmsMediaResource } =
		await import("../services/cms-media-resources");
	const db = coreDb(env);
	const organizations = await listSiteReconciliationOrganizations(db, 100);
	let sites = 0;
	let findings = 0;
	for (const organization of organizations) {
		const result = await reconcileOrganizationSites({
			db,
			organizationId: organization.id,
			source: "scheduled",
			inspectCmsMedia: async (slug) =>
				(await inspectCmsMediaResource(env, slug)).state,
		});
		if (result) {
			sites += result.sitesChecked;
			findings += result.issues.length;
		}
	}
	return {
		organizations: organizations.length,
		sites,
		findings,
	};
}
