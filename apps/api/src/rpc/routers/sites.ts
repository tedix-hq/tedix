import { auditActor, emitAuditEvent } from "../audit-helpers";
import { loadUserTenantEditorialIdentity } from "@tedix/auth/descope";
import { isUserToken } from "@tedix/auth/jwt";
import { implement } from "@orpc/server";
import { sitesContract } from "@tedix/api-contract/contracts/sites";
import { buildTedixMcpResourceUri } from "@tedix/auth/aih-audiences";
import { isPlatformPrincipal } from "@tedix/auth/types";
import {
	createApp,
	getAppBySlug,
	getAppMetadataJson,
} from "@tedix/db/queries/app-records";
import {
	aggregateAppEntryMatches,
	aggregateAppLink,
	getAggregateAppLinkTargets,
} from "@tedix/db/queries/aggregate-app-links";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import {
	activateCmsDomainClaim,
	activateCmsWwwAliasClaim,
	adoptLegacyCmsDomainClaim,
	beginCmsDomainProvisioning,
	beginRemovingCmsDomainClaim,
	beginRemovingReplacedCmsDomainClaim,
	finishCmsDomainProvisioning,
	getCmsDomainClaimForSite,
	listCmsDomainClaimsForSite,
	removeCmsDomainClaim,
	reserveCmsDomainClaim,
} from "@tedix/db/queries/cms-domain-claims";
import {
	activateCmsSiteAfterMedia,
	getCmsSiteBySlug,
	getCmsSiteById,
	getCmsSiteByHostname,
	registerCmsSiteIfAbsent,
	registerCmsSiteWithinQuota,
	updateCmsSiteDomain,
	getCmsSiteByIdForOrganization,
	listCmsSitesByOrganization,
	pauseCmsSiteUnlessRestoring,
	restoreCmsSiteUnlessDeprovisioning,
} from "@tedix/db/queries/cms-sites";
import {
	CmsDeprovisionReservationConflictError,
	getCmsDeprovisionOperationForOrganization,
	reserveCmsDeprovisionOperation,
	updateCmsDeprovisionOperation,
} from "@tedix/db/queries/cms-deprovision-operations";
import { listDocsBuilds } from "@tedix/db/queries/docs-sites/builds";
import {
	getDocsSiteById,
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
import {
	getTenantBundleSummary,
	listTenantBundleRecoveryPoints,
} from "@tedix/db/queries/tenant-bundles";
import { requireOrgId } from "../org-scope";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	skipOutputValidation,
	withAuth,
	withAuthorization,
} from "../orpc";
import { reconcileOrganizationSites } from "../../services/site-reconciliation";
import {
	inspectCmsMediaResource,
	repairCmsMediaResource,
} from "../../services/cms-media-resources";
import { inspectCmsProviderResources } from "../../services/cms-provider-resources";
import {
	startCmsRecoveryCapture,
	getCmsRecoveryCapture,
	purgeCmsRecoveryCapture,
	inspectLatestCmsRecoveryCapture,
	startCmsSiteRestore,
	getCmsSiteRestore,
} from "../../services/cms-recovery-resources";
import {
	cmsCustomHostnameTarget,
	cmsDomainVerificationName,
	createCmsCustomHostname,
	createCmsDomainVerificationToken,
	deleteCmsCustomHostname,
	findCmsCustomHostname,
	getCmsCustomHostname,
	isCmsCustomHostnameReady,
	verifyCmsDnsChallenge,
	verifyCmsDnsTarget,
	verifyCmsDnsZoneApex,
	type CmsCustomHostname,
} from "../../services/cms-custom-hostnames";

const sitesOs = implement(sitesContract).$context<BaseContext>();
const authedSitesOs = sitesOs.use(withAuth);
const STARTER_CMS_SITE_QUOTA =
	DEFAULT_ORGANIZATION_FEATURES_BY_PLAN.starter.maxCmsSites ?? 1;

