/**
 * Org graph health — the planning-layer, multi-hop read that makes the org
 * "digital twin" real.
 *
 * Sibling of the work-graph steward's {@link getWorkGraphHealth}: where the
 * steward surfaces COHERENCE defects (dup/stale/naming/orphan), this surfaces
 * the BLOCKED-WORK dependency analysis over the `blocks` graph —
 *   1. rootBlockers — chain-head blockers ranked by transitive downstream impact;
 *   2. blockerTedis — which tedi is holding up the most work;
 *   3. capabilityStall (best-effort) — blocked/stalled work rolled up by
 *      capability value-stream + pace layer.
 *
 * Everything is read-only, org-scoped, deterministic, cycle-safe, and capped for
 * the 10s D1 gateway budget. The transitive-downstream closure is computed with a
 * `WITH RECURSIVE` CTE over `work_item_relations` (Stage 1's whole point — no new
 * graph database). Each section is fail-soft: a capability-join error returns that
 * section empty + a flag rather than failing the whole report.
 *
 * D1 is canonical; this is a read-model, rebuildable from the same rows.
 */

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type CapabilityPaceLayer,
	capabilityLinks,
	orgCapabilities,
} from "../schema/capabilities";
import { tediObjectives } from "../schema/tedi-objectives";
import { type WorkItemDisposition, workItems } from "../schema/work-items";
import { chunkForBoundParams } from "../utils/batch";

/**
 * Terminal statuses — a `blocks` blocker stops gating only at done/cancelled.
 * Deliberately the SAME set as the claim/next blocker gate
 * (`TERMINAL_BLOCKER_STATUSES`, queries/work-items.ts): every other status
 * (including `blocked` and `stale`) still blocks its dependents, so a "live"
 * blocker is any non-terminal item.
 */
const TERMINAL_DISPOSITION_SQL = "'completed', 'cancelled'";

/**
 * Depth bound for the recursive downstream closure. Doubles as the cycle guard:
 * a `blocks` cycle can't run away because the recursion stops at this depth (the
 * final `COUNT(DISTINCT node)` then dedupes the bounded walk). Well past any real
 * blocks chain, mirroring the WORK_ITEM_MAX_PARENT_DEPTH backstop.
 */
const ORG_GRAPH_MAX_DEPTH = 64;

/** Cap on `blocks` edges pulled into the scan; `truncated` flags a cap hit. */
const ORG_GRAPH_EDGE_SCAN_CAP = 2000;

/** Default number of root blockers returned (ranked by downstream impact). */
const ORG_GRAPH_DEFAULT_LIMIT = 20;

/** Hard cap on `limit`. */
const ORG_GRAPH_MAX_LIMIT = 100;

/** IN() chunk size for org-scoped id fetches (D1 100-bound-param cap). */
const ORG_GRAPH_IN_LIST_CHUNK = 50;

/** Cap on capability→objective links scanned for the capability-stall rollup. */
const CAPABILITY_LINK_SCAN_CAP = 1000;

export interface OrgGraphRootBlocker {
	id: string;
	title: string;
	disposition: WorkItemDisposition;
	/** Canonical accountable principal for the root blocker. */
	ownerTediId: string | null;
	/** Distinct non-terminal items transitively reachable along `blocks` edges. */
	downstreamBlockedCount: number;
}

export interface OrgGraphBlockerTedi {
	tediId: string;
	rootBlockerCount: number;
	/** Sum of downstreamBlockedCount over this tedi's root blockers. */
	downstreamImpact: number;
}

export interface OrgGraphCapabilityStall {
	valueStream: string | null;
	paceLayer: CapabilityPaceLayer;
	capabilityId: string;
	/** Accepted work items blocked by a non-terminal dependency. */
	dependencyBlockedCount: number;
}

