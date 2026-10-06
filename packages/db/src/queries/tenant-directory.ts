/**
 * Tenant surface-directory signals.
 *
 * The cross-surface directory (apps/api `directory.*`) projects, for each of a
 * caller's organizations, which human-facing Tedix surfaces (OS, MCP, CMS) are
 * provisioned and where they canonically live. Provisioning is stored per
 * surface in different places:
 *
 *   - OS  → org-level `organizations.features.os`
 *   - CMS → per-app `apps.metadata.blogConfig.enabled` (+ optional `cmsDomain`)
 *
 * MCP is intentionally NOT resolved here: the org-wide unified gateway has its
 * own dedicated resolver (`getOrganizationAggregatorGateways`) whose tie-break
 * and `-unified` semantics must not be duplicated. This leaf answers only the
 * two signals above, batched by organization id, returning DB-native values
 * for the API layer to normalize into the directory contract.
 *
 * D1 safety: organization-id fan-out is chunked below the bound-parameter cap,
 * and every select uses distinct output column names so a later batch
 * composition cannot collapse duplicate keys.
 */

import { inArray } from "drizzle-orm";
import type { DbClient } from "../client";
import { apps } from "../schema/apps";
import type { AppMetadata } from "../schema/apps";
import { organizations } from "../schema/organizations";
import { chunkForBoundParams } from "../utils/batch";

/** Maximum organization ids per D1 statement (bound-parameter cap is 100). */
const ORG_ID_CHUNK = 50;

export interface OrganizationSurfaceSignals {
	/** `organizations.features.os === true` — org-level OS provisioning. */
	os: boolean;
	/** Any app in the org has `metadata.blogConfig.enabled === true`. */
	cmsEnabled: boolean;
	/** First enabled app's `blogConfig.cmsDomain` custom domain, if any. */
	cmsDomain: string | null;
}

function emptySignals(): OrganizationSurfaceSignals {
	return {
		os: false,
		cmsEnabled: false,
		cmsDomain: null,
	};
}

/**
 * Resolve OS/CMS provisioning signals for a set of organizations, keyed by
 * organization id. Organizations with no signal rows are simply absent from the
 * map; callers treat a missing entry as fully unprovisioned (fail closed).
 */
export async function getOrganizationSurfaceSignals(
	db: DbClient,
	organizationIds: string[],
): Promise<Map<string, OrganizationSurfaceSignals>> {
	const result = new Map<string, OrganizationSurfaceSignals>();
	if (organizationIds.length === 0) return result;

	const unique = Array.from(new Set(organizationIds));
	const ensure = (organizationId: string): OrganizationSurfaceSignals => {
		let entry = result.get(organizationId);
		if (!entry) {
			entry = emptySignals();
			result.set(organizationId, entry);
		}
		return entry;
	};

	for (const ids of chunkForBoundParams(unique, ORG_ID_CHUNK)) {
		// 1. OS: org-level os feature flag.
		const orgRows = await db
			.select({
				organizationId: organizations.id,
				features: organizations.features,
			})
			.from(organizations)
			.where(inArray(organizations.id, ids));
		for (const row of orgRows) {
			if (row.features?.os === true) {
				ensure(row.organizationId).os = true;
			}
		}

		// 2. CMS: per-app blogConfig.enabled (+ optional custom cmsDomain).
		const appRows = await db
			.select({
				organizationId: apps.organizationId,
				metadata: apps.metadata,
			})
			.from(apps)
			.where(inArray(apps.organizationId, ids));
		for (const row of appRows) {
			if (!row.organizationId) continue;
			const blogConfig = (row.metadata as AppMetadata | null)?.blogConfig;
			if (blogConfig?.enabled !== true) continue;
			const entry = ensure(row.organizationId);
			entry.cmsEnabled = true;
			if (blogConfig.cmsDomain && !entry.cmsDomain) {
				entry.cmsDomain = blogConfig.cmsDomain;
			}
		}
	}

	return result;
}
