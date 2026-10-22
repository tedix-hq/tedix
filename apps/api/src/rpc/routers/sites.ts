import { auditActor, emitAuditEvent } from "../audit-helpers";
import { loadUserTenantEditorialIdentity } from "@tedix/auth/descope";
import { isUserToken } from "@tedix/auth/jwt";
import { buildTedixMcpResourceUri } from "@tedix/auth/aih-audiences";
import { isPlatformPrincipal } from "@tedix/auth/types";
import { createApp, getAppMetadataJson } from "@tedix/db/queries/app-records";
import {
	aggregateAppEntryMatches,
	aggregateAppLink,
} from "@tedix/db/queries/aggregate-app-links";
import { getAppBySlug, getAppsByOrganization } from "@tedix/db/queries/apps";
import {
	activateCmsSiteAfterMedia,
	getCmsSiteBySlug,
	getCmsSiteById,
	getCmsSiteByHostname,
	registerCmsSiteIfAbsent,
	registerCmsSiteWithinQuota,
	listCmsSitesByOrganization,
	pauseCmsSiteUnlessRestoring,
	restoreCmsSiteUnlessDeprovisioning,
} from "@tedix/db/queries/cms-sites";
import {
	listDocsSites,
	setDocsSiteStatus,
} from "@tedix/db/queries/docs-sites/sites";
import {
	getOrganizationById,
	getOrganizationFeatures,
} from "@tedix/db/queries/organizations";
import type { AppMetadata } from "@tedix/db/schema/apps";
import { DEFAULT_ORGANIZATION_FEATURES_BY_PLAN } from "@tedix/db/schema/organizations";
import { getLatestSiteReconciliation } from "@tedix/db/queries/site-reconciliation";
import { getTenantBundleSummary } from "@tedix/db/queries/tenant-bundles";
import { requireOrgId } from "../org-scope";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	skipOutputValidation,
	withAuthorization,
} from "../orpc";
import { reconcileOrganizationSites } from "../../services/site-reconciliation";
import {
	inspectCmsMediaResource,
	repairCmsMediaResource,
} from "../../services/cms-media-resources";
import {
	sitesOs,
	authedSitesOs,
	aggregateEntries,
	getPlatformCmsApp,
	requireOwnedSite,
} from "./sites-shared";
import {
	updateCmsDomainProcedure,
	beginCmsDomainProcedure,
	getCmsDomainProcedure,
	verifyCmsDomainProcedure,
	removeCmsDomainProcedure,
} from "./sites-domains";
import {
	getRecoveryManifestProcedure,
	startCmsRecoveryCaptureProcedure,
	getCmsRecoveryCaptureProcedure,
	purgeCmsRecoveryCaptureProcedure,
	startCmsSiteRestoreProcedure,
	getCmsSiteRestoreProcedure,
} from "./sites-recovery";
import {
	getDeprovisionPlanProcedure,
	deprovisionSiteProcedure,
	getDeprovisionStatusProcedure,
} from "./sites-deprovision";

const STARTER_CMS_SITE_QUOTA =
	DEFAULT_ORGANIZATION_FEATURES_BY_PLAN.starter.maxCmsSites ?? 1;

/** Media creation starts only after the exact non-serving site is registered. */
async function provisionAndActivateCmsSite(
	context: BaseContext,
	site: NonNullable<Awaited<ReturnType<typeof getCmsSiteBySlug>>>,
) {
	try {
		await repairCmsMediaResource(context.env, site.slug, "create", site.id);
	} catch (error) {
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			`CMS media provisioning failed: ${error instanceof Error ? error.message : String(error)}`,
			error,
		);
	}
	const active = await activateCmsSiteAfterMedia(context.db, {
		siteId: site.id,
		slug: site.slug,
	});
	if (!active)
		throw createError(
			ErrorCodes.CONFLICT,
			"CMS site activation was denied by deprovision or restore state",
		);
	return active;
}

