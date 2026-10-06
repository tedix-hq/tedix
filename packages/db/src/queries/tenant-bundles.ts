/**
 * Tenant Bundle Queries
 *
 * Read-side helpers for the `tenant_bundles` table — used by `apps/cms-runtime`
 * to find which Astro+Emdash bundle to load into a per-tenant Worker Loader
 * isolate. Write paths live in `packages/provisioning/src/cms.ts`.
 */

import { and, eq } from "drizzle-orm";
import type { DbClient } from "../client";
import { type TenantBundle, tenantBundles } from "../schema/tenant-bundles";

/**
 * Get the active bundle for a CMS app slug. Returns null when no bundle is
 * currently flagged `is_active = 1` (meaning the app is provisioned but no
 * deploy has landed yet, or all versions have been deactivated).
 */
export async function getActiveTenantBundle(
	db: DbClient,
	slug: string,
): Promise<TenantBundle | null> {
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
