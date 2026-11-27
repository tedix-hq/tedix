import { and, desc, eq, exists, isNull, sql } from "drizzle-orm";
import { coreTable } from "../core-store/client";
import {
	booleanValue,
	coreStore,
	jsonRead,
	jsonType,
	jsonWrite,
} from "../core-store/dialect";
import { createDbQueryClient, type DbQueryClient } from "../query-client";
import { cmsSites as sitesSchema } from "../schema/cms-sites";
import { organizations as organizationsSchema } from "../schema/organizations";
import {
	tenantBundles as bundlesSchema,
	type NewTenantBundle,
} from "../schema/tenant-bundles";
import { cmsDateTime, runCmsWrite, runCmsWriteBatch } from "./cms-write-batch";

export async function getCmsDeploymentRoute(db: DbQueryClient, slug: string) {
	const sites = coreTable(db, sitesSchema);
	const [row] = await db
		.select({ templateSlug: sites.templateSlug, publicUrl: sites.canonicalUrl })
		.from(sites)
		.where(eq(sites.slug, slug))
		.limit(1);
	return row ?? null;
}

export async function getCmsTemplateOwner(db: DbQueryClient, slug: string) {
	const sites = coreTable(db, sitesSchema);
	const organizations = coreTable(db, organizationsSchema);
	const [row] = await db
		.select({
			organizationId: organizations.id,
			blogTemplateSlug: sites.templateSlug,
		})
		.from(sites)
		.innerJoin(organizations, eq(sites.organizationId, organizations.id))
		.where(
			and(
				eq(sites.slug, slug.toLowerCase()),
				eq(sites.status, "active"),
				isNull(jsonRead(db, organizations.metadata, ["retiredAt"])),
			),
		)
		.limit(1);
	return row ? { ...row, metaTemplateSlug: null } : null;
}

/** One statement observes tenant authority and the immutable active generation. */
export async function getCmsHumanAuthorityRow(db: DbQueryClient, slug: string) {
	const sites = coreTable(db, sitesSchema);
	const organizations = coreTable(db, organizationsSchema);
	const enabled = booleanValue(db, true);
	const [row] = await db
		.select({
			siteId: sites.id,
			status: sites.status,
			ownerTenantId: organizations.descopeTenantId,
			explicitTenantId: jsonRead(
				db,
				sites.config,
				["blog", "authDescopeTenantId"],
				"json",
			),
			retiredAt: jsonRead(db, organizations.metadata, ["retiredAt"]),
			humanAssertionBundleEtag: jsonRead(
				db,
				sites.config,
				["blog", "humanAssertionBundleEtag"],
				"json",
			),
			blogType: jsonType(db, sites.config, ["blog"]),
			activeBundleCount:
				sql<number>`(SELECT COUNT(*) FROM tenant_bundles b WHERE b.slug = ${sites.slug} AND b.is_active = ${enabled})`.mapWith(
					Number,
				),
			activeVersion: sql<
				number | null
			>`(SELECT b.version FROM tenant_bundles b WHERE b.slug = ${sites.slug} AND b.is_active = ${enabled} LIMIT 1)`.mapWith(
				Number,
			),
			activeBundleEtag: sql<
				string | null
			>`(SELECT b.etag FROM tenant_bundles b WHERE b.slug = ${sites.slug} AND b.is_active = ${enabled} LIMIT 1)`,
			r2Prefix: sql<
				string | null
			>`(SELECT b.r2_prefix FROM tenant_bundles b WHERE b.slug = ${sites.slug} AND b.is_active = ${enabled} LIMIT 1)`,
			mainModule: sql<
				string | null
			>`(SELECT b.main_module FROM tenant_bundles b WHERE b.slug = ${sites.slug} AND b.is_active = ${enabled} LIMIT 1)`,
			modulesJson: sql<unknown>`(SELECT b.modules_json FROM tenant_bundles b WHERE b.slug = ${sites.slug} AND b.is_active = ${enabled} LIMIT 1)`,
		})
		.from(sites)
		.innerJoin(organizations, eq(organizations.id, sites.organizationId))
		.where(eq(sites.slug, slug.toLowerCase()))
		.limit(1);
	if (!row) return null;
	// SQLite returns JSON text for objects/arrays; PostgreSQL returns decoded JSON.
	return {
		...row,
		modulesJson:
			typeof row.modulesJson === "string"
				? row.modulesJson
				: row.modulesJson == null
					? null
					: JSON.stringify(row.modulesJson),
	};
}

export interface CmsHumanAuthMarkerParams {
	slug: string;
	expectedSiteId: string;
	expectedTenantId: string;
	expectedVersion: number;
	expectedBundleEtag: string;
	expectedCurrentMarker: string | null;
	enabled: boolean;
}