export interface OrgGraphHealthReport {
	orgId: string;
	generatedAt: string;
	limit: number;
	/** Top `limit` root blockers, downstreamBlockedCount desc → id asc. */
	rootBlockers: OrgGraphRootBlocker[];
	/** Blocker tedis aggregated over ALL roots, downstreamImpact desc. */
	blockerTedis: OrgGraphBlockerTedi[];
	/** Capability-stall rollup (best-effort; empty when links are too sparse). */
	capabilityStall: OrgGraphCapabilityStall[];
	/** False when no capability→objective→work edges were usable in this org. */
	capabilityLinksAvailable: boolean;
	counts: {
		/** Work items not in a terminal disposition. */
		totalNonTerminal: number;
		/** Distinct non-terminal items with ≥1 non-terminal `blocks` blocker (edge-blocked). */
		blockedCount: number;
		/** Total root blockers found (rootBlockers is the top-`limit` slice). */
		rootBlockerCount: number;
		/** `blocks` edges (non-terminal both ends) examined. */
		scannedCount: number;
		/** The edge scan hit the cap — partial view. */
		truncated: boolean;
	};
	/** Best-effort notes (e.g. why capabilityStall is empty). */
	notes: string[];
}

export interface GetOrgGraphHealthParams {
	orgId: string;
	/** Narrow analysis to this canonical project id. */
	projectId?: string;
	/** Root blockers to return (default 20, max 100). */
	limit?: number;
	now?: string;
}

