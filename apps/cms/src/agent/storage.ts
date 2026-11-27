/**
 * Canonical CMS control-plane storage owner.
 *
 * CMS deploy/provisioning spans the core metadata catalog and tenant
 * bundle lifecycle tables. Bundle mutations still use provisioning's native
 * D1 contract. Workflows and tools call these typed operations.
 */

import { coreQueryDb } from "@tedix/db/core-store/scope";
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
	db: D1Database,
	bundlesBucket: R2Bucket,
	orgSlug: string,
): Promise<CmsSiteDeploymentRow | null> {
	const site = await db
		.prepare(
			`SELECT s.template_slug AS templateSlug,
			        s.canonical_url AS publicUrl
			 FROM cms_sites s
			 WHERE s.slug = ?`,
		)
		.bind(orgSlug)
		.first<Pick<CmsSiteDeploymentRow, "templateSlug" | "publicUrl">>();
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
	db: D1Database,
	orgSlug: string,
): Promise<string | Record<string, unknown> | null> {
	const site = await getCmsSiteBySlug(coreQueryDb({ DB: db }), orgSlug);
	return site?.config ? { ...site.config } : null;
}

export async function getCmsPrivacyBannerSetting(
	db: D1Database,
	orgSlug: string,
): Promise<number | boolean | string | null> {
	const site = await getCmsSiteBySlug(coreQueryDb({ DB: db }), orgSlug);
	const value = site?.config?.blog?.privacyBannerEnabled;
	return typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string"
		? value
		: null;
}

/** Public, nonsecret inputs for a tenant's statically compiled Astro bundle. */
export async function getCmsPublicBuildRoute(
	db: D1Database,
	orgSlug: string,
): Promise<{ publicSiteUrl: string; publicPathPrefix: string | null } | null> {
	const site = await getCmsSiteBySlug(coreQueryDb({ DB: db }), orgSlug);
	return site?.status === "active"
		? {
				publicSiteUrl: site.canonicalUrl,
				publicPathPrefix: site.publicPathPrefix,
			}
		: null;
}

export async function getCmsTemplateSelection(
	db: D1Database,
	orgSlug: string,
): Promise<{
	organizationId: string;
	blogTemplateSlug: string | null;
	metaTemplateSlug: string | null;
} | null> {
	const normalizedSlug = orgSlug.toLowerCase();
	return db
		.prepare(
			`SELECT
				o.id AS organizationId,
				s.template_slug AS blogTemplateSlug,
				NULL AS metaTemplateSlug
			FROM cms_sites s
			INNER JOIN organizations o ON s.organization_id = o.id
			WHERE s.slug = ? AND s.status = 'active' AND json_extract(o.metadata, '$.retiredAt') IS NULL`,
		)
		.bind(normalizedSlug)
		.first();
}

export interface CmsHumanSiteAuthority {
	siteId: string;
	tenantId: string;
	activeBundleEtag: string;
	humanAssertionBundleEtag: string | null;
}

