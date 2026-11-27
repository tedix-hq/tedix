/**
 * Canonical CMS control-plane storage owner.
 *
 * CMS deploy/provisioning spans the core metadata catalog and tenant
 * bundle lifecycle tables. Workflows and tools supply the selected core client.
 */

import {
	cmsQueryDb,
	type CmsDatabase,
	activateCmsBundle,
	compareAndSetCmsDeployAdmission,
	compareAndSetCmsHumanAuthMarker,
	getCmsDeploymentRoute,
	getCmsHumanAuthorityRow,
	getCmsTemplateOwner,
	readCmsBundleGeneration,
	readCmsDeployAdmission,
	readCmsFleetBundles,
	writeCmsHotThemeMetadata,
} from "@tedix/db/queries/cms-control-plane";
import { getCmsSiteBySlug } from "@tedix/db/queries/cms-sites";

import {
	readCmsBundle,
	readCmsBundleModule,
} from "@tedix/provisioning/cms-bundle";
import {
	CMS_HUMAN_AUTH_MODULE,
	type CmsHumanAuthorityCarry,
	hasReviewedCmsHumanAuth,
	CMS_HUMAN_AUTH_CHUNK_MAX_BYTES,
	listTenantBundleVersions,
	planCmsHumanAuthorityCarry,
	resolveCmsHumanAuthorityCarry,
	verifyTenantBundleDirectDo,
	type TenantBundleSourceRevision,
} from "@tedix/provisioning/cms";
import {
	type ExactCmsActiveSite,
	withExactCmsSiteRestorePermit,
} from "./cms-restore-permit";

export interface CmsFleetBundleRow {
	slug: string;
	activeVersion: number | null;
	latestVersion: number | null;
	deployedAt: string | null;
	promptSummary: string | null;
	defaultLocale: string | null;
	cmsDomain: string | null;
	publicSiteUrl: string | null;
	templateSlug: string | null;
}

export interface CmsSiteDeploymentRow {
	templateSlug: string;
	publicUrl: string;
	activeBundleVersion: number | null;
	sourceRevision: TenantBundleSourceRevision | null;
}

/** The site and active bundle selected by the authenticated tenant slug. */
export async function getCmsSiteDeployment(
	db: CmsDatabase,
	bundlesBucket: R2Bucket,
	orgSlug: string,
): Promise<CmsSiteDeploymentRow | null> {
	const site = await getCmsDeploymentRoute(cmsQueryDb(db), orgSlug);
	if (!site) return null;
	const versions = await listTenantBundleVersions(
		{ platformDb: db, bundlesBucket },
		orgSlug,
	);
	const active = versions.filter((version) => version.isActive);
	if (active.length > 1) {
		throw new Error(`CMS tenant ${orgSlug} has multiple active bundles`);
	}
	return {
		...site,
		activeBundleVersion: active[0]?.version ?? null,
		sourceRevision: active[0]?.sourceRevision ?? null,
	};
}

export async function getCmsAppMetadata(
	db: CmsDatabase,
	orgSlug: string,
): Promise<string | Record<string, unknown> | null> {
	const site = await getCmsSiteBySlug(cmsQueryDb(db), orgSlug);
	return site?.config ? { ...site.config } : null;
}

export async function getCmsPrivacyBannerSetting(
	db: CmsDatabase,
	orgSlug: string,
): Promise<number | boolean | string | null> {
	const site = await getCmsSiteBySlug(cmsQueryDb(db), orgSlug);
	const value = site?.config?.blog?.privacyBannerEnabled;
	return typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string"
		? value
		: null;
}

/** Public, nonsecret inputs for a tenant's statically compiled Astro bundle. */
export async function getCmsPublicBuildRoute(
	db: CmsDatabase,
	orgSlug: string,
): Promise<{ publicSiteUrl: string; publicPathPrefix: string | null } | null> {
	const site = await getCmsSiteBySlug(cmsQueryDb(db), orgSlug);
	return site?.status === "active"
		? {
				publicSiteUrl: site.canonicalUrl,
				publicPathPrefix: site.publicPathPrefix,
			}
		: null;
}

export async function getCmsTemplateSelection(
	db: CmsDatabase,
	orgSlug: string,
): Promise<{
	organizationId: string;
	blogTemplateSlug: string | null;
	metaTemplateSlug: string | null;
} | null> {
	return getCmsTemplateOwner(cmsQueryDb(db), orgSlug);
}

