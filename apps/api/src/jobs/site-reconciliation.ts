/// <reference path="../../worker-configuration.d.ts" />

export async function runSiteReconciliationTick(
	env: CloudflareEnv,
): Promise<Record<string, number>> {
	const { createDbClient } = await import("@tedix/db/client");
	const { listSiteReconciliationOrganizations } =
		await import("@tedix/db/queries/site-reconciliation");
	const { reconcileOrganizationSites } =
		await import("../services/site-reconciliation");
	const { inspectCmsMediaResource } =
		await import("../services/cms-media-resources");
	const db = createDbClient(env.DB);
	const domains = await adoptUnclaimedCmsCustomDomains(db, env);
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
		...domains,
	};
}

/**
 * Give every routed custom domain a claim. A hostname already served by a
 * ready Cloudflare custom hostname is adopted as active without touching the
 * route or its ownership; anything else stays as it is and is counted.
 */
async function adoptUnclaimedCmsCustomDomains(
	db: import("@tedix/db/client").DbClient,
	env: CloudflareEnv,
): Promise<{ domainsAdopted: number; domainsUnclaimed: number }> {
	if (!env.CF_CMS_SAAS_ZONE_ID || !env.CF_CMS_HOSTNAMES_TOKEN)
		return { domainsAdopted: 0, domainsUnclaimed: 0 };
	const {
		listUnclaimedCmsCustomDomains,
		reserveCmsDomainClaim,
		adoptLegacyCmsDomainClaim,
	} = await import("@tedix/db/queries/cms-domain-claims");
	const {
		createCmsDomainVerificationToken,
		findCmsCustomHostname,
		isCmsCustomHostnameReady,
	} = await import("../services/cms-custom-hostnames");
	let domainsAdopted = 0;
	let domainsUnclaimed = 0;
	for (const site of await listUnclaimedCmsCustomDomains(db)) {
		const provider = await findCmsCustomHostname(env, site.hostname);
		const claim =
			provider && isCmsCustomHostnameReady(provider)
				? await reserveCmsDomainClaim(db, {
						id: crypto.randomUUID(),
						organizationId: site.organizationId,
						siteId: site.siteId,
						hostname: site.hostname,
						verificationToken: createCmsDomainVerificationToken(),
						expiresAt: new Date(
							Date.now() + 7 * 24 * 60 * 60 * 1000,
						).toISOString(),
					})
				: null;
		const adopted =
			provider && claim
				? await adoptLegacyCmsDomainClaim(db, {
						id: claim.id,
						organizationId: site.organizationId,
						siteId: site.siteId,
						providerHostnameId: provider.id,
					})
				: null;
		if (adopted) domainsAdopted++;
		else domainsUnclaimed++;
	}
	return { domainsAdopted, domainsUnclaimed };
}
