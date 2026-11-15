/**
 * Tenant surface-directory signals.
 *
 * The cross-surface directory (apps/api `directory.*`) projects, for each of a
 * caller's organizations, which human-facing Tedix surfaces are provisioned and
 * where they canonically live. This leaf answers the org-level OS signal
 * (`organizations.features.os`), batched by organization id.
 *
 * MCP is intentionally NOT resolved here: the org-wide unified gateway has its
 * own dedicated resolver (`getOrganizationAggregatorGateways`) whose tie-break
 * and `-unified` semantics must not be duplicated. CMS sites are listed per site
 * by `sites.list`; an organization can have several, so the directory has no
 * single CMS entry.
 *
 * D1 safety: organization-id fan-out is chunked below the bound-parameter cap,
 * and every select uses distinct output column names so a later batch
 * composition cannot collapse duplicate keys.
 */

import { inArray } from "drizzle-orm";
import type { DbClient } from "../client";
import { organizations } from "../schema/organizations";
import { chunkForBoundParams } from "../utils/batch";

/** Maximum organization ids per D1 statement (bound-parameter cap is 100). */
const ORG_ID_CHUNK = 50;

export interface OrganizationSurfaceSignals {
	/** `organizations.features.os === true` — org-level OS provisioning. */
	os: boolean;
}

/**
 * Resolve OS provisioning signals for a set of organizations, keyed by
 * organization id. Organizations without the signal are absent from the map;
 * callers treat a missing entry as unprovisioned (fail closed).
 */
export async function getOrganizationSurfaceSignals(
	db: DbClient,
	organizationIds: string[],
): Promise<Map<string, OrganizationSurfaceSignals>> {
	const result = new Map<string, OrganizationSurfaceSignals>();
	const unique = Array.from(new Set(organizationIds));
	for (const ids of chunkForBoundParams(unique, ORG_ID_CHUNK)) {
		const orgRows = await db
			.select({
				organizationId: organizations.id,
				features: organizations.features,
			})
			.from(organizations)
			.where(inArray(organizations.id, ids));
		for (const row of orgRows) {
			if (row.features?.os === true) {
				result.set(row.organizationId, { os: true });
			}
		}
	}
	return result;
}