function aggregateEntries(app: { metadata: unknown }) {
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
async function getPlatformCmsApp(db: BaseContext["db"]) {
	const [cmsApp] = await getAggregateAppLinkTargets(db, {
		ids: [],
		slugs: ["cms"],
	});
	return cmsApp ?? null;
}

async function requireCmsSite(context: BaseContext, siteId: string) {
	const site = await getCmsSiteByIdForOrganization(context.db, {
		id: siteId,
		organizationId: requireOrgId(context),
	});
	if (!site) throw createError(ErrorCodes.NOT_FOUND, "CMS site not found");
	return site;
}

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

/** A completed deprovision receipt retains owner authority over private captures. */
async function requireCmsRecoveryOwnership(
	context: BaseContext,
	siteId: string,
) {
	const organizationId = requireOrgId(context);
	const site = await getCmsSiteByIdForOrganization(context.db, {
		id: siteId,
		organizationId,
	});
	if (site) return { id: site.id, slug: site.slug };
	const receipt = await getCmsDeprovisionOperationForOrganization(context.db, {
		siteId,
		organizationId,
	});
	if (receipt?.status === "succeeded")
		return { id: receipt.id, slug: receipt.slug };
	throw createError(ErrorCodes.NOT_FOUND, "CMS recovery capture not found");
}

async function requireCmsDomainSite(
	context: BaseContext,
	siteId: string,
	requireEntitlement = true,
) {
	const site = await requireCmsSite(context, siteId);
	if (site.status !== "active")
		throw createError(
			ErrorCodes.CONFLICT,
			"Restore the CMS site before managing its domain",
		);
	const organizationId = requireOrgId(context);
	const organization = await getOrganizationById(context.db, organizationId);
	if (!organization)
		throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
	const features = await getOrganizationFeatures(context.db, organizationId);
	if (
		requireEntitlement &&
		!(features?.customDomain ?? organization.features?.customDomain ?? false)
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Custom domains are not enabled for this organization",
		);
	if (!context.env.CF_CMS_HOSTNAMES_TOKEN || !context.env.CF_CMS_SAAS_ZONE_ID)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"CMS custom-domain provisioning is not configured",
		);
	return site;
}

type CmsDomainClaim = NonNullable<
	Awaited<ReturnType<typeof getCmsDomainClaimForSite>>
>;

async function cmsDomainStatus(
	context: BaseContext,
	siteSlug: string,
	claim: CmsDomainClaim,
	provider?: CmsCustomHostname | null,
) {
	const hostname =
		provider ??
		(claim.providerHostnameId
			? await getCmsCustomHostname(context.env, claim.providerHostnameId)
			: null);
	const validationRecords: Array<{
		type: "TXT" | "CNAME";
		name: string;
		value: string;
	}> = [];
	if (
		hostname?.ownership_verification?.name &&
		hostname.ownership_verification.value
	)
		validationRecords.push({
			type: "TXT",
			name: hostname.ownership_verification.name,
			value: hostname.ownership_verification.value,
		});
	for (const record of hostname?.ssl?.validation_records ?? []) {
		if (record.txt_name && record.txt_value)
			validationRecords.push({
				type: "TXT",
				name: record.txt_name,
				value: record.txt_value,
			});
		else if (record.cname && record.cname_target)
			validationRecords.push({
				type: "CNAME",
				name: record.cname,
				value: record.cname_target,
			});
	}
	const isZoneApex =
		claim.kind === "primary" &&
		claim.status === "active" &&
		(await verifyCmsDnsZoneApex(claim.hostname).catch(() => false));
	return {
		claimId: claim.id,
		hostname: claim.hostname,
		status:
			claim.status === "removing_provisioning" ||
			claim.status === "removing_legacy"
				? ("removing" as const)
				: claim.status,
		txtName: cmsDomainVerificationName(claim.hostname),
		txtValue: claim.verificationToken,
		cnameTarget: cmsCustomHostnameTarget(context.env, siteSlug),
		providerStatus: hostname?.status ?? null,
		sslStatus: hostname?.ssl?.status ?? null,
		validationRecords,
		isZoneApex,
	};
}

async function cleanupReplacedCmsDomains(
	context: BaseContext,
	siteId: string,
	currentClaimId: string,
) {
	const organizationId = requireOrgId(context);
	const claims = await listCmsDomainClaimsForSite(context.db, {
		organizationId,
		siteId,
	});
	const current = claims.find((claim) => claim.id === currentClaimId);
	for (const old of claims.filter(
		(item) =>
			item.id !== currentClaimId &&
			!(
				item.kind === "www_alias" &&
				item.status === "active" &&
				current?.kind === "primary" &&
				item.hostname === `www.${current.hostname}`
			) &&
			(item.status === "active" || item.status === "removing"),
	)) {
		const key = { id: old.id, organizationId, siteId };
		const removing = await beginRemovingReplacedCmsDomainClaim(context.db, key);
		if (!removing) continue;
		if (removing.providerHostnameId)
			await deleteCmsCustomHostname(
				context.env,
				removing.providerHostnameId,
				removing.hostname,
			);
		await removeCmsDomainClaim(context.db, key);
	}
}

type DeprovisionReceipt = NonNullable<
	Awaited<ReturnType<typeof getCmsDeprovisionOperationForOrganization>>
>;

function deprovisionStatus(receipt: DeprovisionReceipt) {
	return {
		operationId: receipt.id,
		siteId: receipt.id,
		slug: receipt.slug,
		status: receipt.status,
		stage: receipt.stage,
		deleted: receipt.deleted,
		errors: receipt.errors,
	};
}

