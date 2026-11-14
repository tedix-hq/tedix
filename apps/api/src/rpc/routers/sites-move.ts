import { isPlatformPrincipal } from "@tedix/auth/types";
import {
	deleteApp,
	setAppGatewayMembership,
} from "@tedix/db/queries/app-records";
import {
	aggregateAppEntryMatches,
	aggregateAppLink,
} from "@tedix/db/queries/aggregate-app-links";
import { getAppBySlug, getAppsByOrganization } from "@tedix/db/queries/apps";
import {
	getCmsSiteByIdForOrganization,
	listCmsSitesByOrganization,
	moveCmsSiteToOrganization,
	setCmsSiteAuthoringApp,
} from "@tedix/db/queries/cms-sites";
import { getOrganizationAggregatorGateways } from "@tedix/db/queries/organization-members";
import {
	getOrganizationById,
	getOrganizationFeatures,
} from "@tedix/db/queries/organizations";
import { DEFAULT_ORGANIZATION_FEATURES_BY_PLAN } from "@tedix/db/schema/organizations";
import { auditActor, emitAuditEvent } from "../audit-helpers";
import { requireOrgId } from "../org-scope";
import { createError, ErrorCodes, withAuthorization } from "../orpc";
import { purgeMcpDiscoveryCache } from "./app-discovery-cache";
import {
	aggregateEntries,
	authedSitesOs,
	createCmsAuthoringApp,
	getPlatformCmsApp,
	isCmsAuthoringProxy,
} from "./sites-shared";

/**
 * Move a CMS site from the caller's organization to another one. The site row
 * and its domain claims move in one D1 batch; the authoring app is then
 * replaced by a fresh one in the target. Every step reads current state first,
 * so a call that stopped halfway is finished by calling it again.
 */
export const moveCmsSiteProcedure = authedSitesOs.moveCms
	.use(withAuthorization("settings:manage", "mcp:content.admin"))
	.handler(async ({ input, context }) => {
		if (!isPlatformPrincipal(context))
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Platform administrator required to move a CMS site",
			);
		const { db } = context;
		const sourceId = requireOrgId(context);
		const targetId = input.targetOrganizationId;
		if (targetId === sourceId)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"The site already belongs to this organization",
			);
		const target = await getOrganizationById(db, targetId);
		if (
			!target ||
			(target.metadata as Record<string, unknown> | null)?.retiredAt
		)
			throw createError(ErrorCodes.NOT_FOUND, "Target organization not found");

		const owned = await getCmsSiteByIdForOrganization(db, {
			id: input.siteId,
			organizationId: sourceId,
		});
		if (owned) {
			if (input.confirmation !== owned.slug)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`Type ${owned.slug} to confirm`,
				);
			const maxCmsSites =
				(await getOrganizationFeatures(db, targetId))?.maxCmsSites ??
				target.features?.maxCmsSites ??
				DEFAULT_ORGANIZATION_FEATURES_BY_PLAN.starter.maxCmsSites ??
				1;
			if (
				maxCmsSites !== -1 &&
				(await listCmsSitesByOrganization(db, targetId)).length >= maxCmsSites
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					`Target organization reached its CMS site limit (${maxCmsSites})`,
				);
			if (
				!(await moveCmsSiteToOrganization(db, {
					id: owned.id,
					fromOrganizationId: sourceId,
					toOrganizationId: targetId,
				}))
			)
				throw createError(
					ErrorCodes.CONFLICT,
					"Only an active CMS site with no restore or deprovision in progress can move",
				);
		}
		const site = await getCmsSiteByIdForOrganization(db, {
			id: input.siteId,
			organizationId: targetId,
		});
		if (!site) throw createError(ErrorCodes.NOT_FOUND, "CMS site not found");
		if (input.confirmation !== site.slug)
			throw createError(ErrorCodes.BAD_REQUEST, `Type ${site.slug} to confirm`);

		const cmsApp = await getPlatformCmsApp(db);
		let app = await getAppBySlug(db, `cms-${site.slug}`);
		let wasLinked = false;
		if (app && app.organizationId !== targetId) {
			if (app.organizationId !== sourceId || app.id !== site.authoringAppId)
				throw createError(
					ErrorCodes.CONFLICT,
					"CMS authoring app slug already belongs to another resource",
				);
			const link = aggregateAppLink(app);
			const linking = (await getAppsByOrganization(db, sourceId)).filter(
				(candidate) =>
					aggregateEntries(candidate).some((entry) =>
						aggregateAppEntryMatches(entry, link),
					),
			);
			wasLinked = linking.length > 0;
			await deleteApp(db, app.id);
			await Promise.all(
				linking.map((gateway) =>
					purgeMcpDiscoveryCache(context.env, gateway.id, [gateway]),
				),
			);
			app = null;
		}
		app ??= await createCmsAuthoringApp(db, {
			organizationId: targetId,
			slug: site.slug,
			name: site.name,
			cmsApp,
		});
		if (!app || !isCmsAuthoringProxy(app, targetId, site.slug, cmsApp))
			throw createError(
				ErrorCodes.CONFLICT,
				"CMS authoring app slug already belongs to another resource",
			);
		if (
			site.authoringAppId !== app.id &&
			!(await setCmsSiteAuthoringApp(db, {
				id: site.id,
				organizationId: targetId,
				authoringAppId: app.id,
			}))
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"CMS site changed during the move",
			);

		// The site keeps the gateway availability it had in the source.
		let gatewayLinked = false;
		const gatewaySlug = wasLinked
			? (await getOrganizationAggregatorGateways(db, [targetId])).get(targetId)
					?.slug
			: undefined;
		const gateway = gatewaySlug ? await getAppBySlug(db, gatewaySlug) : null;
		if (gateway && gateway.organizationId === targetId) {
			gatewayLinked =
				(
					await setAppGatewayMembership(
						db,
						targetId,
						gateway.id,
						aggregateAppLink(app),
						true,
					)
				).length === 1;
			await purgeMcpDiscoveryCache(context.env, gateway.id, [gateway]);
		}

		const actor = auditActor(context);
		for (const organizationId of [sourceId, targetId])
			await emitAuditEvent(db, {
				organizationId,
				actorId: actor.actorId,
				actorType: actor.actorType,
				action: "cms.site.moved",
				resourceType: "cms_site",
				resourceId: site.id,
				metadata: {
					slug: site.slug,
					fromOrganizationId: sourceId,
					toOrganizationId: targetId,
				},
			});
		return {
			siteId: site.id,
			slug: site.slug,
			organizationId: targetId,
			authoringAppId: app.id,
			gatewayLinked,
		};
	});
