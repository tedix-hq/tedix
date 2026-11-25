import { coreStore, jsonRead } from "../core-store/dialect";
import { cmsDateTime } from "./cms-write-batch";
import { coreTable } from "../core-store/client";
import { runCmsWrite, runCmsWriteBatch } from "./cms-write-batch";
import {
	and,
	count,
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
import { apps as schemaApps } from "../schema/apps";
import { cmsDeprovisionOperations as schemaCmsDeprovisionOperations } from "../schema/cms-deprovision-operations";
import { cmsDomainClaims as schemaCmsDomainClaims } from "../schema/cms-domain-claims";
import { cmsRestoreFences as schemaCmsRestoreFences } from "../schema/cms-restore-fences";
import {
	cmsSites as schemaCmsSites,
	type CmsSite,
	type NewCmsSite,
} from "../schema/cms-sites";

export interface RotateCmsSitePageCacheRevisionParams {
	siteId: string;
	slug: string;
	restoreEpoch: number;
	revision: string;
	/** Fixed-size entry bucket; absent means dependencies could not be narrowed. */
	entryBucket?: number;
}

export async function rotateCmsSitePageCacheRevision(
	db: DbQueryClient,
	input: RotateCmsSitePageCacheRevisionParams,
): Promise<void> {
	const cmsSites = coreTable(db, schemaCmsSites);
	if (
		input.entryBucket !== undefined &&
		(!Number.isInteger(input.entryBucket) ||
			input.entryBucket < 0 ||
			input.entryBucket >= 64)
	)
		throw new Error("Invalid CMS page cache entry bucket");
	const revisionPath =
		input.entryBucket === undefined
			? "$.pageCacheSharedRevision"
			: `$.pageCacheEntryRevisions."${input.entryBucket}"`;
	const config = sql`coalesce(${cmsSites.config}, '{}'::jsonb)`;
	const pgRevision = sql`${config} || jsonb_build_object('pageCacheRevision', ${input.revision}::text)`;
	const pgConfig =
		input.entryBucket === undefined
			? sql`${pgRevision} || jsonb_build_object('pageCacheSharedRevision', ${input.revision}::text)`
			: sql`jsonb_set(${pgRevision}, '{pageCacheEntryRevisions}', coalesce(${config}->'pageCacheEntryRevisions', '{}'::jsonb) || jsonb_build_object(${String(input.entryBucket)}::text, ${input.revision}::text), true)`;
	await runCmsWrite(
		db,
		db
			.update(cmsSites)
			.set({
				config:
					coreStore(db) === "d1"
						? sql`json_set(coalesce(${cmsSites.config}, '{}'), '$.pageCacheRevision', ${input.revision}, ${revisionPath}, ${input.revision})`
						: pgConfig,
			})
			.where(
				and(
					eq(cmsSites.id, input.siteId),
					eq(cmsSites.slug, input.slug),
					eq(cmsSites.restoreEpoch, input.restoreEpoch),
					coreStore(db) === "d1"
						? sql`json_extract(${cmsSites.config}, '$.pageCacheRevision') IS NOT ${input.revision}`
						: sql`${jsonRead(db, cmsSites.config, ["pageCacheRevision"])} IS DISTINCT FROM ${input.revision}`,
				),
			),
	);
}

export async function getCmsSiteById(
	db: DbQueryClient,
	id: string,
): Promise<CmsSite | null> {
	const cmsSites = coreTable(db, schemaCmsSites);
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
	const cmsSites = coreTable(db, schemaCmsSites);
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
	const cmsSites = coreTable(db, schemaCmsSites);
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
	const cmsDomainClaims = coreTable(db, schemaCmsDomainClaims);
	const cmsSites = coreTable(db, schemaCmsSites);
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
	const cmsSites = coreTable(db, schemaCmsSites);
	return db
		.select()
		.from(cmsSites)
		.where(eq(cmsSites.organizationId, organizationId));
}

export async function getCmsSiteByIdForOrganization(
	db: DbQueryClient,
	input: { id: string; organizationId: string },
): Promise<CmsSite | null> {
	const cmsSites = coreTable(db, schemaCmsSites);
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
	const cmsSites = coreTable(db, schemaCmsSites);
	await runCmsWrite(
		db,
		db
			.update(cmsSites)
			.set({ status, updatedAt: new Date().toISOString() })
			.where(eq(cmsSites.id, id)),
	);
}

/** Pause an owned site and its authoring proxy only while restore is not closed. */
export async function pauseCmsSiteUnlessRestoring(
	db: DbQueryClient,
	input: { id: string; organizationId: string; authoringAppId: string | null },
): Promise<boolean> {
	const apps = coreTable(db, schemaApps);
	const cmsDeprovisionOperations = coreTable(
		db,
		schemaCmsDeprovisionOperations,
	);
	const cmsRestoreFences = coreTable(db, schemaCmsRestoreFences);
	const cmsSites = coreTable(db, schemaCmsSites);
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
	if (!input.authoringAppId)
		return (await runCmsWrite(db, siteUpdate)).length === 1;
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
	const [updated] = await runCmsWriteBatch(db, [
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

/** Reactivate the site and its authoring proxy in one batch, unless cleanup was reserved. */
export async function restoreCmsSiteUnlessDeprovisioning(
	db: DbQueryClient,
	input: { id: string; organizationId: string; authoringAppId: string | null },
): Promise<boolean> {
	const apps = coreTable(db, schemaApps);
	const cmsDeprovisionOperations = coreTable(
		db,
		schemaCmsDeprovisionOperations,
	);
	const cmsRestoreFences = coreTable(db, schemaCmsRestoreFences);
	const cmsSites = coreTable(db, schemaCmsSites);
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
		const updated = await runCmsWrite(db, siteUpdate);
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
	const [updated] = await runCmsWriteBatch(db, [
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
	const cmsDeprovisionOperations = coreTable(
		db,
		schemaCmsDeprovisionOperations,
	);
	const cmsRestoreFences = coreTable(db, schemaCmsRestoreFences);
	const cmsSites = coreTable(db, schemaCmsSites);
	const rows = await runCmsWrite(
		db,
		db
			.update(cmsSites)
			.set({ status: "active", updatedAt: cmsDateTime(db) })
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
			.returning({ id: cmsSites.id }),
	);
	if (rows.length !== 1) return null;
	return getCmsSiteBySlug(db, input.slug);
}

/**
 * Re-home an active site and its domain claims in one batch. A deprovision
 * receipt or a closed restore fence refuses the move.
 */
export async function moveCmsSiteToOrganization(
	db: DbQueryClient,
	input: {
		id: string;
		fromOrganizationId: string;
		toOrganizationId: string;
	},
): Promise<boolean> {
	const cmsDeprovisionOperations = coreTable(
		db,
		schemaCmsDeprovisionOperations,
	);
	const cmsDomainClaims = coreTable(db, schemaCmsDomainClaims);
	const cmsRestoreFences = coreTable(db, schemaCmsRestoreFences);
	const cmsSites = coreTable(db, schemaCmsSites);
	const now = new Date().toISOString();
	const [moved] = await runCmsWriteBatch(db, [
		db
			.update(cmsSites)
			.set({ organizationId: input.toOrganizationId, updatedAt: now })
			.where(
				and(
					eq(cmsSites.id, input.id),
					eq(cmsSites.organizationId, input.fromOrganizationId),
					eq(cmsSites.status, "active"),
					notExists(
						db
							.select({ one: sql`1` })
							.from(cmsDeprovisionOperations)
							.where(eq(cmsDeprovisionOperations.id, cmsSites.id)),
					),
					notExists(
						db
							.select({ one: sql`1` })
							.from(cmsRestoreFences)
							.where(eq(cmsRestoreFences.siteId, cmsSites.id)),
					),
				),
			)
			.returning({ id: cmsSites.id }),
		// Runs only once the site row above belongs to the target.
		db
			.update(cmsDomainClaims)
			.set({ organizationId: input.toOrganizationId, updatedAt: now })
			.where(
				and(
					eq(cmsDomainClaims.siteId, input.id),
					eq(cmsDomainClaims.organizationId, input.fromOrganizationId),
					exists(
						db
							.select({ one: sql`1` })
							.from(cmsSites)
							.where(
								and(
									eq(cmsSites.id, input.id),
									eq(cmsSites.organizationId, input.toOrganizationId),
								),
							),
					),
				),
			),
	]);
	return moved.length === 1;
}

export async function setCmsSiteAuthoringApp(
	db: DbQueryClient,
	input: { id: string; organizationId: string; authoringAppId: string },
): Promise<boolean> {
	const cmsSites = coreTable(db, schemaCmsSites);
	const rows = await runCmsWrite(
		db,
		db
			.update(cmsSites)
			.set({
				authoringAppId: input.authoringAppId,
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(cmsSites.id, input.id),
					eq(cmsSites.organizationId, input.organizationId),
				),
			)
			.returning({ id: cmsSites.id }),
	);
	return rows.length === 1;
}

export async function deleteCmsSite(
	db: DbQueryClient,
	id: string,
): Promise<void> {
	const cmsSites = coreTable(db, schemaCmsSites);
	await runCmsWrite(db, db.delete(cmsSites).where(eq(cmsSites.id, id)));
}

export async function registerCmsSite(
	db: DbQueryClient,
	input: NewCmsSite,
): Promise<CmsSite> {
	const cmsSites = coreTable(db, schemaCmsSites);
	const [row] = await runCmsWrite(
		db,
		db.insert(cmsSites).values(input).returning(),
	);
	if (!row) throw new Error("CMS site insert returned no row");
	return row;
}

/** A concurrent create with the same slug wins once; the caller verifies its owner and settings. */
export async function registerCmsSiteIfAbsent(
	db: DbQueryClient,
	input: NewCmsSite,
): Promise<CmsSite | null> {
	const cmsSites = coreTable(db, schemaCmsSites);
	const [row] = await runCmsWrite(
		db,
		db
			.insert(cmsSites)
			.values(input)
			.onConflictDoNothing({ target: cmsSites.slug })
			.returning(),
	);
	return row ?? null;
}

/** Admit a new site against the organization's quota in one serialized batch. */
export async function registerCmsSiteWithinQuota(
	db: DbQueryClient,
	input: NewCmsSite,
	maxCmsSites: number,
): Promise<CmsSite | null> {
	const cmsSites = coreTable(db, schemaCmsSites);
	if (!Number.isSafeInteger(maxCmsSites) || maxCmsSites < 0)
		throw new Error("CMS site quota must be a non-negative integer");
	// COUNT(*) without GROUP BY yields exactly one row, so the insert reads one
	// candidate row that the quota predicate keeps or drops.
	const quota = db
		.select({ siteCount: count().as("site_count") })
		.from(cmsSites)
		.where(eq(cmsSites.organizationId, input.organizationId))
		.as("quota");
	const inserted = await runCmsWrite(
		db,
		db
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
						canonicalUrl: sql<string>`${input.canonicalUrl}`.as(
							"canonical_url",
						),
						customDomain: sql<string | null>`${input.customDomain ?? null}`.as(
							"custom_domain",
						),
						templateSlug: sql<string>`${input.templateSlug ?? "tedix"}`.as(
							"template_slug",
						),
						config: (input.config
							? coreStore(db) === "postgres"
								? sql`${JSON.stringify(input.config)}::text::jsonb`
								: sql`${JSON.stringify(input.config)}`
							: sql`NULL`
						).as("config"),
						authoringAppId: sql<
							string | null
						>`${input.authoringAppId ?? null}`.as("authoring_app_id"),
						status: sql<string>`${input.status ?? "active"}`.as("status"),
					})
					.from(quota)
					.where(sql`${quota.siteCount} < ${maxCmsSites}`),
			)
			.onConflictDoNothing({ target: cmsSites.slug })
			.returning({ id: cmsSites.id }),
	);
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
	const cmsSites = coreTable(db, schemaCmsSites);
	const [row] = await runCmsWrite(
		db,
		db
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
			.returning(),
	);
	return row ?? null;
}