export interface CmsHumanSiteAuthority {
	siteId: string;
	tenantId: string;
	activeBundleEtag: string;
	humanAssertionBundleEtag: string | null;
}

/** Fresh platform authority for a human request. Never trust tenant config from a bundle. */
export async function getCmsHumanSiteAuthority(
	db: CmsDatabase,
	orgSlug: string,
): Promise<CmsHumanSiteAuthority | null> {
	const row = await getCmsHumanAuthorityRow(cmsQueryDb(db), orgSlug);
	if (
		!row ||
		row.status !== "active" ||
		row.retiredAt !== null ||
		row.activeBundleCount !== 1 ||
		!row.activeBundleEtag
	)
		return null;
	const tenantId =
		typeof row.explicitTenantId === "string" && row.explicitTenantId
			? row.explicitTenantId
			: row.ownerTenantId;
	if (!tenantId) return null;
	return {
		siteId: row.siteId,
		tenantId,
		activeBundleEtag: row.activeBundleEtag,
		humanAssertionBundleEtag:
			typeof row.humanAssertionBundleEtag === "string"
				? row.humanAssertionBundleEtag
				: null,
	};
}

export interface CmsHumanAuthActivationState {
	status: "ready" | "unavailable";
	siteId: string | null;
	tenantId: string | null;
	activeVersion: number | null;
	activeBundleEtag: string | null;
	humanAssertionBundleEtag: string | null;
	compatible: boolean;
	reason: string | null;
}

function unavailableHumanAuth(
	reason: string,
	values: Partial<CmsHumanAuthActivationState> = {},
): CmsHumanAuthActivationState {
	return {
		status: "unavailable",
		siteId: values.siteId ?? null,
		tenantId: values.tenantId ?? null,
		activeVersion: values.activeVersion ?? null,
		activeBundleEtag: values.activeBundleEtag ?? null,
		humanAssertionBundleEtag: values.humanAssertionBundleEtag ?? null,
		compatible: values.compatible ?? false,
		reason,
	};
}

/** Inspect current site authority and the exact immutable bundle before opt-in. */
export async function inspectCmsHumanAuthActivation(
	db: CmsDatabase,
	bundlesBucket: R2Bucket,
	slug: string,
): Promise<CmsHumanAuthActivationState> {
	const normalizedSlug = slug.toLowerCase();
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug)) {
		return unavailableHumanAuth("invalid_site_slug");
	}
	const row = await getCmsHumanAuthorityRow(cmsQueryDb(db), normalizedSlug);
	if (!row) return unavailableHumanAuth("site_not_found");
	const tenantId =
		typeof row.explicitTenantId === "string" && row.explicitTenantId
			? row.explicitTenantId
			: row.ownerTenantId;
	const currentMarker =
		typeof row.humanAssertionBundleEtag === "string"
			? row.humanAssertionBundleEtag
			: null;
	const base = {
		siteId: row.siteId,
		tenantId,
		activeVersion: row.activeVersion,
		activeBundleEtag: row.activeBundleEtag,
		humanAssertionBundleEtag: currentMarker,
	};
	if (row.status !== "active" || row.retiredAt !== null)
		return unavailableHumanAuth("site_inactive_or_retired", base);
	if (!tenantId || row.blogType !== "object")
		return unavailableHumanAuth("site_auth_configuration_invalid", base);
	if (
		row.activeBundleCount !== 1 ||
		!row.activeVersion ||
		!row.activeBundleEtag ||
		!row.r2Prefix ||
		!row.mainModule ||
		!row.modulesJson
	)
		return unavailableHumanAuth("active_bundle_missing_or_ambiguous", base);
	if (row.r2Prefix !== `${normalizedSlug}/v${row.activeVersion}/`)
		return unavailableHumanAuth("bundle_prefix_mismatch", base);

	try {
		const modules: unknown = JSON.parse(row.modulesJson);
		if (
			!Array.isArray(modules) ||
			modules.some((module) => typeof module !== "string") ||
			!modules.includes(row.mainModule) ||
			modules.filter((module) => module === CMS_HUMAN_AUTH_MODULE).length !== 1
		)
			return unavailableHumanAuth("bundle_module_catalog_invalid", base);
		const bundle = await readCmsBundle(bundlesBucket, row.r2Prefix, {
			mainModule: row.mainModule,
			modules,
		});
		const source = readCmsBundleModule(
			bundle,
			CMS_HUMAN_AUTH_MODULE,
			1024 * 1024,
		);
		if (source === null)
			return unavailableHumanAuth("human_auth_module_missing", base);

		if (
			!(await hasReviewedCmsHumanAuth(source, {
				modules,
				readModule: async (module) =>
					readCmsBundleModule(bundle, module, CMS_HUMAN_AUTH_CHUNK_MAX_BYTES),
			}))
		)
			return unavailableHumanAuth("human_auth_module_incompatible", base);
	} catch {
		return unavailableHumanAuth("bundle_capability_unreadable", base);
	}
	if (currentMarker !== null && currentMarker !== row.activeBundleEtag)
		return unavailableHumanAuth("stale_activation_marker", {
			...base,
			compatible: true,
		});
	return { status: "ready", ...base, compatible: true, reason: null };
}