/** Fresh platform authority for a human request. Never trust tenant config from a bundle. */
export async function getCmsHumanSiteAuthority(
	db: D1Database,
	orgSlug: string,
): Promise<CmsHumanSiteAuthority | null> {
	const row = await db
		.prepare(
			`SELECT s.id AS siteId,
			        o.descope_tenant_id AS ownerTenantId,
			        json_extract(s.config, '$.blog.authDescopeTenantId') AS explicitTenantId,
			        json_extract(s.config, '$.blog.humanAssertionBundleEtag') AS humanAssertionBundleEtag,
			        (SELECT COUNT(*) FROM tenant_bundles b
			         WHERE b.slug = s.slug AND b.is_active = 1) AS activeBundleCount,
			        (SELECT b.etag FROM tenant_bundles b
			         WHERE b.slug = s.slug AND b.is_active = 1 LIMIT 1) AS activeBundleEtag
			 FROM cms_sites s
			 INNER JOIN organizations o ON s.organization_id = o.id
			 WHERE s.slug = ? AND s.status = 'active'
			   AND json_extract(o.metadata, '$.retiredAt') IS NULL`,
		)
		.bind(orgSlug.toLowerCase())
		.first<{
			siteId: string;
			ownerTenantId: string | null;
			explicitTenantId: unknown;
			humanAssertionBundleEtag: unknown;
			activeBundleCount: number;
			activeBundleEtag: string | null;
		}>();
	if (!row || row.activeBundleCount !== 1 || !row.activeBundleEtag) return null;
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

interface CmsHumanAuthActivationRow {
	siteId: string;
	status: string;
	ownerTenantId: string | null;
	explicitTenantId: unknown;
	retiredAt: unknown;
	humanAssertionBundleEtag: unknown;
	blogType: string | null;
	activeBundleCount: number;
	activeVersion: number | null;
	activeBundleEtag: string | null;
	r2Prefix: string | null;
	mainModule: string | null;
	modulesJson: string | null;
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

/** Inspect current D1 authority and the exact immutable bundle before opt-in. */
export async function inspectCmsHumanAuthActivation(
	db: D1Database,
	bundlesBucket: R2Bucket,
	slug: string,
): Promise<CmsHumanAuthActivationState> {
	const normalizedSlug = slug.toLowerCase();
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug)) {
		return unavailableHumanAuth("invalid_site_slug");
	}
	const row = await db
		.prepare(
			`SELECT s.id AS siteId, s.status AS status,
			        o.descope_tenant_id AS ownerTenantId,
			        json_extract(s.config, '$.blog.authDescopeTenantId') AS explicitTenantId,
			        json_extract(o.metadata, '$.retiredAt') AS retiredAt,
			        json_extract(s.config, '$.blog.humanAssertionBundleEtag') AS humanAssertionBundleEtag,
			        json_type(s.config, '$.blog') AS blogType,
			        (SELECT COUNT(*) FROM tenant_bundles b WHERE b.slug = s.slug AND b.is_active = 1) AS activeBundleCount,
			        (SELECT b.version FROM tenant_bundles b WHERE b.slug = s.slug AND b.is_active = 1 LIMIT 1) AS activeVersion,
			        (SELECT b.etag FROM tenant_bundles b WHERE b.slug = s.slug AND b.is_active = 1 LIMIT 1) AS activeBundleEtag,
			        (SELECT b.r2_prefix FROM tenant_bundles b WHERE b.slug = s.slug AND b.is_active = 1 LIMIT 1) AS r2Prefix,
			        (SELECT b.main_module FROM tenant_bundles b WHERE b.slug = s.slug AND b.is_active = 1 LIMIT 1) AS mainModule,
			        (SELECT b.modules_json FROM tenant_bundles b WHERE b.slug = s.slug AND b.is_active = 1 LIMIT 1) AS modulesJson
		 FROM cms_sites s INNER JOIN organizations o ON o.id = s.organization_id
		 WHERE s.slug = ?`,
		)
		.bind(normalizedSlug)
		.first<CmsHumanAuthActivationRow>();
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
	db: D1Database,
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
	const updated = await db
		.prepare(
			`UPDATE cms_sites AS s
		     SET config = CASE WHEN ? = 1
		       THEN json_set(s.config, '$.blog.humanAssertionBundleEtag', ?)
		       ELSE json_remove(s.config, '$.blog.humanAssertionBundleEtag') END,
		       updated_at = datetime('now')
		     WHERE s.id = ? AND s.slug = ? AND s.status = 'active'
		       AND json_type(s.config, '$.blog') = 'object'
		       AND json_extract(s.config, '$.blog.humanAssertionBundleEtag') IS ?
		       AND (SELECT COUNT(*) FROM tenant_bundles b WHERE b.slug = s.slug AND b.is_active = 1) = 1
		       AND EXISTS (SELECT 1 FROM tenant_bundles b WHERE b.slug = s.slug
		         AND b.is_active = 1 AND b.version = ? AND b.etag = ?)
		       AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = s.organization_id
		         AND json_extract(o.metadata, '$.retiredAt') IS NULL
		         AND COALESCE(NULLIF(json_extract(s.config, '$.blog.authDescopeTenantId'), ''), o.descope_tenant_id) = ?)`,
		)
		.bind(
			input.enabled ? 1 : 0,
			input.expectedBundleEtag,
			input.expectedSiteId,
			input.slug.toLowerCase(),
			input.expectedCurrentMarker,
			input.expectedVersion,
			input.expectedBundleEtag,
			input.expectedTenantId,
		)
		.run();
	if (updated.meta.changes !== 1)
		throw new Error("CMS human auth activation CAS conflict");
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
	db: D1Database,
	orgSlug: string,
): Promise<string | null> {
	const site = await getCmsSiteBySlug(coreQueryDb({ DB: db }), orgSlug);
	const value = site?.config?.blog?.defaultLocale;
	return typeof value === "string" ? value : null;
}

/** A durable site reservation survives activation until the Workflow is terminal. */
export async function getCmsDeployAdmission(
	db: D1Database,
	site: ExactCmsActiveSite,
): Promise<string | null> {
	const row = await db
		.prepare(
			"SELECT json_extract(config, '$.deployAdmission') AS jobId FROM cms_sites WHERE id = ? AND slug = ? AND restore_epoch = ? AND status = 'active'",
		)
		.bind(site.siteId, site.slug, site.restoreEpoch)
		.first<{ jobId: string | null }>();
	if (!row) throw new Error("CMS deploy site changed during admission");
	return row.jobId;
}

export async function reserveCmsDeployAdmission(
	db: D1Database,
	site: ExactCmsActiveSite,
	previous: string | null,
	jobId: string,
): Promise<boolean> {
	const row = await db
		.prepare(
			"UPDATE cms_sites SET config = json_set(COALESCE(config, '{}'), '$.deployAdmission', ?) WHERE id = ? AND slug = ? AND restore_epoch = ? AND status = 'active' AND json_extract(config, '$.deployAdmission') IS ? RETURNING id AS siteId",
		)
		.bind(jobId, site.siteId, site.slug, site.restoreEpoch, previous)
		.first<{ siteId: string }>();
	return Boolean(row);
}