async function ensureCmsDeprovisionWorkflow(
	context: BaseContext,
	receipt: DeprovisionReceipt,
	allowRestart: boolean,
) {
	if (receipt.status === "succeeded") return receipt;
	let instance: Awaited<
		ReturnType<CloudflareEnv["CMS_DEPROVISION_WORKFLOW"]["get"]>
	> | null = null;
	try {
		instance = await context.env.CMS_DEPROVISION_WORKFLOW.get(receipt.id);
	} catch {
		// A receipt may be committed just before dispatch. Its deterministic
		// Workflow ID lets the next request safely complete that dispatch.
	}
	if (instance) {
		const native = await instance.status();
		if (native.status === "errored" || native.status === "terminated") {
			if (allowRestart) {
				await updateCmsDeprovisionOperation(context.db, {
					siteId: receipt.id,
					organizationId: receipt.organizationId,
					status: "queued",
					stage: "Retrying cleanup",
					errors: [],
				});
				await instance.restart();
			} else if (receipt.status !== "failed") {
				await updateCmsDeprovisionOperation(context.db, {
					siteId: receipt.id,
					organizationId: receipt.organizationId,
					status: "failed",
					stage: "Cleanup needs attention",
					errors: ["Cleanup stopped before a final receipt was recorded"],
				});
			}
		} else if (
			native.status === "complete" &&
			receipt.status === "failed" &&
			allowRestart
		) {
			await updateCmsDeprovisionOperation(context.db, {
				siteId: receipt.id,
				organizationId: receipt.organizationId,
				status: "queued",
				stage: "Retrying cleanup",
				errors: [],
			});
			await instance.restart();
		} else if (native.status === "complete") {
			await updateCmsDeprovisionOperation(context.db, {
				siteId: receipt.id,
				organizationId: receipt.organizationId,
				status: "failed",
				stage: "Cleanup needs attention",
				errors: ["Cleanup finished without a success receipt"],
			});
		}
		return (
			(await getCmsDeprovisionOperationForOrganization(context.db, {
				siteId: receipt.id,
				organizationId: receipt.organizationId,
			})) ?? receipt
		);
	}
	if (
		receipt.status === "queued" ||
		(receipt.status === "failed" && allowRestart)
	) {
		if (receipt.status === "failed") {
			await updateCmsDeprovisionOperation(context.db, {
				siteId: receipt.id,
				organizationId: receipt.organizationId,
				status: "queued",
				stage: "Retrying cleanup",
				errors: [],
			});
		}
		try {
			await context.env.CMS_DEPROVISION_WORKFLOW.create({
				id: receipt.id,
				params: { siteId: receipt.id, organizationId: receipt.organizationId },
			});
		} catch (error) {
			// A competing request may have created the same deterministic instance.
			try {
				await context.env.CMS_DEPROVISION_WORKFLOW.get(receipt.id);
			} catch {
				throw error;
			}
		}
	} else if (receipt.status === "running") {
		return (
			(await updateCmsDeprovisionOperation(context.db, {
				siteId: receipt.id,
				organizationId: receipt.organizationId,
				status: "failed",
				stage: "Cleanup needs attention",
				errors: ["Cleanup workflow is no longer available"],
			})) ?? receipt
		);
	}
	return (
		(await getCmsDeprovisionOperationForOrganization(context.db, {
			siteId: receipt.id,
			organizationId: receipt.organizationId,
		})) ?? receipt
	);
}

async function requireOwnedSite(context: BaseContext, siteId: string) {
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
				authoringApp = await createApp(context.db, {
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
				});
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

export const updateCmsDomainProcedure = authedSitesOs.updateCmsDomain
	.use(withAuthorization("settings:manage", "mcp:content.admin"))
	.handler(async ({ input, context }) => {
		if (!isPlatformPrincipal(context))
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Platform administrator required to change provisioned CMS routing",
			);
		const site = await requireCmsSite(context, input.siteId);
		const existing = input.customDomain
			? await getCmsSiteByHostname(context.db, input.customDomain)
			: null;
		if (existing && existing.id !== site.id)
			throw createError(
				ErrorCodes.CONFLICT,
				"CMS hostname already belongs to a site",
			);
		const canonicalUrl = `https://${input.customDomain ?? `${site.slug}.cms.tedix.dev`}`;
		const updated = await updateCmsSiteDomain(context.db, {
			id: site.id,
			organizationId: requireOrgId(context),
			customDomain: input.customDomain,
			canonicalUrl,
		});
		if (!updated) throw createError(ErrorCodes.NOT_FOUND, "CMS site not found");
		return {
			siteId: updated.id,
			slug: updated.slug,
			url: updated.canonicalUrl,
		};
	});