const REVOCABLE_CAPABILITY_REASONS = new Set([
	"bundle_module_catalog_invalid",
	"human_auth_module_missing",
	"human_auth_module_incompatible",
	"bundle_capability_unreadable",
	"stale_activation_marker",
]);

/** CAS the opt-in marker against both tenant authority and immutable active bundle. */
export async function setCmsHumanAuthActivation(
	db: CmsDatabase,
	bundlesBucket: R2Bucket,
	input: {
		slug: string;
		expectedSiteId: string;
		expectedTenantId: string;
		expectedVersion: number;
		expectedBundleEtag: string;
		expectedCurrentMarker: string | null;
		enabled: boolean;
	},
): Promise<CmsHumanAuthActivationState> {
	const state = await inspectCmsHumanAuthActivation(
		db,
		bundlesBucket,
		input.slug,
	);
	if (
		state.siteId !== input.expectedSiteId ||
		state.tenantId !== input.expectedTenantId ||
		state.activeVersion !== input.expectedVersion ||
		state.activeBundleEtag !== input.expectedBundleEtag ||
		state.humanAssertionBundleEtag !== input.expectedCurrentMarker
	)
		throw new Error("CMS human auth activation CAS conflict");
	const mayEnable =
		state.status === "ready" ||
		(state.reason === "stale_activation_marker" && state.compatible);
	const mayDisable =
		state.status === "ready" ||
		(state.reason !== null && REVOCABLE_CAPABILITY_REASONS.has(state.reason));
	if (input.enabled ? !mayEnable : !mayDisable)
		throw new Error("CMS human auth activation CAS conflict");
	const desiredMarker = input.enabled ? input.expectedBundleEtag : null;
	const updated = await compareAndSetCmsHumanAuthMarker(cmsQueryDb(db), input);
	if (!updated) throw new Error("CMS human auth activation CAS conflict");
	const readback = await inspectCmsHumanAuthActivation(
		db,
		bundlesBucket,
		input.slug,
	);
	if (
		(input.enabled
			? readback.status !== "ready"
			: readback.status !== "ready" &&
				(readback.reason === null ||
					!REVOCABLE_CAPABILITY_REASONS.has(readback.reason))) ||
		readback.siteId !== input.expectedSiteId ||
		readback.tenantId !== input.expectedTenantId ||
		readback.activeVersion !== input.expectedVersion ||
		readback.humanAssertionBundleEtag !== desiredMarker ||
		readback.activeBundleEtag !== input.expectedBundleEtag
	)
		throw new Error("CMS human auth activation changed after update");
	return readback;
}

export async function getCmsDefaultLocale(
	db: CmsDatabase,
	orgSlug: string,
): Promise<string | null> {
	const site = await getCmsSiteBySlug(cmsQueryDb(db), orgSlug);
	const value = site?.config?.blog?.defaultLocale;
	return typeof value === "string" ? value : null;
}

/** A durable site reservation survives activation until the Workflow is terminal. */
export async function getCmsDeployAdmission(
	db: CmsDatabase,
	site: ExactCmsActiveSite,
): Promise<string | null> {
	return readCmsDeployAdmission(cmsQueryDb(db), site);
}

