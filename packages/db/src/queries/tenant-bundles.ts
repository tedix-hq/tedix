/**
 * Tenant Bundle Queries
 *
 * Catalog lookup and retention for CMS runtime bundles. Publication and
 * activation live in `packages/provisioning/src/cms.ts`.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { alias } from "drizzle-orm/sqlite-core";
import { coreTable } from "../core-store/client";
import type { DbQueryClient } from "../query-client";
import {
	type TenantBundle,
	tenantBundles as schemaTenantBundles,
} from "../schema/tenant-bundles";

/**
 * Get the active bundle for a CMS app slug. Returns null when no bundle is
 * currently flagged `is_active = 1` (meaning the app is provisioned but no
 * deploy has landed yet, or all versions have been deactivated).
 */
export async function getActiveTenantBundle(
	db: DbClient,
	slug: string,
): Promise<TenantBundle | null> {
	const tenantBundles = coreTable(db, schemaTenantBundles);
	const rows = await db
		.select()
		.from(tenantBundles)
		.where(and(eq(tenantBundles.slug, slug), eq(tenantBundles.isActive, true)))
		.limit(1);
	return rows[0] ?? null;
}

/**
 * List all active CMS bundles for parent-runtime maintenance fanout.
 */
export async function listActiveTenantBundles(
	db: DbClient,
): Promise<TenantBundle[]> {
	const tenantBundles = coreTable(db, schemaTenantBundles);
	return db
		.select()
		.from(tenantBundles)
		.where(eq(tenantBundles.isActive, true));
}

export async function getTenantBundleSummary(
	db: DbClient,
	slug: string,
): Promise<{
	activeVersion: number | null;
	lastDeployedAt: string | null;
}> {
	const tenantBundles = coreTable(db, schemaTenantBundles);
	const rows = await db
		.select({
			version: tenantBundles.version,
			deployedAt: tenantBundles.deployedAt,
			isActive: tenantBundles.isActive,
		})
		.from(tenantBundles)
		.where(eq(tenantBundles.slug, slug));
	return {
		activeVersion: rows.find((row) => row.isActive)?.version ?? null,
		lastDeployedAt:
			rows
				.map((row) => row.deployedAt)
				.filter((value): value is string => Boolean(value))
				.sort()
				.at(-1) ?? null,
	};
}

export async function listTenantBundleRecoveryPoints(
	db: DbClient,
	slug: string,
): Promise<
	Array<{ version: number; deployedAt: string | null; active: boolean }>
> {
	const tenantBundles = coreTable(db, schemaTenantBundles);
	const rows = await db
		.select({
			version: tenantBundles.version,
			deployedAt: tenantBundles.deployedAt,
			active: tenantBundles.isActive,
		})
		.from(tenantBundles)
		.where(eq(tenantBundles.slug, slug));
	return rows
		.map((row) => ({ ...row, active: Boolean(row.active) }))
		.sort((a, b) => b.version - a.version);
}

/** R2 evidence collected under the caller's restore permit. */
export interface TenantBundleRetentionEvidence {
	compressedVersions: number[];
	referencedVersions: number[];
}

export async function listTenantBundles(
	db: DbQueryClient,
	slug: string,
): Promise<TenantBundle[]> {
	const tenantBundles = coreTable(db, schemaTenantBundles);
	return db
		.select()
		.from(tenantBundles)
		.where(eq(tenantBundles.slug, slug))
		.orderBy(asc(tenantBundles.version));
}

/** No active generation or ambiguous active state means no deletion. */
export async function listPrunableTenantBundles(
	db: DbQueryClient,
	slug: string,
	keep: number,
	evidence: TenantBundleRetentionEvidence,
): Promise<TenantBundle[]> {
	if (!Number.isSafeInteger(keep) || keep < 0)
		throw new Error("Invalid bundle retention count");
	const bundles = await listTenantBundles(db, slug);
	const active = bundles.filter((bundle) => bundle.isActive);
	if (active.length !== 1) return [];
	const older = bundles.filter(
		(bundle) => !bundle.isActive && bundle.version < active[0]!.version,
	);
	const compressed = new Set(evidence.compressedVersions);
	const protectedVersions = new Set([
		...evidence.referencedVersions,
		...(keep === 0
			? []
			: older
					.filter((bundle) => compressed.has(bundle.version))
					.slice(-keep)
					.map((bundle) => bundle.version)),
	]);
	return older.filter((bundle) => !protectedVersions.has(bundle.version));
}

/** Recheck active authority in the delete statement, including rollback races. */
export async function deleteTenantBundleRow(
	db: DbQueryClient,
	slug: string,
	version: number,
): Promise<boolean> {
	const tenantBundles = coreTable(db, schemaTenantBundles);
	const active = alias(tenantBundles, "active");
	const deleted = await db
		.delete(tenantBundles)
		.where(
			and(
				eq(tenantBundles.slug, slug),
				eq(tenantBundles.version, version),
				eq(tenantBundles.isActive, false),
				sql`${tenantBundles.version} < (${db
					.select({ version: sql`min(${active.version})` })
					.from(active)
					.where(and(eq(active.slug, slug), eq(active.isActive, true)))})`,
			),
		)
		.returning({ version: tenantBundles.version });
	return deleted.length === 1;
}