export const beginCmsDomainProcedure = authedSitesOs.beginCmsDomain
	.use(withAuthorization("settings:manage", "mcp:content.admin"))
	.handler(async ({ input, context }) => {
		const site = await requireCmsDomainSite(context, input.siteId, false);
		const hostname = input.hostname.trim().toLowerCase().replace(/\.$/, "");
		try {
			cmsDomainVerificationName(hostname);
		} catch {
			throw createError(ErrorCodes.BAD_REQUEST, "Invalid custom hostname");
		}
		const redirectToApex = input.redirectToApex === true;
		if (redirectToApex) {
			if (!site.customDomain || hostname !== `www.${site.customDomain}`)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"The www hostname must match this site's active apex domain",
				);
			const primary = await listCmsDomainClaimsForSite(context.db, {
				organizationId: requireOrgId(context),
				siteId: site.id,
			});
			if (
				!primary.some(
					(claim) =>
						claim.kind === "primary" &&
						claim.status === "active" &&
						claim.providerHostnameId &&
						claim.hostname === site.customDomain,
				) ||
				!(await verifyCmsDnsZoneApex(site.customDomain))
			)
				throw createError(
					ErrorCodes.CONFLICT,
					"Verify the apex domain before adding its www redirect",
				);
		}
		if (site.customDomain !== hostname)
			await requireCmsDomainSite(context, input.siteId);
		const claims = await listCmsDomainClaimsForSite(context.db, {
			organizationId: requireOrgId(context),
			siteId: site.id,
		});
		const pending = claims.find(
			(claim) => claim.status === "pending" || claim.status === "provisioning",
		);
		if (pending) {
			if (
				pending.hostname !== hostname ||
				pending.kind !== (redirectToApex ? "www_alias" : "primary")
			)
				throw createError(
					ErrorCodes.CONFLICT,
					"Finish or remove the pending domain claim first",
				);
			if (site.customDomain === hostname && pending.status === "pending") {
				const provider = await findCmsCustomHostname(context.env, hostname);
				if (provider && isCmsCustomHostnameReady(provider)) {
					const adopted = await adoptLegacyCmsDomainClaim(context.db, {
						id: pending.id,
						organizationId: requireOrgId(context),
						siteId: site.id,
						providerHostnameId: provider.id,
					});
					if (adopted)
						return cmsDomainStatus(context, site.slug, adopted, provider);
				}
			}
			return cmsDomainStatus(context, site.slug, pending);
		}
		const active = claims.find(
			(claim) =>
				claim.status === "active" &&
				claim.hostname === hostname &&
				claim.kind === (redirectToApex ? "www_alias" : "primary"),
		);
		if (active && redirectToApex)
			return cmsDomainStatus(context, site.slug, active);
		if (active)
			throw createError(
				ErrorCodes.CONFLICT,
				"This hostname is already active for the site",
			);
		const claim = await reserveCmsDomainClaim(context.db, {
			id: crypto.randomUUID(),
			organizationId: requireOrgId(context),
			siteId: site.id,
			hostname,
			kind: redirectToApex ? "www_alias" : "primary",
			verificationToken: createCmsDomainVerificationToken(),
			expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
		});
		if (!claim)
			throw createError(
				ErrorCodes.CONFLICT,
				"Hostname is already claimed or unavailable",
			);
		if (site.customDomain === hostname) {
			const provider = await findCmsCustomHostname(context.env, hostname);
			if (provider && isCmsCustomHostnameReady(provider)) {
				const adopted = await adoptLegacyCmsDomainClaim(context.db, {
					id: claim.id,
					organizationId: requireOrgId(context),
					siteId: site.id,
					providerHostnameId: provider.id,
				});
				if (adopted)
					return cmsDomainStatus(context, site.slug, adopted, provider);
			}
		}
		return cmsDomainStatus(context, site.slug, claim);
	});

export const getCmsDomainProcedure = authedSitesOs.getCmsDomain
	.use(withAuthorization("settings:manage", "mcp:content.read"))
	.handler(async ({ input, context }) => {
		const site = await requireCmsDomainSite(context, input.siteId, false);
		const claims = await listCmsDomainClaimsForSite(context.db, {
			organizationId: requireOrgId(context),
			siteId: site.id,
		});
		const relevant = claims.filter(
			(item) =>
				item.kind === (input.redirectToApex ? "www_alias" : "primary") &&
				(!input.redirectToApex || item.hostname === `www.${site.customDomain}`),
		);
		const claim =
			relevant.find(
				(item) => item.status === "pending" || item.status === "provisioning",
			) ??
			relevant.find((item) => item.status === "active") ??
			relevant.find(
				(item) =>
					item.status === "removing" ||
					item.status === "removing_provisioning" ||
					item.status === "removing_legacy",
			);
		return claim ? cmsDomainStatus(context, site.slug, claim) : null;
	});