export async function compareAndSetCmsHumanAuthMarker(
	db: DbQueryClient,
	input: CmsHumanAuthMarkerParams,
) {
	const sites = coreTable(db, sitesSchema);
	const organizations = coreTable(db, organizationsSchema);
	const bundles = coreTable(db, bundlesSchema);
	const marker = jsonRead(db, sites.config, [
		"blog",
		"humanAssertionBundleEtag",
	]);
	const removed =
		coreStore(db) === "postgres"
			? sql`${sites.config} #- '{blog,humanAssertionBundleEtag}'`
			: sql`json_remove(${sites.config}, '$.blog.humanAssertionBundleEtag')`;
	const rows = await runCmsWrite(
		db,
		db
			.update(sites)
			.set({
				config: input.enabled
					? jsonWrite(
							db,
							sites.config,
							["blog", "humanAssertionBundleEtag"],
							input.expectedBundleEtag,
						)
					: removed,
				updatedAt: cmsDateTime(db),
			})
			.where(
				and(
					eq(sites.id, input.expectedSiteId),
					eq(sites.slug, input.slug.toLowerCase()),
					eq(sites.status, "active"),
					eq(jsonType(db, sites.config, ["blog"]), "object"),
					input.expectedCurrentMarker === null
						? isNull(marker)
						: eq(marker, input.expectedCurrentMarker),
					sql`(SELECT COUNT(*) FROM ${bundles} b WHERE b.slug = ${sites.slug} AND b.is_active = ${booleanValue(db, true)}) = 1`,
					exists(
						db
							.select({ id: bundles.id })
							.from(bundles)
							.where(
								and(
									eq(bundles.slug, sites.slug),
									eq(bundles.isActive, true),
									eq(bundles.version, input.expectedVersion),
									eq(bundles.etag, input.expectedBundleEtag),
								),
							),
					),
					exists(
						db
							.select({ id: organizations.id })
							.from(organizations)
							.where(
								and(
									eq(organizations.id, sites.organizationId),
									isNull(jsonRead(db, organizations.metadata, ["retiredAt"])),
									sql`COALESCE(NULLIF(${jsonRead(db, sites.config, ["blog", "authDescopeTenantId"])}, ''), ${organizations.descopeTenantId}) = ${input.expectedTenantId}`,
								),
							),
					),
				),
			)
			.returning({ id: sites.id }),
	);
	return rows.length === 1;
}

export async function readCmsDeployAdmission(
	db: DbQueryClient,
	site: { siteId: string; slug: string; restoreEpoch: number },
) {
	const sites = coreTable(db, sitesSchema);
	const [row] = await db
		.select({ jobId: jsonRead(db, sites.config, ["deployAdmission"]) })
		.from(sites)
		.where(
			and(
				eq(sites.id, site.siteId),
				eq(sites.slug, site.slug),
				eq(sites.restoreEpoch, site.restoreEpoch),
				eq(sites.status, "active"),
			),
		)
		.limit(1);
	if (!row) throw new Error("CMS deploy site changed during admission");
	return row.jobId as string | null;
}

export async function compareAndSetCmsDeployAdmission(
	db: DbQueryClient,
	site: { siteId: string; slug: string; restoreEpoch: number },
	previous: string | null,
	jobId: string,
) {
	const sites = coreTable(db, sitesSchema);
	const admission = jsonRead(db, sites.config, ["deployAdmission"]);
	const rows = await runCmsWrite(
		db,
		db
			.update(sites)
			.set({ config: jsonWrite(db, sites.config, ["deployAdmission"], jobId) })
			.where(
				and(
					eq(sites.id, site.siteId),
					eq(sites.slug, site.slug),
					eq(sites.restoreEpoch, site.restoreEpoch),
					eq(sites.status, "active"),
					previous === null ? isNull(admission) : eq(admission, previous),
				),
			)
			.returning({ id: sites.id }),
	);
	return rows.length === 1;
}

export async function writeCmsHotThemeMetadata(
	db: DbQueryClient,
	slug: string,
	hotTheme: Record<string, unknown>,
) {
	const sites = coreTable(db, sitesSchema);
	await runCmsWrite(
		db,
		db
			.update(sites)
			.set({
				config: jsonWrite(db, sites.config, ["blog", "hotTheme"], hotTheme),
				updatedAt: cmsDateTime(db),
			})
			.where(eq(sites.slug, slug)),
	);
}

