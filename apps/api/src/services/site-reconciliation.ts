import type { DbClient } from "@tedix/db/client";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import { listCmsSitesByOrganization } from "@tedix/db/queries/cms-sites";
import { listDocsBuilds } from "@tedix/db/queries/docs-sites/builds";
import { listDocsSites } from "@tedix/db/queries/docs-sites/sites";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import {
	recordSiteReconciliation,
	type SiteFindingInput,
} from "@tedix/db/queries/site-reconciliation";
import { getTenantBundleSummary } from "@tedix/db/queries/tenant-bundles";

export async function reconcileOrganizationSites(input: {
	db: DbClient;
	organizationId: string;
	source: "manual" | "scheduled";
	inspectCmsMedia?: (slug: string) => Promise<"ready" | "missing" | "unknown">;
	now?: Date;
}) {
	const startedAt = (input.now ?? new Date()).toISOString();
	const organization = await getOrganizationById(
		input.db,
		input.organizationId,
	);
	if (!organization) return null;
	const [cms, docs, apps] = await Promise.all([
		listCmsSitesByOrganization(input.db, input.organizationId),
		listDocsSites(input.db, organization.slug),
		getAppsByOrganization(input.db, input.organizationId),
	]);
	const issues: SiteFindingInput[] = [];
	const hostOwners = new Map<string, string>();
	for (const site of cms) {
		if (
			!site.authoringAppId ||
			!apps.some((app) => app.id === site.authoringAppId)
		)
			issues.push({
				siteId: site.id,
				slug: site.slug,
				type: "cms",
				code: "missing_authoring_proxy",
				severity: "error",
				detail: "CMS site has no owned authoring proxy",
			});
		const bundle = await getTenantBundleSummary(input.db, site.slug);
		if (bundle.activeVersion === null)
			issues.push({
				siteId: site.id,
				slug: site.slug,
				type: "cms",
				code: "missing_active_release",
				severity: "error",
				detail: "CMS site has no active bundle",
			});
		if (input.inspectCmsMedia) {
			const mediaState = await input.inspectCmsMedia(site.slug);
			if (mediaState !== "ready")
				issues.push({
					siteId: site.id,
					slug: site.slug,
					type: "cms",
					code:
						mediaState === "missing"
							? "missing_media_bucket"
							: "media_bucket_unverified",
					severity: mediaState === "missing" ? "error" : "warning",
					detail:
						mediaState === "missing"
							? "CMS site media bucket is missing"
							: "CMS site media bucket state could not be verified",
				});
		}
		hostOwners.set(new URL(site.canonicalUrl).hostname, site.id);
	}
	for (const site of docs) {
		const builds = await listDocsBuilds(input.db, site.id);
		if (!site.activeBuildId)
			issues.push({
				siteId: site.id,
				slug: site.slug,
				type: "docs",
				code: "missing_active_release",
				severity: "warning",
				detail: "Docs site has no published build",
			});
		else if (
			!builds.some(
				(build) =>
					build.id === site.activeBuildId && build.status === "complete",
			)
		)
			issues.push({
				siteId: site.id,
				slug: site.slug,
				type: "docs",
				code: "dangling_active_release",
				severity: "error",
				detail: "Docs active build is absent or incomplete",
			});
		const hostname = new URL(site.canonicalUrl).hostname;
		const owner = hostOwners.get(hostname);
		if (owner)
			issues.push({
				siteId: site.id,
				slug: site.slug,
				type: "docs",
				code: "duplicate_hostname",
				severity: "error",
				detail: `Hostname is also assigned to site ${owner}`,
			});
		else hostOwners.set(hostname, site.id);
	}
	const completedAt = new Date().toISOString();
	const runId = crypto.randomUUID();
	await recordSiteReconciliation(input.db, {
		runId,
		organizationId: input.organizationId,
		source: input.source,
		startedAt,
		completedAt,
		sitesChecked: cms.length + docs.length,
		findings: issues,
	});
	return {
		runId,
		source: input.source,
		checkedAt: completedAt,
		sitesChecked: cms.length + docs.length,
		issues,
	};
}
