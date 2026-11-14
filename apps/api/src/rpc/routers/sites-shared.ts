import { implement } from "@orpc/server";
import { sitesContract } from "@tedix/api-contract/contracts/sites";
import { buildTedixMcpResourceUri } from "@tedix/auth/aih-audiences";
import { createApp, getAppMetadataJson } from "@tedix/db/queries/app-records";
import {
	aggregateAppEntryMatches,
	aggregateAppLink,
	getAggregateAppLinkTargets,
} from "@tedix/db/queries/aggregate-app-links";
import type { getAppBySlug } from "@tedix/db/queries/apps";
import { getCmsSiteByIdForOrganization } from "@tedix/db/queries/cms-sites";
import { getDocsSiteById } from "@tedix/db/queries/docs-sites/sites";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import type { AppMetadata } from "@tedix/db/schema/apps";
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

/** The app slug and source must both match: a same-name app is not reusable by itself. */
export function isCmsAuthoringProxy(
	app: NonNullable<Awaited<ReturnType<typeof getAppBySlug>>>,
	organizationId: string,
	slug: string,
	cmsApp: { id: string; slug: string } | null | undefined,
): boolean {
	const config = getAppMetadataJson(app)?.mcpConfig;
	const entry: unknown = Array.isArray(config?.aggregateApps)
		? config.aggregateApps[0]
		: undefined;
	return (
		app.organizationId === organizationId &&
		app.visibility === "private" &&
		config?.authMode === "authenticated" &&
		config.codeMode === true &&
		config.expectedAudience === buildTedixMcpResourceUri(app.slug) &&
		config?.connectionLabel === slug &&
		Array.isArray(config.aggregateApps) &&
		config.aggregateApps.length === 1 &&
		aggregateAppEntryMatches(
			entry,
			cmsApp ? aggregateAppLink(cmsApp) : { appId: null, slug: "cms" },
		) &&
		Object.keys(entry ?? {}).every((key) => key === "slug" || key === "appId")
	);
}

/** The private proxy app that exposes one CMS site's authoring tools. */
export async function createCmsAuthoringApp(
	db: BaseContext["db"],
	input: {
		organizationId: string;
		slug: string;
		name: string;
		cmsApp: { id: string; slug: string } | null | undefined;
	},
) {
	const appSlug = `cms-${input.slug}`;
	return (
		(await createApp(db, {
			organizationId: input.organizationId,
			slug: appSlug,
			name: `${input.name} CMS authoring`,
			description: `Authoring tools for ${input.name}`,
			visibility: "private",
			discoveryStatus: "pending",
			metadata: {
				mcpConfig: {
					authMode: "authenticated",
					codeMode: true,
					expectedAudience: buildTedixMcpResourceUri(appSlug),
					connectionLabel: input.slug,
					aggregateApps: [
						input.cmsApp ? aggregateAppLink(input.cmsApp) : { slug: "cms" },
					],
				},
			} as AppMetadata,
		})) ?? null
	);
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