/** The app slug and source must both match: a same-name app is not reusable by itself. */
function isCmsAuthoringProxy(
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

export const createCmsSiteProcedure = authedSitesOs.createCms
	.use(withAuthorization("settings:manage", "mcp:content.admin"))
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const organization = await getOrganizationById(context.db, organizationId);
		if (!organization)
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		const appSlug = `cms-${input.slug}`;
		const url = `https://${input.slug}.cms.tedix.dev`;
		const existing = await getCmsSiteBySlug(context.db, input.slug);
		if (
			existing &&
			(existing.organizationId !== organizationId ||
				existing.name !== input.name ||
				existing.templateSlug !== input.templateSlug ||
				!existing.authoringAppId)
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"CMS site slug already belongs to a different site configuration",
			);
		let maxCmsSites = -1;
		if (!existing) {
			const features = await getOrganizationFeatures(
				context.db,
				organizationId,
			);
			maxCmsSites =
				features?.maxCmsSites ??
				organization.features?.maxCmsSites ??
				STARTER_CMS_SITE_QUOTA;
			if (!Number.isSafeInteger(maxCmsSites) || maxCmsSites < -1)
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"Invalid CMS site quota",
				);
			if (
				maxCmsSites !== -1 &&
				(await listCmsSitesByOrganization(context.db, organizationId)).length >=
					maxCmsSites
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					`CMS site limit reached (${maxCmsSites}). Deprovision a site or change the plan to create another.`,
				);
		}
		let authoringApp = await getAppBySlug(context.db, appSlug);
		// The authoring proxy links the platform CMS app by its stable id.
		const cmsApp = await getPlatformCmsApp(context.db);
		if (existing && !authoringApp)
			throw createError(
				ErrorCodes.CONFLICT,
				"CMS site authoring app is missing; use recovery operations",
			);
		if (!authoringApp) {
			try {
				authoringApp =
					(await createApp(context.db, {
						organizationId,
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
									cmsApp ? aggregateAppLink(cmsApp) : { slug: "cms" },
								],
							},
						} as AppMetadata,
					})) ?? null;
			} catch (error) {
				// A concurrent request may have won the global app-slug constraint.
				authoringApp = await getAppBySlug(context.db, appSlug);
				if (!authoringApp) throw error;
			}
		}
		if (
			!authoringApp ||
			!isCmsAuthoringProxy(authoringApp, organizationId, input.slug, cmsApp)
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"CMS authoring app slug already belongs to another resource",
			);

		if (existing && existing.authoringAppId !== authoringApp.id)
			throw createError(
				ErrorCodes.CONFLICT,
				"CMS site slug already belongs to a different site configuration",
			);
		// The D1 insert reserves quota and a unique slug before any provider write.
		// A losing concurrent create can only reuse the winning row after exact
		// organization, authoring app, and configuration checks below.
		let site =
			existing ??
			(await registerCmsSiteWithinQuota(
				context.db,
				{
					id: crypto.randomUUID(),
					organizationId,
					slug: input.slug,
					name: input.name,
					status: "provisioning",
					authoringAppId: authoringApp.id,
					templateSlug: input.templateSlug,
					customDomain: null,
					canonicalUrl: url,
					config: { blog: { defaultLocale: "en" } },
				},
				maxCmsSites,
			)) ??
			(await getCmsSiteBySlug(context.db, input.slug));
		if (!site)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"CMS site limit reached while creating the site. Deprovision a site or change the plan to create another.",
			);
		if (
			site.organizationId !== organizationId ||
			site.name !== input.name ||
			site.templateSlug !== input.templateSlug ||
			site.authoringAppId !== authoringApp.id
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"CMS site slug already belongs to a different site configuration",
			);
		if (site.status === "provisioning")
			site = await provisionAndActivateCmsSite(context, site);
		else if (site.status === "active") {
			try {
				await repairCmsMediaResource(context.env, site.slug, "repair", site.id);
			} catch (error) {
				throw createError(
					ErrorCodes.BAD_GATEWAY,
					`CMS media repair failed: ${error instanceof Error ? error.message : String(error)}`,
					error,
				);
			}
		}
		const bundle = await getTenantBundleSummary(context.db, site.slug);
		return {
			siteId: site.id,
			slug: site.slug,
			url: site.canonicalUrl,
			readyForAuthoring: site.status === "active",
			published: site.status === "active" && bundle.activeVersion !== null,
		};
	});

