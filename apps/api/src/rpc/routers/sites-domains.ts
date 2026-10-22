import { isPlatformPrincipal } from "@tedix/auth/types";
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
	getCmsSiteByHostname,
	updateCmsSiteDomain,
	getCmsSiteByIdForOrganization,
} from "@tedix/db/queries/cms-sites";
import {
	getOrganizationById,
	getOrganizationFeatures,
} from "@tedix/db/queries/organizations";
import { requireOrgId } from "../org-scope";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	withAuthorization,
} from "../orpc";
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
import { authedSitesOs, requireCmsSite } from "./sites-shared";

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