export interface CmsBundleDeployGeneration {
	activeVersion: number | null;
	nextVersion: number;
	hasArtifactsHistory: boolean;
}

export async function getCmsBundleDeployGeneration(
	db: D1Database,
	orgSlug: string,
): Promise<CmsBundleDeployGeneration> {
	const row = await db
		.prepare(
			`SELECT
			   COALESCE(MAX(version), 0) + 1 AS nextVersion,
			   MAX(CASE WHEN is_active = 1 THEN version END) AS activeVersion,
			   SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS activeCount,
			   MAX(CASE WHEN source_revision LIKE 'artifacts-commit:%' THEN 1 ELSE 0 END) AS hasArtifactsHistory
			 FROM tenant_bundles WHERE slug = ?`,
		)
		.bind(orgSlug)
		.first<{
			nextVersion: number;
			activeVersion: number | null;
			activeCount: number;
			hasArtifactsHistory: number | null;
		}>();
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
	db: D1Database,
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
	db: D1Database,
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
	const failed = await db
		.prepare(
			"SELECT etag FROM tenant_bundles WHERE slug = ? AND version = ? AND is_active = 1",
		)
		.bind(input.orgSlug, input.failedVersion)
		.first<{ etag: string }>();
	// A marker carried onto the failed bundle follows the rollback in the same
	// batch when the predecessor still carries the reviewed verifier.
	const { etag: targetEtag, bundle } = target;
	const humanAuthority = await planCmsHumanAuthorityCarry(db, {
		slug: input.orgSlug,
		previousActiveEtag: failed?.etag ?? null,
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
	const results = await db.batch([
		db
			.prepare(
				`UPDATE tenant_bundles
				 SET is_active = 0
				 WHERE slug = ? AND version = ? AND is_active = 1
				   AND NOT EXISTS (
				     SELECT 1 FROM cms_restore_permits maintenance
				     WHERE maintenance.slug = tenant_bundles.slug
				       AND maintenance.kind = 'scheduled'
				       AND (maintenance.id LIKE 'bundle-retention:%' OR maintenance.id LIKE 'lease:v1:bundle-retention:%')
				   )
				   AND EXISTS (
				     SELECT 1 FROM tenant_bundles previous
				     WHERE previous.slug = ? AND previous.version = ?
				   )`,
			)
			.bind(
				input.orgSlug,
				input.failedVersion,
				input.orgSlug,
				input.previousVersion,
			),
		db
			.prepare(
				`UPDATE tenant_bundles
				 SET is_active = 1
				 WHERE slug = ? AND version = ? AND is_active = 0
				   AND changes() = 1
				   AND NOT EXISTS (
				     SELECT 1 FROM tenant_bundles active
				     WHERE active.slug = ? AND active.is_active = 1
				   )`,
			)
			.bind(input.orgSlug, input.previousVersion, input.orgSlug),
		...(humanAuthority.statement ? [humanAuthority.statement] : []),
	]);
	if ((results[1]?.meta.changes ?? 0) !== 1) {
		return { rolledBack: false };
	}
	const active = await db
		.prepare(
			`SELECT version, COUNT(*) OVER () AS activeCount
			 FROM tenant_bundles WHERE slug = ? AND is_active = 1`,
		)
		.bind(input.orgSlug)
		.first<{ version: number; activeCount: number }>();
	const rolledBack =
		active?.version === input.previousVersion && active.activeCount === 1;
	return rolledBack
		? {
				rolledBack,
				humanAuthority: resolveCmsHumanAuthorityCarry(
					humanAuthority,
					results[2],
				),
			}
		: { rolledBack };
}

export async function updateCmsHotThemeMetadata(
	db: D1Database,
	orgSlug: string,
	hotTheme: Record<string, unknown>,
): Promise<void> {
	await db
		.prepare(
			"UPDATE cms_sites SET config = json_set(COALESCE(config, '{}'), '$.blog.hotTheme', json(?)), updated_at = datetime('now') WHERE slug = ?",
		)
		.bind(JSON.stringify(hotTheme), orgSlug)
		.run();
}

export async function listCmsFleetBundles(
	db: D1Database,
): Promise<CmsFleetBundleRow[]> {
	const rows = await db
		.prepare(
			"SELECT active.slug AS slug, active.version AS activeVersion, latest.latestVersion AS latestVersion, " +
				"active.deployed_at AS deployedAt, active.summary AS promptSummary, " +
				"json_extract(s.config, '$.blog.defaultLocale') AS defaultLocale, " +
				"s.custom_domain AS cmsDomain, " +
				"s.canonical_url AS publicSiteUrl, " +
				"s.template_slug AS templateSlug " +
				"FROM tenant_bundles active " +
				"INNER JOIN cms_sites s ON s.slug = active.slug " +
				"INNER JOIN (SELECT slug, MAX(version) AS latestVersion FROM tenant_bundles GROUP BY slug) latest ON latest.slug = active.slug " +
				"WHERE active.is_active = 1 ORDER BY active.slug",
		)
		.all<CmsFleetBundleRow>();
	return rows.results ?? [];
}