export const verifyCmsDomainProcedure = authedSitesOs.verifyCmsDomain
	.use(withAuthorization("settings:manage", "mcp:content.admin"))
	.handler(async ({ input, context }) => {
		const site = await requireCmsDomainSite(context, input.siteId);
		const key = {
			id: input.claimId,
			organizationId: requireOrgId(context),
			siteId: site.id,
		};
		let claim = await getCmsDomainClaimForSite(context.db, key);
		if (!claim)
			throw createError(ErrorCodes.NOT_FOUND, "Domain claim not found");
		if (claim.status === "active") {
			const current = await getCmsSiteByIdForOrganization(context.db, {
				id: site.id,
				organizationId: key.organizationId,
			});
			if (
				current?.customDomain !==
				(claim.kind === "www_alias" ? claim.hostname.slice(4) : claim.hostname)
			)
				throw createError(
					ErrorCodes.CONFLICT,
					"This domain is no longer the site's active hostname",
				);
			if (claim.kind === "primary")
				await cleanupReplacedCmsDomains(context, site.id, claim.id);
			return cmsDomainStatus(context, site.slug, claim);
		}
		if (
			(claim.status !== "pending" && claim.status !== "provisioning") ||
			claim.expiresAt <= new Date().toISOString()
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"Domain claim expired or is being removed",
			);
		if (!(await verifyCmsDnsChallenge(claim.hostname, claim.verificationToken)))
			return cmsDomainStatus(context, site.slug, claim);
		const target = cmsCustomHostnameTarget(context.env, site.slug);
		if (
			!(await verifyCmsDnsTarget(claim.hostname, target)) &&
			(claim.kind === "www_alias" ||
				!(await verifyCmsDnsZoneApex(claim.hostname)))
		)
			return cmsDomainStatus(context, site.slug, claim);
		let provider: CmsCustomHostname | null;
		if (claim.providerHostnameId) {
			provider = await getCmsCustomHostname(
				context.env,
				claim.providerHostnameId,
			);
		} else {
			const lease = await beginCmsDomainProvisioning(context.db, key);
			if (!lease) {
				const current = await getCmsDomainClaimForSite(context.db, key);
				if (!current)
					throw createError(
						ErrorCodes.CONFLICT,
						"Domain claim changed during verification",
					);
				return cmsDomainStatus(context, site.slug, current);
			}
			provider = await findCmsCustomHostname(context.env, claim.hostname);
			if (!provider)
				provider = await createCmsCustomHostname(context.env, claim.hostname);
			if (provider.hostname.toLowerCase() !== claim.hostname)
				throw createError(
					ErrorCodes.CONFLICT,
					"Cloudflare hostname belongs to another claim",
				);
			claim = await finishCmsDomainProvisioning(context.db, {
				...key,
				providerHostnameId: provider.id,
				provisioningStartedAt: lease.updatedAt,
			});
			if (!claim)
				throw createError(
					ErrorCodes.CONFLICT,
					"Domain claim changed during verification",
				);
		}
		if (!provider)
			throw createError(
				ErrorCodes.BAD_GATEWAY,
				"Cloudflare hostname is missing",
			);
		provider = await getCmsCustomHostname(context.env, provider.id);
		if (!provider || !isCmsCustomHostnameReady(provider))
			return cmsDomainStatus(context, site.slug, claim, provider);
		const activated =
			claim.kind === "www_alias"
				? await activateCmsWwwAliasClaim(context.db, key)
				: await activateCmsDomainClaim(context.db, key);
		if (!activated)
			throw createError(
				ErrorCodes.CONFLICT,
				"Domain claim changed during activation",
			);
		if (claim.kind === "primary")
			await cleanupReplacedCmsDomains(context, site.id, claim.id);
		return cmsDomainStatus(context, site.slug, activated, provider);
	});

export const removeCmsDomainProcedure = authedSitesOs.removeCmsDomain
	.use(withAuthorization("settings:manage", "mcp:content.admin"))
	.handler(async ({ input, context }) => {
		const site = await requireCmsDomainSite(context, input.siteId, false);
		const key = {
			id: input.claimId,
			organizationId: requireOrgId(context),
			siteId: site.id,
		};
		const before = await getCmsDomainClaimForSite(context.db, key);
		if (!before)
			throw createError(ErrorCodes.NOT_FOUND, "Domain claim not found");
		if (before.kind === "primary") {
			const claims = await listCmsDomainClaimsForSite(context.db, {
				organizationId: key.organizationId,
				siteId: site.id,
			});
			for (const alias of claims.filter(
				(item) =>
					item.kind === "www_alias" &&
					item.hostname === `www.${before.hostname}`,
			))
				await removeCmsDomainWithProvider(context, {
					...key,
					id: alias.id,
				});
		}
		return { removed: await removeCmsDomainWithProvider(context, key) };
	});

