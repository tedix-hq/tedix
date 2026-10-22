import { implement } from "@orpc/server";
import { sitesContract } from "@tedix/api-contract/contracts/sites";
import { getAppMetadataJson } from "@tedix/db/queries/app-records";
import { getAggregateAppLinkTargets } from "@tedix/db/queries/aggregate-app-links";
import { getCmsSiteByIdForOrganization } from "@tedix/db/queries/cms-sites";
import { getDocsSiteById } from "@tedix/db/queries/docs-sites/sites";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { requireOrgId } from "../org-scope";
import { type BaseContext, createError, ErrorCodes, withAuth } from "../orpc";

export const sitesOs = implement(sitesContract).$context<BaseContext>();
export const authedSitesOs = sitesOs.use(withAuth);
export function aggregateEntries(app: { metadata: unknown }) {
	const entries = getAppMetadataJson(app as never)?.mcpConfig?.aggregateApps;
	return Array.isArray(entries)
		? (entries as Array<{
				slug: string;
				appId?: string;
				[key: string]: unknown;
			}>)
		: [];
}

/** The platform CMS app that every authoring proxy links to by id. */
export async function getPlatformCmsApp(db: BaseContext["db"]) {
	const [cmsApp] = await getAggregateAppLinkTargets(db, {
		ids: [],
		slugs: ["cms"],
	});
	return cmsApp ?? null;
}

export async function requireCmsSite(context: BaseContext, siteId: string) {
	const site = await getCmsSiteByIdForOrganization(context.db, {
		id: siteId,
		organizationId: requireOrgId(context),
	});
	if (!site) throw createError(ErrorCodes.NOT_FOUND, "CMS site not found");
	return site;
}

export async function requireOwnedSite(context: BaseContext, siteId: string) {
	const organizationId = requireOrgId(context);
	const organization = await getOrganizationById(context.db, organizationId);
	if (!organization)
		throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
	const cms = await getCmsSiteByIdForOrganization(context.db, {
		id: siteId,
		organizationId,
	});
	if (cms) return { type: "cms" as const, site: cms, organization };
	const docs = await getDocsSiteById(context.db, siteId);
	if (docs?.orgSlug === organization.slug)
		return { type: "docs" as const, site: docs, organization };
	throw createError(ErrorCodes.NOT_FOUND, "Site not found");
}