/** Coerce a SQLite COUNT (number | bigint) to a JS number. */
function toNumber(value: unknown): number {
	return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

/**
 * The canonical NON-TERMINAL `blocks` edge set (blocker → dependent), org-scoped.
 *
 * `work_item_relations` records one canonical direction: "X blocks Y" is a
 * `blocks` row from=X (blocker) → to=Y (dependent). Both endpoints must be non-terminal work
 * items in this org (a done/cancelled endpoint breaks the chain — a terminal
 * blocker no longer gates, and a terminal dependent is not blocked work).
 */
function canonEdgeCte(orgId: string, projectId?: string) {
	const projectScope = projectId
		? sql`AND wb.project_id = ${projectId} AND wd.project_id = ${projectId}`
		: sql``;
	return sql`canon_edge(blocker, dependent) AS (
		SELECT r.from_work_item_id, r.to_work_item_id
		FROM work_item_relations r
		JOIN work_items wb ON wb.id = r.from_work_item_id AND wb.org_id = ${orgId}
		JOIN work_items wd ON wd.id = r.to_work_item_id AND wd.org_id = ${orgId}
		WHERE r.org_id = ${orgId} AND r.relation_type = 'blocks'
			AND wb.disposition NOT IN (${sql.raw(TERMINAL_DISPOSITION_SQL)})
			AND wd.disposition NOT IN (${sql.raw(TERMINAL_DISPOSITION_SQL)})
			${projectScope}
	)`;
}

/**
 * Full read-only blocked-work dependency report over the org `work_items` graph.
 * Read-only, org-scoped, capped, deterministic, and cycle-safe.
 */
export async function getOrgGraphHealth(
	db: DbClient,
	params: GetOrgGraphHealthParams,
): Promise<OrgGraphHealthReport> {
	const { orgId } = params;
	const projectId = params.projectId;
	const projectWhere = projectId
		? eq(workItems.projectId, projectId)
		: undefined;
	const now = params.now ?? new Date().toISOString();
	const limit = Math.min(
		Math.max(1, params.limit ?? ORG_GRAPH_DEFAULT_LIMIT),
		ORG_GRAPH_MAX_LIMIT,
	);
	const notes: string[] = [];

	// Total non-terminal population — the denominator for "how much of the board
	// is live".
	const totalNonTerminal = await db.$count(
		workItems,
		and(
			eq(workItems.orgId, orgId),
			projectWhere,
			notInArray(workItems.disposition, ["completed", "cancelled"]),
		),
	);

	// (1) Direct non-terminal `blocks` edges → in-memory root identification.
	// A root blocker is a chain head: a non-terminal blocker with ≥1 non-terminal
	// dependent (it IS a blocker) that never appears as a dependent itself (nothing
	// non-terminal blocks it). Both facts fall out of the canonical edge set.
	const edgeRows = (await db.all(
		sql`WITH ${canonEdgeCte(orgId, projectId)}
			SELECT blocker, dependent FROM canon_edge
			ORDER BY blocker, dependent
			LIMIT ${ORG_GRAPH_EDGE_SCAN_CAP + 1}`,
	)) as Array<{ blocker: string; dependent: string }>;

	const truncated = edgeRows.length > ORG_GRAPH_EDGE_SCAN_CAP;
	const edges = edgeRows.slice(0, ORG_GRAPH_EDGE_SCAN_CAP);

	const blockerIds = new Set<string>();
	const dependentIds = new Set<string>();
	for (const edge of edges) {
		blockerIds.add(edge.blocker);
		dependentIds.add(edge.dependent);
	}
	const rootIds = [...blockerIds].filter((id) => !dependentIds.has(id));

	// (2) Transitive downstream closure via WITH RECURSIVE. For every blocker seed,
	// COUNT(DISTINCT node) of the non-terminal items reachable along `blocks`
	// edges, excluding the seed itself. Cycle-safe: recursion is depth-bounded
	// (ORG_GRAPH_MAX_DEPTH), so a cycle terminates and the DISTINCT dedupes the
	// bounded walk (a diamond counts a shared descendant once). One query, org
	// bound-param only — the recursive walk lives in the DB, not N per-root reads.
	const downstream = new Map<string, number>();
	if (rootIds.length > 0) {
		const reachRows = (await db.all(
			sql`WITH RECURSIVE ${canonEdgeCte(orgId, projectId)},
				reach(seed, node, depth) AS (
					SELECT blocker, dependent, 1 FROM canon_edge
					UNION
					SELECT reach.seed, e.dependent, reach.depth + 1
					FROM reach
					JOIN canon_edge e ON e.blocker = reach.node
					WHERE reach.depth < ${ORG_GRAPH_MAX_DEPTH}
				)
				SELECT seed, COUNT(DISTINCT node) AS downstream
				FROM reach
				WHERE node <> seed
				GROUP BY seed`,
		)) as Array<{ seed: string; downstream: unknown }>;
		for (const row of reachRows) {
			downstream.set(row.seed, toNumber(row.downstream));
		}
	}

	// (3) Hydrate ALL roots (title/status/owner) so blockerTedis aggregates over the
	// full population, then slice rootBlockers to the top `limit`.
	const rootDetail = new Map<
		string,
		{
			title: string;
			disposition: WorkItemDisposition;
			accountableOwnerId: string | null;
		}
	>();
	for (const idChunk of chunkForBoundParams(rootIds, ORG_GRAPH_IN_LIST_CHUNK)) {
		const rows = await db
			.select({
				id: workItems.id,
				title: workItems.title,
				disposition: workItems.disposition,
				accountableOwnerId: workItems.accountableOwnerId,
			})
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, orgId),
					projectWhere,
					inArray(workItems.id, idChunk),
				),
			);
		for (const row of rows) {
			rootDetail.set(row.id, {
				title: row.title,
				disposition: row.disposition,
				accountableOwnerId: row.accountableOwnerId,
			});
		}
	}

	const allRoots: OrgGraphRootBlocker[] = rootIds
		.map((id) => {
			const detail = rootDetail.get(id);
			return {
				id,
				title: detail?.title ?? "",
				disposition: detail?.disposition ?? ("accepted" as WorkItemDisposition),
				ownerTediId: detail?.accountableOwnerId ?? null,
				downstreamBlockedCount: downstream.get(id) ?? 0,
			} satisfies OrgGraphRootBlocker;
		})
		.sort((a, b) => {
			if (a.downstreamBlockedCount !== b.downstreamBlockedCount) {
				return b.downstreamBlockedCount - a.downstreamBlockedCount;
			}
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});

	const rootBlockers = allRoots.slice(0, limit);

	// blockerTedis — "who is holding up the most work". Aggregate over ALL roots
	// (org truth, not just the returned slice); a root with no owner can't be
	// attributed, so it counts toward rootBlockerCount but not toward any tedi.
	const tediAgg = new Map<
		string,
		{ rootBlockerCount: number; downstreamImpact: number }
	>();
	for (const root of allRoots) {
		if (!root.ownerTediId) continue;
		const entry = tediAgg.get(root.ownerTediId) ?? {
			rootBlockerCount: 0,
			downstreamImpact: 0,
		};
		entry.rootBlockerCount += 1;
		entry.downstreamImpact += root.downstreamBlockedCount;
		tediAgg.set(root.ownerTediId, entry);
	}
	const blockerTedis: OrgGraphBlockerTedi[] = [...tediAgg.entries()]
		.map(([tediId, agg]) => ({ tediId, ...agg }))
		.sort((a, b) => {
			if (a.downstreamImpact !== b.downstreamImpact) {
				return b.downstreamImpact - a.downstreamImpact;
			}
			if (a.rootBlockerCount !== b.rootBlockerCount) {
				return b.rootBlockerCount - a.rootBlockerCount;
			}
			return a.tediId < b.tediId ? -1 : a.tediId > b.tediId ? 1 : 0;
		});

	// (4) Capability-stall rollup — BEST-EFFORT, fully fail-soft. A join error (or
	// an org with no capability→objective edges) returns this section empty + a
	// flag; it never fails the whole report.
	let capabilityStall: OrgGraphCapabilityStall[] = [];
	let capabilityLinksAvailable = false;
	try {
		const result = await computeCapabilityStall(db, orgId, projectId);
		capabilityStall = result.rows;
		capabilityLinksAvailable = result.available;
		if (result.note) notes.push(result.note);
	} catch (error) {
		capabilityStall = [];
		capabilityLinksAvailable = false;
		notes.push(
			`capabilityStall skipped: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	return {
		orgId,
		generatedAt: now,
		limit,
		rootBlockers,
		blockerTedis,
		capabilityStall,
		capabilityLinksAvailable,
		counts: {
			totalNonTerminal,
			blockedCount: dependentIds.size,
			rootBlockerCount: rootIds.length,
			scannedCount: edges.length,
			truncated,
		},
		notes,
	};
}

/**
 * Capability → objective → work stall rollup. Joins `capability_links`
 * (entityKind='objective') → the linked objectives → their `work_items`, and
 * rolls the currently `blocked` / `stale` work up per capability value-stream +
 * pace layer. Returns `available:false` + a note when the edges are too sparse to
 * analyze (no objective links, or none of the linked objectives has work).
 */
async function computeCapabilityStall(
	db: DbClient,
	orgId: string,
	projectId?: string,
): Promise<{
	rows: OrgGraphCapabilityStall[];
	available: boolean;
	note?: string;
}> {
	// capability → objective links for this org.
	const linkRows = await db
		.select({
			capabilityId: capabilityLinks.capabilityId,
			objectiveId: capabilityLinks.entityId,
		})
		.from(capabilityLinks)
		.where(
			and(
				eq(capabilityLinks.organizationId, orgId),
				eq(capabilityLinks.entityKind, "objective"),
			),
		)
		.limit(CAPABILITY_LINK_SCAN_CAP);

	if (linkRows.length === 0) {
		return {
			rows: [],
			available: false,
			note: "capabilityStall: no capability→objective links in this org.",
		};
	}

	// objectiveId → the capabilities it realizes (an objective may map to several).
	const capsByObjective = new Map<string, Set<string>>();
	for (const link of linkRows) {
		const set = capsByObjective.get(link.objectiveId) ?? new Set<string>();
		set.add(link.capabilityId);
		capsByObjective.set(link.objectiveId, set);
	}
	const objectiveIds = [...capsByObjective.keys()];

	// Verify the objectives belong to this org (capability_links.entityId carries no
	// FK — it is polymorphic), then tally blocked/stale work per objective.
	const validObjectiveIds = new Set<string>();
	for (const idChunk of chunkForBoundParams(
		objectiveIds,
		ORG_GRAPH_IN_LIST_CHUNK,
	)) {
		const rows = await db
			.select({ id: tediObjectives.id })
			.from(tediObjectives)
			.where(
				and(
					eq(tediObjectives.orgId, orgId),
					inArray(tediObjectives.id, idChunk),
				),
			);
		for (const row of rows) validObjectiveIds.add(row.id);
	}

	const objectiveStall = new Map<string, number>();
	let anyWork = false;
	const validIds = objectiveIds.filter((id) => validObjectiveIds.has(id));
	for (const idChunk of chunkForBoundParams(
		validIds,
		ORG_GRAPH_IN_LIST_CHUNK,
	)) {
		const projectScope = projectId
			? sql`AND dependent.project_id = ${projectId}`
			: sql``;
		const rows =
			(await db.all(sql`SELECT dependent.objective_id AS objectiveId, count(DISTINCT dependent.id) AS blockedCount
			FROM work_item_relations relation
			JOIN work_items dependent ON dependent.id = relation.to_work_item_id AND dependent.org_id = ${orgId}
			JOIN work_items blocker ON blocker.id = relation.from_work_item_id AND blocker.org_id = ${orgId}
			WHERE relation.org_id = ${orgId} AND relation.relation_type = 'blocks'
				AND dependent.objective_id IN (${sql.join(
					idChunk.map((id) => sql`${id}`),
					sql`, `,
				)})
				AND dependent.disposition = 'accepted' AND blocker.disposition NOT IN ('completed','cancelled') ${projectScope}
			GROUP BY dependent.objective_id`)) as Array<{
				objectiveId: string;
				blockedCount: number;
			}>;
		for (const row of rows) {
			if (!row.objectiveId) continue;
			anyWork = true;
			objectiveStall.set(row.objectiveId, toNumber(row.blockedCount));
		}
	}

	if (!anyWork) {
		return {
			rows: [],
			available: false,
			note: "capabilityStall: capability→objective links exist but none of the linked objectives has dependency-blocked work.",
		};
	}

	// Roll the per-objective stall up to each capability it realizes.
	const capStall = new Map<string, number>();
	for (const [objectiveId, blockedCount] of objectiveStall) {
		const caps = capsByObjective.get(objectiveId);
		if (!caps) continue;
		for (const capabilityId of caps) {
			capStall.set(
				capabilityId,
				(capStall.get(capabilityId) ?? 0) + blockedCount,
			);
		}
	}

	// Hydrate capability value-stream + pace layer for the stalled capabilities.
	const capabilityIds = [...capStall.keys()];
	const capMeta = new Map<
		string,
		{ valueStream: string | null; paceLayer: CapabilityPaceLayer }
	>();
	for (const idChunk of chunkForBoundParams(
		capabilityIds,
		ORG_GRAPH_IN_LIST_CHUNK,
	)) {
		const rows = await db
			.select({
				id: orgCapabilities.id,
				valueStream: orgCapabilities.valueStream,
				paceLayer: orgCapabilities.paceLayer,
			})
			.from(orgCapabilities)
			.where(
				and(
					eq(orgCapabilities.organizationId, orgId),
					inArray(orgCapabilities.id, idChunk),
				),
			);
		for (const row of rows) {
			capMeta.set(row.id, {
				valueStream: row.valueStream,
				paceLayer: row.paceLayer,
			});
		}
	}

	const rows: OrgGraphCapabilityStall[] = capabilityIds
		.map((capabilityId) => {
			const blockedCount = capStall.get(capabilityId) ?? 0;
			const meta = capMeta.get(capabilityId);
			return {
				valueStream: meta?.valueStream ?? null,
				paceLayer: meta?.paceLayer ?? ("record" as CapabilityPaceLayer),
				capabilityId,
				dependencyBlockedCount: blockedCount,
			} satisfies OrgGraphCapabilityStall;
		})
		.filter((row) => row.dependencyBlockedCount > 0)
		.sort((a, b) => {
			const aTotal = a.dependencyBlockedCount;
			const bTotal = b.dependencyBlockedCount;
			if (aTotal !== bTotal) return bTotal - aTotal;
			return a.capabilityId < b.capabilityId
				? -1
				: a.capabilityId > b.capabilityId
					? 1
					: 0;
		});

	return { rows, available: true };
}