export async function readCmsBundleGeneration(db: DbQueryClient, slug: string) {
	const bundles = coreTable(db, bundlesSchema);
	const [row] = await db
		.select({
			nextVersion:
				sql<number>`COALESCE(MAX(${bundles.version}), 0) + 1`.mapWith(Number),
			activeVersion: sql<
				number | null
			>`MAX(CASE WHEN ${bundles.isActive} = ${booleanValue(db, true)} THEN ${bundles.version} END)`.mapWith(
				Number,
			),
			activeEtag: sql<
				string | null
			>`MAX(CASE WHEN ${bundles.isActive} = ${booleanValue(db, true)} THEN ${bundles.etag} END)`,
			activeCount:
				sql<number>`COALESCE(SUM(CASE WHEN ${bundles.isActive} = ${booleanValue(db, true)} THEN 1 ELSE 0 END), 0)`.mapWith(
					Number,
				),
			hasArtifactsHistory:
				sql<number>`COALESCE(MAX(CASE WHEN ${bundles.sourceRevision} LIKE 'artifacts-commit:%' THEN 1 ELSE 0 END), 0)`.mapWith(
					Number,
				),
		})
		.from(bundles)
		.where(eq(bundles.slug, slug));
	return row!;
}

export async function getCmsBundle(
	db: DbQueryClient,
	slug: string,
	version: number,
) {
	const bundles = coreTable(db, bundlesSchema);
	const [row] = await db
		.select()
		.from(bundles)
		.where(and(eq(bundles.slug, slug), eq(bundles.version, version)))
		.limit(1);
	return row ?? null;
}

export async function reserveCmsBundle(
	db: DbQueryClient,
	bundle: NewTenantBundle,
) {
	const bundles = coreTable(db, bundlesSchema);
	await runCmsWrite(
		db,
		db
			.insert(bundles)
			.values(bundle)
			.onConflictDoNothing({ target: [bundles.slug, bundles.version] }),
	);
}

export async function listCmsBundleVersions(db: DbQueryClient, slug: string) {
	const bundles = coreTable(db, bundlesSchema);
	return db
		.select()
		.from(bundles)
		.where(eq(bundles.slug, slug))
		.orderBy(desc(bundles.version));
}

export async function deleteCmsBundles(db: DbQueryClient, slug: string) {
	const bundles = coreTable(db, bundlesSchema);
	await runCmsWrite(db, db.delete(bundles).where(eq(bundles.slug, slug)));
}

export async function readCmsHumanAuthMarker(db: DbQueryClient, slug: string) {
	const sites = coreTable(db, sitesSchema);
	const [row] = await db
		.select({
			marker: jsonRead(db, sites.config, ["blog", "humanAssertionBundleEtag"]),
		})
		.from(sites)
		.where(and(eq(sites.slug, slug), eq(sites.status, "active")))
		.limit(1);
	return row?.marker ?? null;
}

export interface ActivateCmsBundleParams {
	slug: string;
	targetId: string;
	expectedActiveVersion: number | null;
	carry: { previousEtag: string; targetEtag: string } | null;
}