export const registerCmsSiteProcedure = authedSitesOs.registerCms
	.use(withAuthorization("settings:manage", "mcp:content.admin"))
	.handler(async ({ input, context }) => {
		if (!isPlatformPrincipal(context))
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Platform administrator required to register provisioned CMS resources",
			);
		const organizationId = requireOrgId(context);
		const organization = await getOrganizationById(context.db, organizationId);
		if (!organization)
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		const apps = await getAppsByOrganization(context.db, organizationId);
		const authoringApp = apps.find((app) => app.id === input.authoringAppId);
		const cmsApp = await getPlatformCmsApp(context.db);
		const config = authoringApp
			? getAppMetadataJson(authoringApp as never)?.mcpConfig
			: null;
		if (
			!config ||
			config.connectionLabel !== input.slug ||
			!authoringApp ||
			!aggregateEntries(authoringApp).some((entry) =>
				aggregateAppEntryMatches(
					entry,
					cmsApp ? aggregateAppLink(cmsApp) : { appId: null, slug: "cms" },
				),
			)
		)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Authoring app must belong to this organization and target this CMS site",
			);
		const existing = await getCmsSiteBySlug(context.db, input.slug);
		const hostnameSite = input.customDomain
			? await getCmsSiteByHostname(context.db, input.customDomain)
			: null;
		if (hostnameSite && hostnameSite.id !== existing?.id)
			throw createError(
				ErrorCodes.CONFLICT,
				"CMS hostname already belongs to a site",
			);
		const canonicalUrl = `https://${input.customDomain ?? `${input.slug}.cms.tedix.dev`}`;
		let site =
			existing ??
			(await registerCmsSiteIfAbsent(context.db, {
				id: crypto.randomUUID(),
				organizationId,
				slug: input.slug,
				name: input.name,
				status: "provisioning",
				authoringAppId: input.authoringAppId,
				templateSlug: input.templateSlug,
				customDomain: input.customDomain ?? null,
				canonicalUrl,
				config: { blog: { defaultLocale: "en" } },
			})) ??
			(await getCmsSiteBySlug(context.db, input.slug));
		if (
			!site ||
			site.organizationId !== organizationId ||
			site.authoringAppId !== input.authoringAppId ||
			site.name !== input.name ||
			site.templateSlug !== input.templateSlug ||
			site.customDomain !== (input.customDomain ?? null) ||
			site.canonicalUrl !== canonicalUrl ||
			site.status === "paused"
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"CMS site slug already belongs to a different site configuration",
			);
		if (site.status === "provisioning")
			site = await provisionAndActivateCmsSite(context, site);
		return { siteId: site.id, slug: site.slug, url: site.canonicalUrl };
	});

export const listSitesProcedure = authedSitesOs.list
	.use(withAuthorization("apps:read", "mcp:content.read"))
	.handler(async ({ context }) => {
		const organizationId = requireOrgId(context);
		const organization = await getOrganizationById(context.db, organizationId);
		if (!organization)
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		const [cms, docs, features] = await Promise.all([
			listCmsSitesByOrganization(context.db, organizationId),
			listDocsSites(context.db, organization.slug),
			getOrganizationFeatures(context.db, organizationId),
		]);
		const cmsWithBundles = await Promise.all(
			cms.map(async (site) => ({
				site,
				bundle: await getTenantBundleSummary(context.db, site.slug),
			})),
		);
		return {
			cmsCustomDomainsEnabled:
				features?.customDomain ?? organization.features?.customDomain ?? false,
			cmsSiteQuota: {
				used: cms.length,
				limit:
					features?.maxCmsSites ??
					organization.features?.maxCmsSites ??
					STARTER_CMS_SITE_QUOTA,
			},
			sites: [
				...cmsWithBundles.map(({ site, bundle }) => ({
					id: site.id,
					type: "cms" as const,
					slug: site.slug,
					name: site.name,
					description: site.description,
					status: site.status,
					url: site.canonicalUrl,
					accessMode: null,
					customDomain: site.customDomain,
					activeRevisionId:
						bundle.activeVersion === null ? null : String(bundle.activeVersion),
					mcpAppId: site.mcpAppId,
					authoringAppId: site.authoringAppId,
				})),
				...docs.map((site) => ({
					id: site.id,
					type: "docs" as const,
					slug: site.slug,
					name: site.title,
					description: site.description || null,
					status: site.status,
					url: site.canonicalUrl,
					accessMode: site.accessMode,
					customDomain: new URL(site.canonicalUrl).hostname.endsWith(
						".tedix.dev",
					)
						? null
						: new URL(site.canonicalUrl).hostname,
					activeRevisionId: site.activeBuildId,
					mcpAppId: null,
					authoringAppId: null,
				})),
			].sort((a, b) => a.name.localeCompare(b.name)),
		};
	});