async function removeCmsDomainWithProvider(
	context: BaseContext,
	key: { id: string; organizationId: string; siteId: string },
) {
	const claim = await beginRemovingCmsDomainClaim(context.db, key);
	if (!claim)
		throw createError(
			ErrorCodes.CONFLICT,
			"Domain provisioning is in progress; retry shortly",
		);
	if (claim.providerHostnameId)
		await deleteCmsCustomHostname(
			context.env,
			claim.providerHostnameId,
			claim.hostname,
		);
	else if (
		claim.status === "removing_provisioning" ||
		claim.status === "removing_legacy"
	) {
		const provider = await findCmsCustomHostname(context.env, claim.hostname);
		if (provider)
			await deleteCmsCustomHostname(context.env, provider.id, claim.hostname);
	}
	return removeCmsDomainClaim(context.db, key);
}

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

export const getRecoveryManifestProcedure = authedSitesOs.getRecoveryManifest
	.use(withAuthorization("apps:read", "mcp:content.read"))
	.handler(async ({ input, context }) => {
		const owned = await requireOwnedSite(context, input.siteId);
		const capturedAt = new Date().toISOString();
		if (owned.type === "cms") {
			const [apps, points, media, provider, capture] = await Promise.all([
				getAppsByOrganization(context.db, owned.site.organizationId),
				listTenantBundleRecoveryPoints(context.db, owned.site.slug),
				inspectCmsMediaResource(context.env, owned.site.slug),
				inspectCmsProviderResources(context.env, owned.site.slug),
				inspectLatestCmsRecoveryCapture(
					context.env,
					owned.site.slug,
					owned.site.id,
				),
			]);
			const authoringApp = apps.find(
				(app) => app.id === owned.site.authoringAppId,
			);
			const activePoint = points.find((point) => point.active);
			const blockers = [
				...(!authoringApp ? ["Authoring proxy is missing"] : []),
				...(!activePoint ? ["No active CMS bundle is available"] : []),
				...(media.state === "missing" ? ["Media bucket is missing"] : []),
				...(media.state === "unknown"
					? ["Media bucket state could not be verified"]
					: []),
				...(provider.durableObject.state !== "present"
					? [
							`CMS Durable Object storage ${provider.durableObject.state === "missing" ? "is missing" : "state could not be verified"}`,
						]
					: []),
				...(!capture.verified
					? [
							"No restorable Durable Object database bookmark has been captured",
							"No independently verified media backup has been captured",
						]
					: ["No tested database and media restore procedure is available"]),
			];
			return {
				siteId: owned.site.id,
				type: "cms" as const,
				slug: owned.site.slug,
				status: owned.site.status,
				capturedAt,
				recoverable: blockers.length === 0,
				blockers,
				resources: [
					{
						kind: "site_record" as const,
						state: "ready" as const,
						identifier: owned.site.id,
						requiredForRecovery: true,
					},
					{
						kind: "durable_object" as const,
						state:
							provider.durableObject.state === "present"
								? ("ready" as const)
								: provider.durableObject.state === "missing"
									? ("missing" as const)
									: ("unknown" as const),
						identifier: `EmDashDB:${owned.site.slug}`,
						requiredForRecovery: true,
					},
					{
						kind: "media" as const,
						state: media.state,
						identifier: media.bucketName,
						requiredForRecovery: true,
					},
					{
						kind: "authoring_proxy" as const,
						state: authoringApp ? ("ready" as const) : ("missing" as const),
						identifier: authoringApp?.slug ?? `cms-${owned.site.slug}`,
						requiredForRecovery: true,
					},
					{
						kind: "mcp_app" as const,
						state: owned.site.mcpAppId
							? ("ready" as const)
							: ("optional" as const),
						identifier: owned.site.mcpAppId ?? "none",
						requiredForRecovery: false,
					},
					{
						kind: "domain" as const,
						state: "ready" as const,
						identifier:
							owned.site.customDomain ?? `${owned.site.slug}.cms.tedix.dev`,
						requiredForRecovery: false,
					},
					{
						kind: "release" as const,
						state: activePoint ? ("ready" as const) : ("missing" as const),
						identifier: activePoint ? String(activePoint.version) : "none",
						requiredForRecovery: true,
					},
				],
				recoveryPoints: points.map((point) => ({
					id: String(point.version),
					label: `Bundle rollback v${point.version} (content and media unchanged)`,
					createdAt: point.deployedAt,
					active: point.active,
				})),
			};
		}
		const builds = await listDocsBuilds(context.db, owned.site.id);
		const complete = builds.filter((build) => build.status === "complete");
		const activeExists = owned.site.activeBuildId
			? complete.some((build) => build.id === owned.site.activeBuildId)
			: false;
		const blockers = [
			...(!owned.site.activeBuildId ? ["No active documentation build"] : []),
			...(owned.site.activeBuildId && !activeExists
				? ["Active documentation build record is missing"]
				: []),
		];
		return {
			siteId: owned.site.id,
			type: "docs" as const,
			slug: owned.site.slug,
			status: owned.site.status,
			capturedAt,
			recoverable: blockers.length === 0,
			blockers,
			resources: [
				{
					kind: "site_record" as const,
					state: "ready" as const,
					identifier: owned.site.id,
					requiredForRecovery: true,
				},
				{
					kind: "source" as const,
					state:
						owned.site.repositoryUrl || owned.site.artifactsRepository
							? ("ready" as const)
							: ("missing" as const),
					identifier:
						owned.site.repositoryUrl ??
						owned.site.artifactsRepository ??
						"none",
					requiredForRecovery: true,
				},
				{
					kind: "domain" as const,
					state: "ready" as const,
					identifier: new URL(owned.site.canonicalUrl).hostname,
					requiredForRecovery: false,
				},
				{
					kind: "release" as const,
					state: activeExists ? ("ready" as const) : ("missing" as const),
					identifier: owned.site.activeBuildId ?? "none",
					requiredForRecovery: true,
				},
			],
			recoveryPoints: complete.map((build) => ({
				id: build.id,
				label: build.sourceRevision ?? build.id,
				createdAt: build.finishedAt ?? build.createdAt,
				active: build.id === owned.site.activeBuildId,
			})),
		};
	});

