import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { skillEntries } from "../../schema/cognitive";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "../../schema/control-plane";
import {
	memoryDomains,
	memoryEdges,
	memoryFacts,
} from "../../schema/memory-graph";
import { tediRationaleRecords } from "../../schema/rationale-records";

/** Export pages use immutable IDs as cursors, never offsets over a changing set. */
export type PortableTediPage = { afterId?: string; limit?: number };

/** Read descriptive control bindings; source UUIDs are never serialized. */
export async function getPortableTediControlBindings(
	db: DbQueryClient,
	ids: {
		runtimeProfileId: string | null;
		policyPackId: string | null;
		workspaceTemplateSetId: string | null;
	},
) {
	const runtimeProfile = ids.runtimeProfileId
		? await db
				.select({
					organizationId: runtimeProfiles.organizationId,
					scope: runtimeProfiles.scope,
					slug: runtimeProfiles.slug,
					version: runtimeProfiles.version,
				})
				.from(runtimeProfiles)
				.where(eq(runtimeProfiles.id, ids.runtimeProfileId))
				.get()
		: null;
	const policyPack = ids.policyPackId
		? await db
				.select({
					organizationId: policyPacks.organizationId,
					scope: policyPacks.scope,
					slug: policyPacks.slug,
					version: policyPacks.version,
				})
				.from(policyPacks)
				.where(eq(policyPacks.id, ids.policyPackId))
				.get()
		: null;
	const workspaceTemplateSet = ids.workspaceTemplateSetId
		? await db
				.select({
					organizationId: workspaceTemplateSets.organizationId,
					scope: workspaceTemplateSets.scope,
					slug: workspaceTemplateSets.slug,
					version: workspaceTemplateSets.version,
				})
				.from(workspaceTemplateSets)
				.where(eq(workspaceTemplateSets.id, ids.workspaceTemplateSetId))
				.get()
		: null;
	return { runtimeProfile, policyPack, workspaceTemplateSet };
}

function pageLimit(limit?: number): number {
	if (limit === undefined) return 100;
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
		throw new RangeError("Portable tedi page limit must be 1–500");
	}
	return limit;
}

/** Export referenced domains and their ancestors, never unrelated org domains. */
export async function listPortableTediDomainsPage(
	db: DbQueryClient,
	organizationId: string,
	tediId: string,
	page: PortableTediPage = {},
) {
	// UNION (rather than UNION ALL) stops a malformed parent cycle. The seed
	// reads only tedi-owned references; each parent must belong to the same org.
	const rows = await db.all(sql`
		WITH RECURSIVE included(id, parent_id) AS (
			SELECT d.id, d.parent_id
			FROM memory_domains d
			WHERE d.organization_id = ${organizationId}
				AND (
					EXISTS (SELECT 1 FROM memory_facts f
						WHERE f.domain_id = d.id
						AND f.organization_id = ${organizationId}
						AND f.tedi_id = ${tediId})
					OR EXISTS (SELECT 1 FROM skill_entries s
						WHERE s.domain_id = d.id
						AND s.organization_id = ${organizationId}
						AND s.tedi_id = ${tediId})
				)
			UNION
			SELECT parent.id, parent.parent_id
			FROM memory_domains parent
			JOIN included child ON parent.id = child.parent_id
			WHERE parent.organization_id = ${organizationId}
		)
		SELECT d.id AS id, d.organization_id AS organizationId,
			d.name AS name, d.parent_id AS parentId,
			d.description AS description, d.created_at AS createdAt
		FROM memory_domains d
		JOIN included ON included.id = d.id
		WHERE d.organization_id = ${organizationId}
		${page.afterId ? sql`AND d.id > ${page.afterId}` : sql``}
		ORDER BY d.id
		LIMIT ${pageLimit(page.limit)}
	`);
	return rows as Array<typeof memoryDomains.$inferSelect>;
}

/** A tedi export never includes organization-wide or another tedi's facts. */
export async function listPortableTediFactsPage(
	db: DbQueryClient,
	organizationId: string,
	tediId: string,
	page: PortableTediPage = {},
) {
	return db
		.select()
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, organizationId),
				eq(memoryFacts.tediId, tediId),
				page.afterId ? gt(memoryFacts.id, page.afterId) : undefined,
			),
		)
		.orderBy(memoryFacts.id)
		.limit(pageLimit(page.limit));
}

/** Both endpoints must be in the exact tedi-owned fact set. */
export async function listPortableTediEdgesPage(
	db: DbQueryClient,
	organizationId: string,
	tediId: string,
	page: PortableTediPage = {},
) {
	const ownedFactIds = db
		.select({ id: memoryFacts.id })
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, organizationId),
				eq(memoryFacts.tediId, tediId),
			),
		);
	return db
		.select()
		.from(memoryEdges)
		.where(
			and(
				// bound-params: SQL subquery with fixed scope parameters, not a caller list.
				inArray(memoryEdges.sourceFactId, ownedFactIds),
				// bound-params: SQL subquery with fixed scope parameters, not a caller list.
				inArray(memoryEdges.targetFactId, ownedFactIds),
				page.afterId ? gt(memoryEdges.id, page.afterId) : undefined,
			),
		)
		.orderBy(memoryEdges.id)
		.limit(pageLimit(page.limit));
}

/** Includes drafts and archived skills: portability preserves history. */
export async function listPortableTediSkillsPage(
	db: DbQueryClient,
	organizationId: string,
	tediId: string,
	page: PortableTediPage = {},
) {
	return db
		.select()
		.from(skillEntries)
		.where(
			and(
				eq(skillEntries.organizationId, organizationId),
				eq(skillEntries.tediId, tediId),
				page.afterId ? gt(skillEntries.id, page.afterId) : undefined,
			),
		)
		.orderBy(skillEntries.id)
		.limit(pageLimit(page.limit));
}

export async function listPortableTediRationalePage(
	db: DbQueryClient,
	organizationId: string,
	tediId: string,
	page: PortableTediPage = {},
) {
	return db
		.select()
		.from(tediRationaleRecords)
		.where(
			and(
				eq(tediRationaleRecords.orgId, organizationId),
				eq(tediRationaleRecords.tediId, tediId),
				page.afterId ? gt(tediRationaleRecords.id, page.afterId) : undefined,
			),
		)
		.orderBy(tediRationaleRecords.id)
		.limit(pageLimit(page.limit));
}