export const setLifecycleProcedure = authedSitesOs.setLifecycle
	.use(withAuthorization("settings:manage", "mcp:content.admin"))
	.handler(async ({ input, context }) => {
		const owned = await requireOwnedSite(context, input.siteId);
		if (input.confirmation !== owned.site.slug)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Type ${owned.site.slug} to confirm`,
			);
		const status =
			input.action === "archive" ? ("paused" as const) : ("active" as const);
		if (owned.type === "cms") {
			if (status === "active") {
				const restored = await restoreCmsSiteUnlessDeprovisioning(context.db, {
					id: owned.site.id,
					organizationId: owned.organization.id,
					authoringAppId: owned.site.authoringAppId,
				});
				if (!restored)
					throw createError(
						ErrorCodes.CONFLICT,
						"CMS site is being deprovisioned or changed concurrently",
					);
			} else {
				const paused = await pauseCmsSiteUnlessRestoring(context.db, {
					id: owned.site.id,
					organizationId: owned.organization.id,
					authoringAppId: owned.site.authoringAppId,
				});
				if (!paused)
					throw createError(
						ErrorCodes.CONFLICT,
						"CMS site is being restored, deprovisioned, or changed concurrently",
					);
			}
		} else {
			const updated = await setDocsSiteStatus(context.db, {
				id: owned.site.id,
				orgSlug: owned.organization.slug,
				status,
			});
			if (!updated)
				throw createError(
					ErrorCodes.CONFLICT,
					"Site lifecycle changed concurrently",
				);
		}
		return {
			siteId: owned.site.id,
			slug: owned.site.slug,
			type: owned.type,
			status,
		};
	});

export const getSiteReconciliationProcedure = authedSitesOs.getReconciliation
	.use(withAuthorization("apps:read", "mcp:content.read"))
	.handler(async ({ context }) => {
		const organizationId = requireOrgId(context);
		const latest = await getLatestSiteReconciliation(
			context.db,
			organizationId,
		);
		return latest
			? {
					runId: latest.run.id,
					source: latest.run.source,
					checkedAt: latest.run.completedAt,
					sitesChecked: latest.run.sitesChecked,
					issues: latest.findings.map((finding) => ({
						siteId: finding.siteId,
						slug: finding.siteSlug,
						type: finding.siteType,
						code: finding.code,
						severity: finding.severity,
						detail: finding.detail,
					})),
				}
			: null;
	});

export const runSiteReconciliationProcedure = authedSitesOs.runReconciliation
	.use(withAuthorization("settings:manage", "mcp:content.admin"))
	.handler(async ({ context }) => {
		const result = await reconcileOrganizationSites({
			db: context.db,
			organizationId: requireOrgId(context),
			source: "manual",
			inspectCmsMedia: async (slug) =>
				(await inspectCmsMediaResource(context.env, slug)).state,
		});
		if (!result)
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		return { ...result, source: "manual" as const };
	});

export const repairCmsMediaProcedure = authedSitesOs.repairCmsMedia
	.use(withAuthorization("settings:manage", "mcp:content.admin"))
	.handler(async ({ input, context }) => {
		if (!isPlatformPrincipal(context))
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Platform administrator required to provision CMS infrastructure",
			);
		const site = await getCmsSiteBySlug(context.db, input.slug);
		if (!site) throw createError(ErrorCodes.NOT_FOUND, "CMS site not found");
		try {
			const result = await repairCmsMediaResource(
				context.env,
				site.slug,
				"repair",
				site.id,
			);
			return {
				siteId: site.id,
				slug: site.slug,
				...result,
				state: "ready" as const,
			};
		} catch (error) {
			throw createError(
				ErrorCodes.BAD_GATEWAY,
				`CMS media repair failed: ${error instanceof Error ? error.message : String(error)}`,
				error,
			);
		}
	});

/** Bind the authenticated editor to the exact site's live editorial tenant; OS membership is independent. */
async function requireCmsEditorAccess(context: BaseContext, siteId: string) {
	if (
		context.authType !== "user" ||
		!context.user ||
		!isUserToken(context.user)
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"A signed-in CMS editor session is required",
		);
	const subject = context.descopeUserId ?? context.user.sub;
	if (!subject)
		throw createError(ErrorCodes.FORBIDDEN, "Editor identity is missing");
	const site = await getCmsSiteById(context.db, siteId);
	if (!site || site.status !== "active")
		throw createError(ErrorCodes.NOT_FOUND, "CMS site unavailable");
	const owner = await getOrganizationById(context.db, site.organizationId);
	if (!owner || (owner.metadata as Record<string, unknown> | null)?.retiredAt)
		throw createError(ErrorCodes.NOT_FOUND, "CMS site unavailable");
	const configured = site.config?.blog?.authDescopeTenantId;
	const tenantId =
		typeof configured === "string" && configured
			? configured
			: owner.descopeTenantId;
	const editorial = tenantId
		? await loadUserTenantEditorialIdentity(context.env, subject, tenantId)
		: null;
	if (
		!editorial ||
		!editorial.roles.some((role) =>
			[
				"platform-admin",
				"owner",
				"admin",
				"Org Admin",
				"editor",
				"Content Manager",
				"member",
				"Member",
			].includes(role),
		)
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Current CMS editorial membership is required",
		);
	return site;
}

export const proposeCmsEditorDraftProcedure =
	authedSitesOs.proposeCmsEditorDraft
		.use(
			withAuthorization(
				{
					handlerOwnedUserAuthorization:
						"Fresh CMS editorial tenant membership authorizes this user for the exact site independently of OS membership",
				},
				"mcp:content.write",
			),
		)
		.handler(async ({ input, context }) => {
			const site = await requireCmsEditorAccess(context, input.siteId);
			const { proposeCmsEditorDraft } =
				await import("../../services/cms-editor-proposals");
			const proposal = await proposeCmsEditorDraft(
				context.env,
				site.organizationId,
				input,
			);
			const actor = auditActor(context);
			await emitAuditEvent(context.db, {
				organizationId: site.organizationId,
				actorId: actor.actorId,
				actorType: actor.actorType,
				action: "cms.editor.proposed",
				resourceType: "cms_site",
				resourceId: site.id,
				metadata: {
					action: input.action,
					collection: input.draft.collection,
					entryId: input.draft.entryId,
					locale: input.draft.locale,
					invocationId: input.draft.invocationId,
				},
			});
			return proposal;
		});

export const sitesContractRouter = sitesOs.router({
	proposeCmsEditorDraft: proposeCmsEditorDraftProcedure,
	createCms: createCmsSiteProcedure,
	registerCms: registerCmsSiteProcedure,
	updateCmsDomain: updateCmsDomainProcedure,
	beginCmsDomain: beginCmsDomainProcedure,
	getCmsDomain: getCmsDomainProcedure,
	verifyCmsDomain: verifyCmsDomainProcedure,
	removeCmsDomain: removeCmsDomainProcedure,
	list: skipOutputValidation(listSitesProcedure),
	getRecoveryManifest: getRecoveryManifestProcedure,
	startCmsRecoveryCapture: startCmsRecoveryCaptureProcedure,
	getCmsRecoveryCapture: getCmsRecoveryCaptureProcedure,
	purgeCmsRecoveryCapture: purgeCmsRecoveryCaptureProcedure,
	startCmsSiteRestore: startCmsSiteRestoreProcedure,
	getCmsSiteRestore: getCmsSiteRestoreProcedure,
	setLifecycle: setLifecycleProcedure,
	getReconciliation: getSiteReconciliationProcedure,
	runReconciliation: runSiteReconciliationProcedure,
	repairCmsMedia: repairCmsMediaProcedure,
	getDeprovisionPlan: getDeprovisionPlanProcedure,
	deprovision: deprovisionSiteProcedure,
	getDeprovisionStatus: getDeprovisionStatusProcedure,
});