/** Serialize publication with restore/retention writes and carry authority only on a winning CAS. */
export async function activateCmsBundle(
	db: DbQueryClient,
	input: ActivateCmsBundleParams,
) {
	const { slug, targetId, expectedActiveVersion: previous, carry } = input;
	const noRetention = sql`NOT EXISTS (SELECT 1 FROM cms_restore_permits maintenance
		WHERE maintenance.slug = ${slug} AND maintenance.kind = 'scheduled'
		AND (maintenance.id LIKE 'bundle-retention:%' OR maintenance.id LIKE 'lease:v1:bundle-retention:%'))`;
	const bundles = coreTable(db, bundlesSchema);
	const sites = coreTable(db, sitesSchema);
	const noActive = sql`NOT EXISTS (SELECT 1 FROM tenant_bundles active WHERE active.slug = ${slug} AND active.is_active = ${booleanValue(db, true)})`;
	const releaseCurrent = db
		.update(bundles)
		.set({ isActive: false })
		.where(
			and(
				eq(bundles.slug, slug),
				sql`${bundles.version} = ${previous}`,
				eq(bundles.isActive, true),
				noRetention,
				sql`EXISTS (SELECT 1 FROM tenant_bundles target WHERE target.id = ${targetId} AND target.slug = ${slug} AND target.is_active = ${booleanValue(db, false)})`,
				sql`NOT EXISTS (SELECT 1 FROM tenant_bundles active WHERE active.slug = ${slug} AND active.is_active = ${booleanValue(db, true)} AND active.version <> ${previous})`,
			),
		)
		.returning({ id: bundles.id });
	if (coreStore(db) === "postgres") {
		// Each write consumes the winning CAS's RETURNING rows, in one atomic statement.
		const released = db
			.$with("released", { id: bundles.id })
			.as(releaseCurrent.getSQL());
		const activated = db
			.$with("activated", { id: bundles.id, etag: bundles.etag })
			.as(
				db
					.update(bundles)
					.set({ isActive: true })
					.where(
						and(
							eq(bundles.id, targetId),
							eq(bundles.slug, slug),
							eq(bundles.isActive, false),
							noRetention,
							previous === null
								? noActive
								: exists(db.select({ id: released.id }).from(released)),
						),
					)
					.returning({ id: bundles.id, etag: bundles.etag })
					.getSQL(),
			);
		const carried = db.$with("carried", { id: sites.id }).as(
			db
				.update(sites)
				.set({
					config: jsonWrite(
						db,
						sites.config,
						["blog", "humanAssertionBundleEtag"],
						carry?.targetEtag ?? null,
					),
					updatedAt: cmsDateTime(db),
				})
				.where(
					and(
						eq(sites.slug, slug),
						eq(sites.status, "active"),
						eq(jsonType(db, sites.config, ["blog"]), "object"),
						sql`${jsonRead(db, sites.config, ["blog", "humanAssertionBundleEtag"])} = ${carry?.previousEtag ?? null}`,
						exists(
							db
								.select({ id: activated.id })
								.from(activated)
								.where(sql`${activated.etag} = ${carry?.targetEtag ?? null}`),
						),
					),
				)
				.returning({ id: sites.id })
				.getSQL(),
		);
		const statement = db
			.with(released, activated, carried)
			.select({
				activated: exists(
					db.select({ id: activated.id }).from(activated),
				).mapWith(Boolean),
				carried: exists(db.select({ id: carried.id }).from(carried)).mapWith(
					Boolean,
				),
			})
			.from(sql`(select 1) as cms_result`);
		const [rows] = await runCmsWriteBatch(db, [statement]);
		return rows[0]!;
	}
	const release =
		previous === null
			? db
					.update(bundles)
					.set({ isActive: bundles.isActive })
					.where(
						and(
							eq(bundles.id, targetId),
							eq(bundles.slug, slug),
							eq(bundles.isActive, false),
							noRetention,
							noActive,
						),
					)
					.returning({ id: bundles.id })
			: releaseCurrent;
	const activation = db
		.update(bundles)
		.set({ isActive: true })
		.where(
			and(
				eq(bundles.id, targetId),
				eq(bundles.slug, slug),
				eq(bundles.isActive, false),
				sql`changes() = 1`,
				noActive,
			),
		)
		.returning({ id: bundles.id });
	const marker = db
		.update(sites)
		.set({
			config: jsonWrite(
				db,
				sites.config,
				["blog", "humanAssertionBundleEtag"],
				carry?.targetEtag ?? null,
			),
			updatedAt: cmsDateTime(db),
		})
		.where(
			and(
				eq(sites.slug, slug),
				eq(sites.status, "active"),
				sql`changes() = 1`,
				eq(jsonType(db, sites.config, ["blog"]), "object"),
				sql`${jsonRead(db, sites.config, ["blog", "humanAssertionBundleEtag"])} = ${carry?.previousEtag ?? null}`,
				sql`(SELECT COUNT(*) FROM tenant_bundles b WHERE b.slug = ${sites.slug} AND b.is_active = 1) = 1`,
				sql`EXISTS (SELECT 1 FROM tenant_bundles b WHERE b.id = ${targetId} AND b.slug = ${sites.slug} AND b.is_active = 1 AND b.etag = ${carry?.targetEtag ?? null})`,
			),
		)
		.returning({ id: sites.id });
	const [, activated, carried] = await runCmsWriteBatch(db, [
		release,
		activation,
		marker,
	]);
	return { activated: activated.length === 1, carried: carried.length === 1 };
}

export async function readCmsFleetBundles(db: DbQueryClient) {
	const sites = coreTable(db, sitesSchema);
	const bundles = coreTable(db, bundlesSchema);
	return db
		.select({
			slug: bundles.slug,
			activeVersion: bundles.version,
			latestVersion:
				sql<number>`(SELECT MAX(latest.version) FROM tenant_bundles latest WHERE latest.slug = ${bundles.slug})`.mapWith(
					Number,
				),
			deployedAt: bundles.deployedAt,
			promptSummary: bundles.summary,
			defaultLocale: sql<
				string | null
			>`${jsonRead(db, sites.config, ["blog", "defaultLocale"])}`,
			cmsDomain: sites.customDomain,
			publicSiteUrl: sites.canonicalUrl,
			templateSlug: sites.templateSlug,
		})
		.from(bundles)
		.innerJoin(sites, eq(sites.slug, bundles.slug))
		.where(eq(bundles.isActive, true))
		.orderBy(bundles.slug);
}

export type CmsDatabase =
	| DbQueryClient
	| Parameters<typeof createDbQueryClient>[0];

/** Core callers supply the selected client; explicit D1 callers can supply their binding. */
export function cmsQueryDb(db: CmsDatabase): DbQueryClient {
	return "prepare" in db ? createDbQueryClient(db) : db;
}
