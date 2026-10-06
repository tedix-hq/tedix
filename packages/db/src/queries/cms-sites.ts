import {
	and,
	eq,
	exists,
	inArray,
	isNotNull,
	isNull,
	notExists,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../client";
import type { DbQueryClient } from "../query-client";
import { apps } from "../schema/apps";
import { cmsDeprovisionOperations } from "../schema/cms-deprovision-operations";
import { cmsDomainClaims } from "../schema/cms-domain-claims";
import { cmsRestoreFences } from "../schema/cms-restore-fences";
import { cmsSites, type CmsSite, type NewCmsSite } from "../schema/cms-sites";

export async function getCmsSiteById(
	db: DbQueryClient,
	id: string,
): Promise<CmsSite | null> {
	const [row] = await db
		.select()
		.from(cmsSites)
		.where(eq(cmsSites.id, id))
		.limit(1);
	return row ?? null;
}

export async function getCmsSiteBySlug(
	db: DbQueryClient,
	slug: string,
): Promise<CmsSite | null> {
	const [row] = await db
		.select()
		.from(cmsSites)
		.where(eq(cmsSites.slug, slug.toLowerCase()))
		.limit(1);
	return row ?? null;
}

export async function getCmsSiteByHostname(
	db: DbClient,
	hostname: string,
): Promise<CmsSite | null> {
	const normalized = hostname.toLowerCase();
	const platform = normalized.match(/^([a-z0-9-]+)\.cms\.tedix\.(?:dev|tech)$/);
	if (platform?.[1]) return getCmsSiteBySlug(db, platform[1]);
	const [row] = await db
		.select()
		.from(cmsSites)
		.where(eq(cmsSites.customDomain, normalized))
		.limit(1);
	return row ?? null;
}

/** Resolve only an active, provider-bound www alias for the site's current apex. */
export async function getCmsSiteByActiveWwwAlias(
	db: DbQueryClient,
	hostname: string,
): Promise<CmsSite | null> {
	const normalized = hostname.toLowerCase();
	if (!normalized.startsWith("www.")) return null;
	const primary = alias(cmsDomainClaims, "active_primary_claim");
	const [site] = await db
		.select()
		.from(cmsSites)
		.where(
			and(
				eq(cmsSites.status, "active"),
				isNotNull(cmsSites.customDomain),
				sql`${normalized} = 'www.' || ${cmsSites.customDomain}`,
				exists(
					db
						.select({ id: cmsDomainClaims.id })
						.from(cmsDomainClaims)
						.where(
							and(
								eq(cmsDomainClaims.siteId, cmsSites.id),
								eq(cmsDomainClaims.organizationId, cmsSites.organizationId),
								eq(cmsDomainClaims.hostname, normalized),
								eq(cmsDomainClaims.kind, "www_alias"),
								eq(cmsDomainClaims.status, "active"),
								isNotNull(cmsDomainClaims.providerHostnameId),
							),
						),
				),
				exists(
					db
						.select({ id: primary.id })
						.from(primary)
						.where(
							and(
								eq(primary.siteId, cmsSites.id),
								eq(primary.organizationId, cmsSites.organizationId),
								eq(primary.hostname, cmsSites.customDomain),
								eq(primary.kind, "primary"),
								eq(primary.status, "active"),
								isNotNull(primary.providerHostnameId),
							),
						),
				),
			),
		)
		.limit(1);
	return site ?? null;
}

export async function listCmsSitesByOrganization(
	db: DbQueryClient,
	organizationId: string,
): Promise<CmsSite[]> {
	return db
		.select()
		.from(cmsSites)
		.where(eq(cmsSites.organizationId, organizationId));
}

export async function getCmsSiteByIdForOrganization(
	db: DbQueryClient,
	input: { id: string; organizationId: string },
): Promise<CmsSite | null> {
	const [row] = await db
		.select()
		.from(cmsSites)
		.where(
			and(
				eq(cmsSites.id, input.id),
				eq(cmsSites.organizationId, input.organizationId),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function setCmsSiteStatus(
	db: DbQueryClient,
	id: string,
	status: "active" | "paused",
): Promise<void> {
	await db
		.update(cmsSites)
		.set({ status, updatedAt: new Date().toISOString() })
		.where(eq(cmsSites.id, id));
}

/** Pause an owned site and its authoring proxy only while restore is not closed. */
export async function pauseCmsSiteUnlessRestoring(
	db: DbQueryClient,
	input: { id: string; organizationId: string; authoringAppId: string | null },
): Promise<boolean> {
	const noRestore = notExists(
		db
			.select({ siteId: cmsRestoreFences.siteId })
			.from(cmsRestoreFences)
			.where(eq(cmsRestoreFences.siteId, input.id)),
	);
	const noCleanup = notExists(
		db
			.select({ id: cmsDeprovisionOperations.id })
			.from(cmsDeprovisionOperations)
			.where(
				and(
					eq(cmsDeprovisionOperations.id, input.id),
					eq(cmsDeprovisionOperations.organizationId, input.organizationId),
				),
			),
	);
	const authoringApp = input.authoringAppId
		? exists(
				db
					.select({ id: apps.id })
					.from(apps)
					.where(
						and(
							eq(apps.id, input.authoringAppId),
							eq(apps.organizationId, input.organizationId),
						),
					),
			)
		: undefined;
	const siteUpdate = db
		.update(cmsSites)
		.set({ status: "paused", updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(cmsSites.id, input.id),
				eq(cmsSites.organizationId, input.organizationId),
				input.authoringAppId
					? eq(cmsSites.authoringAppId, input.authoringAppId)
					: isNull(cmsSites.authoringAppId),
				inArray(cmsSites.status, ["active", "paused"]),
				noRestore,
				noCleanup,
				authoringApp,
			),
		)
		.returning({ id: cmsSites.id });
	if (!input.authoringAppId) return (await siteUpdate).length === 1;
	const pausedSite = exists(
		db
			.select({ id: cmsSites.id })
			.from(cmsSites)
			.where(
				and(
					eq(cmsSites.id, input.id),
					eq(cmsSites.organizationId, input.organizationId),
					eq(cmsSites.authoringAppId, input.authoringAppId),
					eq(cmsSites.status, "paused"),
					noRestore,
					noCleanup,
				),
			),
	);
	const [updated] = await db.batch([
		siteUpdate,
		db
			.update(apps)
			.set({ visibility: "disabled" })
			.where(
				and(
					eq(apps.id, input.authoringAppId),
					eq(apps.organizationId, input.organizationId),
					pausedSite,
					noRestore,
					noCleanup,
				),
			),
	]);
	return updated.length === 1;
}

/** Reactivate the site and its authoring proxy in one D1 batch, unless cleanup was reserved. */
export async function restoreCmsSiteUnlessDeprovisioning(
	db: DbQueryClient,
	input: { id: string; organizationId: string; authoringAppId: string | null },
): Promise<boolean> {
	const noRestore = notExists(
		db
			.select({ siteId: cmsRestoreFences.siteId })
			.from(cmsRestoreFences)
			.where(eq(cmsRestoreFences.siteId, input.id)),
	);
	const noCleanup = notExists(
		db
			.select({ id: cmsDeprovisionOperations.id })
			.from(cmsDeprovisionOperations)
			.where(
				and(
					eq(cmsDeprovisionOperations.id, input.id),
					eq(cmsDeprovisionOperations.organizationId, input.organizationId),
				),
			),
	);
	const authoringApp = input.authoringAppId
		? exists(
				db
					.select({ id: apps.id })
					.from(apps)
					.where(
						and(
							eq(apps.id, input.authoringAppId),
							eq(apps.organizationId, input.organizationId),
						),
					),
			)
		: undefined;
	const siteUpdate = db
		.update(cmsSites)
		.set({ status: "active", updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(cmsSites.id, input.id),
				eq(cmsSites.organizationId, input.organizationId),
				inArray(cmsSites.status, ["active", "paused"]),
				noCleanup,
				noRestore,
				authoringApp,
			),
		)
		.returning({ id: cmsSites.id });
	if (!input.authoringAppId) {
		const updated = await siteUpdate;
		return updated.length === 1;
	}
	const activeSite = exists(
		db
			.select({ id: cmsSites.id })
			.from(cmsSites)
			.where(
				and(
					eq(cmsSites.id, input.id),
					eq(cmsSites.organizationId, input.organizationId),
					eq(cmsSites.status, "active"),
				),
			),
	);
	const [updated] = await db.batch([
		siteUpdate,
		db
			.update(apps)
			.set({ visibility: "private" })
			.where(
				and(
					eq(apps.id, input.authoringAppId),
					eq(apps.organizationId, input.organizationId),
					activeSite,
					noCleanup,
					noRestore,
				),
			),
	]);
	return updated.length === 1;
}

/** Publish a provisioned site only while its exact identity remains unfenced. */
export async function activateCmsSiteAfterMedia(
	db: DbQueryClient,
	input: { siteId: string; slug: string },
): Promise<CmsSite | null> {
	const rows = await db.all<{ id: string }>(sql`
		UPDATE cms_sites AS site
		SET status = 'active', updated_at = datetime('now')
		WHERE site.id = ${input.siteId}
			AND site.slug = ${input.slug}
			AND site.status = 'provisioning'
			AND NOT EXISTS (
				SELECT 1 FROM cms_restore_fences AS fence
				WHERE fence.site_id = site.id
			)
			AND NOT EXISTS (
				SELECT 1 FROM cms_deprovision_operations AS operation
				WHERE operation.id = site.id
			)
		RETURNING id
	`);
	if (rows.length !== 1) return null;
	return getCmsSiteBySlug(db, input.slug);
}

export async function deleteCmsSite(
	db: DbQueryClient,
	id: string,
): Promise<void> {
	await db.delete(cmsSites).where(eq(cmsSites.id, id));
}

export async function registerCmsSite(
	db: DbQueryClient,
	input: NewCmsSite,
): Promise<CmsSite> {
	const [row] = await db.insert(cmsSites).values(input).returning();
	if (!row) throw new Error("CMS site insert returned no row");
	return row;
}

/** A concurrent create with the same slug wins once; the caller verifies its owner and settings. */
export async function registerCmsSiteIfAbsent(
	db: DbQueryClient,
	input: NewCmsSite,
): Promise<CmsSite | null> {
	const [row] = await db
		.insert(cmsSites)
		.values(input)
		.onConflictDoNothing({ target: cmsSites.slug })
		.returning();
	return row ?? null;
}

/** Admit a new site against the organization's quota in one D1 statement. */
export async function registerCmsSiteWithinQuota(
	db: DbQueryClient,
	input: NewCmsSite,
	maxCmsSites: number,
): Promise<CmsSite | null> {
	if (!Number.isSafeInteger(maxCmsSites) || maxCmsSites < -1)
		throw new Error("CMS site quota must be -1 or a non-negative integer");
	const inserted = await db.all<{ id: string }>(sql`
		INSERT INTO cms_sites (
			id, organization_id, slug, name, canonical_url,
			custom_domain, template_slug, config, authoring_app_id, status
		)
		SELECT ${input.id}, ${input.organizationId}, ${input.slug},
			${input.name}, ${input.canonicalUrl}, ${input.customDomain ?? null},
			${input.templateSlug ?? "tedix"},
			${input.config ? JSON.stringify(input.config) : null},
			${input.authoringAppId ?? null}, ${input.status ?? "active"}
		WHERE ${maxCmsSites} = -1 OR (
			SELECT COUNT(*) FROM cms_sites
			WHERE organization_id = ${input.organizationId}
		) < ${maxCmsSites}
		ON CONFLICT(slug) DO NOTHING
		RETURNING id
	`);
	return inserted.length ? getCmsSiteBySlug(db, input.slug) : null;
}

export async function updateCmsSiteDomain(
	db: DbQueryClient,
	input: {
		id: string;
		organizationId: string;
		customDomain: string | null;
		canonicalUrl: string;
	},
): Promise<CmsSite | null> {
	const [row] = await db
		.update(cmsSites)
		.set({
			customDomain: input.customDomain,
			canonicalUrl: input.canonicalUrl,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(cmsSites.id, input.id),
				eq(cmsSites.organizationId, input.organizationId),
			),
		)
		.returning();
	return row ?? null;
}
