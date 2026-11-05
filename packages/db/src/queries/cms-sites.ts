import {
	and,
	count,
	eq,
	exists,
	inArray,
	isNotNull,
	isNull,
	notExists,
	or,
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

export interface RotateCmsSitePageCacheRevisionParams {
	siteId: string;
	slug: string;
	restoreEpoch: number;
	revision: string;
}

export async function rotateCmsSitePageCacheRevision(
	db: DbQueryClient,
	input: RotateCmsSitePageCacheRevisionParams,
): Promise<void> {
	await db
		.update(cmsSites)
		.set({
			config: sql`json_set(coalesce(${cmsSites.config}, '{}'), '$.pageCacheRevision', ${input.revision})`,
		})
		.where(
			and(
				eq(cmsSites.id, input.siteId),
				eq(cmsSites.slug, input.slug),
				eq(cmsSites.restoreEpoch, input.restoreEpoch),
				sql`json_extract(${cmsSites.config}, '$.pageCacheRevision') IS NOT ${input.revision}`,
			),
		);
}

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
	const rows = await db
		.update(cmsSites)
		.set({ status: "active", updatedAt: sql`datetime('now')` })
		.where(
			and(
				eq(cmsSites.id, input.siteId),
				eq(cmsSites.slug, input.slug),
				eq(cmsSites.status, "provisioning"),
				notExists(
					db
						.select({ one: sql`1` })
						.from(cmsRestoreFences)
						.where(eq(cmsRestoreFences.siteId, cmsSites.id)),
				),
				notExists(
					db
						.select({ one: sql`1` })
						.from(cmsDeprovisionOperations)
						.where(eq(cmsDeprovisionOperations.id, cmsSites.id)),
				),
			),
		)
		.returning({ id: cmsSites.id });
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
	// COUNT(*) without GROUP BY yields exactly one row, so the insert reads one
	// candidate row that the quota predicate keeps or drops.
	const quota = db
		.select({ siteCount: count().as("site_count") })
		.from(cmsSites)
		.where(eq(cmsSites.organizationId, input.organizationId))
		.as("quota");
	const inserted = await db
		.insert(cmsSites)
		.select(
			db
				.select({
					id: sql<string>`${input.id}`.as("id"),
					organizationId: sql<string>`${input.organizationId}`.as(
						"organization_id",
					),
					slug: sql<string>`${input.slug}`.as("slug"),
					name: sql<string>`${input.name}`.as("name"),
					canonicalUrl: sql<string>`${input.canonicalUrl}`.as("canonical_url"),
					customDomain: sql<string | null>`${input.customDomain ?? null}`.as(
						"custom_domain",
					),
					templateSlug: sql<string>`${input.templateSlug ?? "tedix"}`.as(
						"template_slug",
					),
					config: sql<string | null>`${
						input.config ? JSON.stringify(input.config) : null
					}`.as("config"),
					authoringAppId: sql<
						string | null
					>`${input.authoringAppId ?? null}`.as("authoring_app_id"),
					status: sql<string>`${input.status ?? "active"}`.as("status"),
				})
				.from(quota)
				.where(
					or(
						sql`${maxCmsSites} = -1`,
						sql`${quota.siteCount} < ${maxCmsSites}`,
					),
				),
		)
		.onConflictDoNothing({ target: cmsSites.slug })
		.returning({ id: cmsSites.id });
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