export const startCmsRecoveryCaptureProcedure =
	authedSitesOs.startCmsRecoveryCapture
		.use(withAuthorization("settings:manage", "mcp:content.admin"))
		.handler(async ({ input, context }) => {
			const site = await requireCmsSite(context, input.siteId);
			if (site.status !== "active")
				throw createError(
					ErrorCodes.CONFLICT,
					"CMS site must be active for recovery capture",
				);
			return startCmsRecoveryCapture(context.env, site.slug, site.id);
		});

export const getCmsRecoveryCaptureProcedure =
	authedSitesOs.getCmsRecoveryCapture
		.use(withAuthorization("apps:read", "mcp:content.read"))
		.handler(async ({ input, context }) => {
			const site = await requireCmsRecoveryOwnership(context, input.siteId);
			return getCmsRecoveryCapture(
				context.env,
				site.slug,
				site.id,
				input.captureId,
			);
		});

export const purgeCmsRecoveryCaptureProcedure =
	authedSitesOs.purgeCmsRecoveryCapture
		.use(withAuthorization("settings:manage", "mcp:content.admin"))
		.handler(async ({ input, context }) => {
			const site = await requireCmsRecoveryOwnership(context, input.siteId);
			if (input.confirmation !== site.slug)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`Type ${site.slug} to confirm`,
				);
			return purgeCmsRecoveryCapture(
				context.env,
				site.slug,
				site.id,
				input.captureId,
			);
		});

export const startCmsSiteRestoreProcedure = authedSitesOs.startCmsSiteRestore
	.use(withAuthorization("settings:manage", "mcp:content.admin"))
	.handler(async ({ input, context }) => {
		const site = await requireCmsSite(context, input.siteId);
		if (site.status !== "active")
			throw createError(
				ErrorCodes.CONFLICT,
				"CMS site must be active for restore",
			);
		if (input.confirmation !== site.slug)
			throw createError(ErrorCodes.BAD_REQUEST, `Type ${site.slug} to confirm`);
		return startCmsSiteRestore(context.env, {
			slug: site.slug,
			siteId: site.id,
			captureId: input.captureId,
			mode: input.mode,
		});
	});