export async function reserveCmsDeployAdmission(
	db: CmsDatabase,
	site: ExactCmsActiveSite,
	previous: string | null,
	jobId: string,
): Promise<boolean> {
	return compareAndSetCmsDeployAdmission(cmsQueryDb(db), site, previous, jobId);
}

export interface CmsBundleDeployGeneration {
	activeVersion: number | null;
	nextVersion: number;
	hasArtifactsHistory: boolean;
}

export async function getCmsBundleDeployGeneration(
	db: CmsDatabase,
	orgSlug: string,
): Promise<CmsBundleDeployGeneration> {
	const row = await readCmsBundleGeneration(cmsQueryDb(db), orgSlug);
	if ((row?.activeCount ?? 0) > 1) {
		throw new Error(`CMS tenant ${orgSlug} has multiple active bundles`);
	}
	return {
		activeVersion: row?.activeVersion ?? null,
		nextVersion: row?.nextVersion ?? 1,
		hasArtifactsHistory: row?.hasArtifactsHistory === 1,
	};
}

export async function rollbackCmsTenantBundle(
	db: CmsDatabase,
	bundlesBucket: R2Bucket,
	input: {
		site: ExactCmsActiveSite;
		failedVersion: number;
		previousVersion: number;
	},
): Promise<{
	rolledBack: boolean;
	error?: string;
	humanAuthority?: CmsHumanAuthorityCarry;
}> {
	return withExactCmsSiteRestorePermit(db, input.site, () =>
		rollbackCmsTenantBundleUnderPermit(db, bundlesBucket, {
			orgSlug: input.site.slug,
			failedVersion: input.failedVersion,
			previousVersion: input.previousVersion,
		}),
	);
}

async function rollbackCmsTenantBundleUnderPermit(
	db: CmsDatabase,
	bundlesBucket: R2Bucket,
	input: { orgSlug: string; failedVersion: number; previousVersion: number },
): Promise<{
	rolledBack: boolean;
	error?: string;
	humanAuthority?: CmsHumanAuthorityCarry;
}> {
	const target = await verifyTenantBundleDirectDo(
		{ platformDb: db, bundlesBucket },
		input.orgSlug,
		input.previousVersion,
	);
	if (
		!target.id ||
		!target.etag ||
		!target.r2Prefix ||
		!target.modules ||
		!target.bundle
	)
		return { rolledBack: false, error: target.error };
	const generation = await readCmsBundleGeneration(
		cmsQueryDb(db),
		input.orgSlug,
	);
	const failedEtag =
		generation.activeCount === 1 &&
		generation.activeVersion === input.failedVersion
			? generation.activeEtag
			: null;
	// A marker carried onto the failed bundle follows the rollback in the same
	// atomic write when the predecessor still carries the reviewed verifier.
	const { etag: targetEtag, bundle } = target;
	const humanAuthority = await planCmsHumanAuthorityCarry(db, {
		slug: input.orgSlug,
		previousActiveEtag: failedEtag,
		targetEtag,
		modules: target.modules,
		readModule: async (module) =>
			readCmsBundleModule(
				bundle,
				module,
				module === CMS_HUMAN_AUTH_MODULE
					? 1024 * 1024
					: CMS_HUMAN_AUTH_CHUNK_MAX_BYTES,
			),
	});
	const result = await activateCmsBundle(cmsQueryDb(db), {
		slug: input.orgSlug,
		targetId: target.id,
		expectedActiveVersion: input.failedVersion,
		carry: humanAuthority.carry,
	});
	if (!result.activated) return { rolledBack: false };
	const active = await readCmsBundleGeneration(cmsQueryDb(db), input.orgSlug);
	const rolledBack =
		active.activeVersion === input.previousVersion && active.activeCount === 1;
	return rolledBack
		? {
				rolledBack,
				humanAuthority: resolveCmsHumanAuthorityCarry(
					humanAuthority,
					result.carried,
				),
			}
		: { rolledBack };
}

export async function updateCmsHotThemeMetadata(
	db: CmsDatabase,
	orgSlug: string,
	hotTheme: Record<string, unknown>,
): Promise<void> {
	await writeCmsHotThemeMetadata(cmsQueryDb(db), orgSlug, hotTheme);
}

export async function listCmsFleetBundles(
	db: CmsDatabase,
): Promise<CmsFleetBundleRow[]> {
	return readCmsFleetBundles(cmsQueryDb(db));
}