export const getCmsSiteRestoreProcedure = authedSitesOs.getCmsSiteRestore
	.use(withAuthorization("apps:read", "mcp:content.read"))
	.handler(async ({ input, context }) => {
		const site = await requireCmsSite(context, input.siteId);
		return getCmsSiteRestore(context.env, {
			slug: site.slug,
			siteId: site.id,
			generation: input.generation,
		});
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

export const getDeprovisionPlanProcedure = authedSitesOs.getDeprovisionPlan
	.use(withAuthorization("apps:read", "mcp:content.read"))
	.handler(async ({ input, context }) => {
		const site = await requireCmsSite(context, input.siteId);
		const apps = await getAppsByOrganization(context.db, site.organizationId);
		const authoringApp = apps.find((app) => app.id === site.authoringAppId);
		const mcpApp = apps.find((app) => app.id === site.mcpAppId);
		const gateway = authoringApp
			? apps.find((app) =>
					aggregateEntries(app).some((entry) =>
						aggregateAppEntryMatches(entry, aggregateAppLink(authoringApp)),
					),
				)
			: null;
		const [bundle, media, provider] = await Promise.all([
			getTenantBundleSummary(context.db, site.slug),
			inspectCmsMediaResource(context.env, site.slug),
			inspectCmsProviderResources(context.env, site.slug),
		]);
		return {
			slug: site.slug,
			confirmation: site.slug,
			dependencies: [
				{
					kind: "site" as const,
					status: "present" as const,
					detail: site.name,
					destructive: true,
				},
				{
					kind: "mcp_app" as const,
					status: mcpApp ? ("present" as const) : ("absent" as const),
					detail: mcpApp?.slug ?? "No branded MCP app",
					destructive: false,
				},
				{
					kind: "authoring_app" as const,
					status: authoringApp ? ("present" as const) : ("absent" as const),
					detail: authoringApp?.slug ?? "No authoring proxy",
					destructive: true,
				},
				{
					kind: "gateway" as const,
					status: gateway ? ("present" as const) : ("absent" as const),
					detail: gateway?.slug ?? "Not attached",
					destructive: false,
				},
				{
					kind: "durable_object" as const,
					status:
						provider.durableObject.state === "present"
							? ("present" as const)
							: provider.durableObject.state === "missing"
								? ("absent" as const)
								: ("unknown" as const),
					detail: `EmDashDB storage ${site.slug}`,
					destructive: true,
				},
				{
					kind: "media" as const,
					status:
						media.state === "ready"
							? ("present" as const)
							: media.state === "missing"
								? ("absent" as const)
								: ("unknown" as const),
					detail: media.bucketName,
					destructive: true,
				},
				{
					kind: "bundles" as const,
					status:
						bundle.activeVersion === null
							? ("absent" as const)
							: ("present" as const),
					detail:
						bundle.activeVersion === null
							? "No active bundle"
							: `Active version ${bundle.activeVersion}`,
					destructive: true,
				},
				{
					kind: "theme" as const,
					status: "unknown" as const,
					detail: `hot-themes/${site.slug}/`,
					destructive: true,
				},
				{
					kind: "sandbox" as const,
					status: "unknown" as const,
					detail: `Site Builder sandbox ${site.slug}`,
					destructive: true,
				},
				{
					kind: "hostname" as const,
					status: "present" as const,
					detail: site.customDomain ?? `${site.slug}.cms.tedix.dev`,
					destructive: false,
				},
			],
		};
	});

export const deprovisionSiteProcedure = authedSitesOs.deprovision
	.use(withAuthorization("settings:manage", "mcp:content.admin"))
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		let receipt = await getCmsDeprovisionOperationForOrganization(context.db, {
			siteId: input.siteId,
			organizationId,
		});
		if (!receipt) {
			const site = await requireCmsSite(context, input.siteId);
			if (input.confirmation !== site.slug)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`Type ${site.slug} to confirm`,
				);
			try {
				receipt = await reserveCmsDeprovisionOperation(context.db, {
					siteId: site.id,
					organizationId,
					slug: site.slug,
					authoringAppId: site.authoringAppId,
				});
			} catch (error) {
				if (error instanceof CmsDeprovisionReservationConflictError)
					throw createError(
						ErrorCodes.CONFLICT,
						"CMS site is being restored or changed concurrently",
					);
				throw error;
			}
		}
		if (input.confirmation !== receipt.slug)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Type ${receipt.slug} to confirm`,
			);
		try {
			receipt = await ensureCmsDeprovisionWorkflow(context, receipt, true);
		} catch (error) {
			throw createError(
				ErrorCodes.BAD_GATEWAY,
				`Could not start durable CMS cleanup: ${error instanceof Error ? error.message : String(error)}`,
				error,
			);
		}
		return deprovisionStatus(receipt);
	});

export const getDeprovisionStatusProcedure = authedSitesOs.getDeprovisionStatus
	.use(withAuthorization("apps:read", "mcp:content.read"))
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const receipt = await getCmsDeprovisionOperationForOrganization(
			context.db,
			{
				siteId: input.siteId,
				organizationId,
			},
		);
		if (!receipt)
			throw createError(
				ErrorCodes.NOT_FOUND,
				"CMS cleanup operation not found",
			);
		return deprovisionStatus(
			await ensureCmsDeprovisionWorkflow(context, receipt, false),
		);
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
