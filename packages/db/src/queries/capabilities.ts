/**
 * Business Capability Map Query Helpers
 *
 * CRUD + tree + coverage + unmapped-entity reports for org_capabilities and
 * capability_links (flywheel remodel P5 #2 — the LeanIX/Porter capability
 * map). Used by the capabilities router and the Tedix OS heatmap.
 *
 * Invariants enforced here (not in the router):
 * - Tree depth ≤ MAX_CAPABILITY_DEPTH (3), including subtree height on moves.
 * - No cycles (a capability can never be parented under its own subtree).
 * - Parents must exist, be active, and belong to the same org.
 * - Link/unlink are idempotent (uniq_capability_links_target).
 * - Link targets must exist and belong to the capability's org
 *   (CapabilityLinkEntityError; `skipEntityValidation` for trusted bulk seeds).
 */

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { apps } from "../schema/apps";
import {
	type CapabilityLink,
	type CapabilityLinkKind,
	type CapabilityPaceLayer,
	type CapabilityStatus,
	capabilityLinks,
	MAX_CAPABILITY_DEPTH,
	type OrgCapability,
	orgCapabilities,
} from "../schema/capabilities";
import { skillEntries } from "../schema/cognitive";
import { externalAgentPrincipals } from "../schema/external-agent-identity";
import { tediObjectives } from "../schema/tedi-objectives";
import { tedis } from "../schema/tedis";
import { chunkForBoundParams } from "../utils/batch";

// ============================================================================
// Errors — typed so the router can map them to BAD_REQUEST deterministically
// ============================================================================

/** Tree-depth ceiling or subtree-height violation. */
export class CapabilityDepthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CapabilityDepthError";
	}
}

/** Missing, cross-org, archived, or cyclic parent reference. */
export class CapabilityParentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CapabilityParentError";
	}
}

/** Link target that does not exist or belongs to a different org. */
export class CapabilityLinkEntityError extends Error {
	readonly reason: "not_found" | "wrong_org";
	constructor(reason: "not_found" | "wrong_org", message: string) {
		super(message);
		this.name = "CapabilityLinkEntityError";
		this.reason = reason;
	}
}

// ============================================================================
// Types
// ============================================================================

export interface CreateCapabilityParams {
	id: string;
	organizationId: string;
	parentId?: string | null;
	name: string;
	slug: string;
	description?: string;
	valueStream?: string;
	paceLayer: CapabilityPaceLayer;
	maturityScore?: number | null;
	createdAt: string;
}

export interface UpdateCapabilityParams {
	name?: string;
	slug?: string;
	description?: string | null;
	valueStream?: string | null;
	paceLayer?: CapabilityPaceLayer;
	maturityScore?: number | null;
	/** string = re-parent, null = move to root, undefined = unchanged */
	parentId?: string | null;
	updatedAt: string;
}

export interface ListCapabilitiesOptions {
	organizationId: string;
	status?: CapabilityStatus;
	paceLayer?: CapabilityPaceLayer;
	parentId?: string | null;
	limit?: number;
	offset?: number;
}

export interface CapabilityTreeNode extends OrgCapability {
	children: CapabilityTreeNode[];
}

export interface CapabilityCoverageEntry {
	capabilityId: string;
	name: string;
	slug: string;
	parentId: string | null;
	depth: number;
	paceLayer: CapabilityPaceLayer;
	valueStream: string | null;
	maturityScore: number | null;
	linkedSkillCount: number;
	/** lifecycleState → count for linked skills (maturity mix) */
	skillLifecycleMix: Record<string, number>;
	/** paceLayer → count for linked skills */
	skillPaceLayerMix: Record<string, number>;
	linkedTediCount: number;
	linkedObjectiveCount: number;
	linkedAppCount: number;
}

export interface CapabilityCoverageReport {
	capabilities: CapabilityCoverageEntry[];
	totals: {
		capabilityCount: number;
		mappedSkillCount: number;
		mappedTediCount: number;
		mappedObjectiveCount: number;
		mappedAppCount: number;
	};
}

export interface UnmappedSkillEntry {
	id: string;
	title: string;
	slug: string | null;
	lifecycleState: string | null;
	paceLayer: string | null;
	appId: string | null;
}

export interface UnmappedObjectiveEntry {
	id: string;
	tediId: string;
	title: string;
	type: string;
	status: string;
}

export interface UnmappedEntityReport {
	skills: UnmappedSkillEntry[];
	objectives: UnmappedObjectiveEntry[];
	totals: {
		unmappedSkillCount: number;
		unmappedObjectiveCount: number;
		skillTotal: number;
		objectiveTotal: number;
	};
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Depth of a capability (root = 1) by walking the parent chain. Bounded to
 * MAX_CAPABILITY_DEPTH + 1 hops — anything deeper is already corrupt and is
 * reported as a depth violation rather than looping.
 */
async function capabilityDepth(
	db: DbClient,
	capability: OrgCapability,
): Promise<number> {
	let depth = 1;
	let current = capability;
	while (current.parentId) {
		depth += 1;
		if (depth > MAX_CAPABILITY_DEPTH) return depth;
		const rows = await db
			.select()
			.from(orgCapabilities)
			.where(eq(orgCapabilities.id, current.parentId));
		const parent = rows[0];
		if (!parent) break;
		current = parent;
	}
	return depth;
}

/** IDs of the full subtree rooted at `rootId` (including the root), BFS bounded by max depth. */
async function subtreeIds(db: DbClient, rootId: string): Promise<string[]> {
	const collected = [rootId];
	let frontier = [rootId];
	for (let level = 1; level < MAX_CAPABILITY_DEPTH + 1; level++) {
		const children: OrgCapability[] = [];
		for (const parentId of frontier) {
			const rows = await db
				.select()
				.from(orgCapabilities)
				.where(eq(orgCapabilities.parentId, parentId));
			children.push(...rows);
		}
		if (children.length === 0) break;
		frontier = children.map((child) => child.id);
		collected.push(...frontier);
	}
	return collected;
}

/** Height of the subtree rooted at `rootId` (leaf = 1). */
async function subtreeHeight(db: DbClient, rootId: string): Promise<number> {
	let height = 1;
	let frontier = [rootId];
	for (let level = 1; level < MAX_CAPABILITY_DEPTH + 1; level++) {
		const children: OrgCapability[] = [];
		for (const parentId of frontier) {
			const rows = await db
				.select()
				.from(orgCapabilities)
				.where(eq(orgCapabilities.parentId, parentId));
			children.push(...rows);
		}
		if (children.length === 0) break;
		height += 1;
		frontier = children.map((child) => child.id);
	}
	return height;
}

async function assertValidParent(
	db: DbClient,
	organizationId: string,
	parentId: string,
): Promise<OrgCapability> {
	const rows = await db
		.select()
		.from(orgCapabilities)
		.where(eq(orgCapabilities.id, parentId));
	const parent = rows[0];
	if (!parent) {
		throw new CapabilityParentError(`Parent capability ${parentId} not found`);
	}
	if (parent.organizationId !== organizationId) {
		throw new CapabilityParentError(
			"Parent capability belongs to a different organization",
		);
	}
	if (parent.status !== "active") {
		throw new CapabilityParentError("Parent capability is archived");
	}
	return parent;
}

/** D1 parameter-count safety for IN() lists (100-bound-param cap). */
const CAPABILITY_IN_LIST_CHUNK = 80;

// ============================================================================
// Capabilities — Read
// ============================================================================

export async function getCapabilityById(
	db: DbClient,
	id: string,
): Promise<OrgCapability | undefined> {
	const rows = await db
		.select()
		.from(orgCapabilities)
		.where(eq(orgCapabilities.id, id));
	return rows[0];
}

export async function getCapabilityByIdForOrganization(
	db: DbClient,
	organizationId: string,
	id: string,
): Promise<OrgCapability | undefined> {
	const rows = await db
		.select()
		.from(orgCapabilities)
		.where(
			and(
				eq(orgCapabilities.organizationId, organizationId),
				eq(orgCapabilities.id, id),
			),
		)
		.limit(1);
	return rows[0];
}

export async function getCapabilityBySlug(
	db: DbClient,
	organizationId: string,
	slug: string,
): Promise<OrgCapability | undefined> {
	const rows = await db
		.select()
		.from(orgCapabilities)
		.where(
			and(
				eq(orgCapabilities.organizationId, organizationId),
				eq(orgCapabilities.slug, slug),
			),
		);
	return rows[0];
}

export async function listCapabilities(
	db: DbClient,
	options: ListCapabilitiesOptions,
): Promise<{ data: OrgCapability[]; total: number }> {
	const { limit = 50, offset = 0 } = options;

	const conditions = [
		eq(orgCapabilities.organizationId, options.organizationId),
	];
	if (options.status) {
		conditions.push(eq(orgCapabilities.status, options.status));
	}
	if (options.paceLayer) {
		conditions.push(eq(orgCapabilities.paceLayer, options.paceLayer));
	}
	if (options.parentId !== undefined) {
		conditions.push(
			options.parentId === null
				? isNull(orgCapabilities.parentId)
				: eq(orgCapabilities.parentId, options.parentId),
		);
	}

	const whereClause = and(...conditions);
	const data = await db
		.select()
		.from(orgCapabilities)
		.where(whereClause)
		.orderBy(asc(orgCapabilities.name))
		.limit(limit)
		.offset(offset);
	const total = await db.$count(orgCapabilities, whereClause);

	return { data, total };
}

/**
 * Org-scoped capability tree (active nodes by default). Depth is bounded by
 * the write-side invariant, so assembly is a simple in-memory pass.
 */
export async function getCapabilityTree(
	db: DbClient,
	organizationId: string,
	options?: { includeArchived?: boolean },
): Promise<CapabilityTreeNode[]> {
	const conditions = [eq(orgCapabilities.organizationId, organizationId)];
	if (!options?.includeArchived) {
		conditions.push(eq(orgCapabilities.status, "active"));
	}
	const rows = await db
		.select()
		.from(orgCapabilities)
		.where(and(...conditions))
		.orderBy(asc(orgCapabilities.name));

	const nodes = new Map<string, CapabilityTreeNode>();
	for (const row of rows) {
		nodes.set(row.id, { ...row, children: [] });
	}
	const roots: CapabilityTreeNode[] = [];
	for (const node of nodes.values()) {
		const parent = node.parentId ? nodes.get(node.parentId) : undefined;
		if (parent) parent.children.push(node);
		else roots.push(node);
	}
	return roots;
}

// ============================================================================
// Capabilities — Write
// ============================================================================

export async function createCapability(
	db: DbClient,
	params: CreateCapabilityParams,
): Promise<OrgCapability> {
	if (params.parentId) {
		const parent = await assertValidParent(
			db,
			params.organizationId,
			params.parentId,
		);
		const parentDepth = await capabilityDepth(db, parent);
		if (parentDepth + 1 > MAX_CAPABILITY_DEPTH) {
			throw new CapabilityDepthError(
				`Capability tree depth is capped at ${MAX_CAPABILITY_DEPTH}; parent "${parent.slug}" is already at depth ${parentDepth}`,
			);
		}
	}

	const rows = await db
		.insert(orgCapabilities)
		.values({
			id: params.id,
			organizationId: params.organizationId,
			parentId: params.parentId ?? null,
			name: params.name,
			slug: params.slug,
			description: params.description ?? null,
			valueStream: params.valueStream ?? null,
			paceLayer: params.paceLayer,
			maturityScore: params.maturityScore ?? null,
			status: "active",
			createdAt: params.createdAt,
		})
		.returning();
	return rows[0]!;
}

export async function updateCapability(
	db: DbClient,
	id: string,
	params: UpdateCapabilityParams,
): Promise<OrgCapability | undefined> {
	const existing = await getCapabilityById(db, id);
	if (!existing) return undefined;

	if (params.parentId !== undefined && params.parentId !== existing.parentId) {
		if (params.parentId !== null) {
			if (params.parentId === id) {
				throw new CapabilityParentError(
					"A capability cannot be its own parent",
				);
			}
			const parent = await assertValidParent(
				db,
				existing.organizationId,
				params.parentId,
			);
			// Cycle guard: the new parent must not live inside this subtree.
			const descendants = await subtreeIds(db, id);
			if (descendants.includes(params.parentId)) {
				throw new CapabilityParentError(
					"Cannot move a capability under its own descendant",
				);
			}
			// Depth guard including the moved subtree's height.
			const parentDepth = await capabilityDepth(db, parent);
			const height = await subtreeHeight(db, id);
			if (parentDepth + height > MAX_CAPABILITY_DEPTH) {
				throw new CapabilityDepthError(
					`Move rejected: depth ${parentDepth + height} would exceed the ${MAX_CAPABILITY_DEPTH}-level ceiling (parent depth ${parentDepth} + subtree height ${height})`,
				);
			}
		}
	}

	const set: Record<string, unknown> = { updatedAt: params.updatedAt };
	if (params.name !== undefined) set.name = params.name;
	if (params.slug !== undefined) set.slug = params.slug;
	if (params.description !== undefined) set.description = params.description;
	if (params.valueStream !== undefined) set.valueStream = params.valueStream;
	if (params.paceLayer !== undefined) set.paceLayer = params.paceLayer;
	if (params.maturityScore !== undefined) {
		set.maturityScore = params.maturityScore;
	}
	if (params.parentId !== undefined) set.parentId = params.parentId;

	const rows = await db
		.update(orgCapabilities)
		.set(set)
		.where(eq(orgCapabilities.id, id))
		.returning();
	return rows[0];
}

/**
 * Soft-archive a capability AND its subtree (audit-preserving — rows and
 * links stay queryable; tree/coverage default to active nodes only).
 * Returns every row transitioned by this call.
 */
export async function archiveCapabilitySubtree(
	db: DbClient,
	id: string,
	archivedAt: string,
): Promise<OrgCapability[]> {
	const ids = await subtreeIds(db, id);
	const archived: OrgCapability[] = [];
	for (const capabilityId of ids) {
		const rows = await db
			.update(orgCapabilities)
			.set({ status: "archived", archivedAt, updatedAt: archivedAt })
			.where(
				and(
					eq(orgCapabilities.id, capabilityId),
					eq(orgCapabilities.status, "active"),
				),
			)
			.returning();
		archived.push(...rows);
	}
	return archived;
}

// ============================================================================
// Links — Write (idempotent)
// ============================================================================

export interface LinkCapabilityParams {
	id: string;
	capabilityId: string;
	organizationId: string;
	entityKind: CapabilityLinkKind;
	entityId: string;
	createdAt: string;
	/**
	 * Escape hatch for trusted bulk seeding where every target was already
	 * verified in batch. Default path validates the target exists in this org.
	 */
	skipEntityValidation?: true;
}

/**
 * Idempotent link: re-linking an already linked (capability, kind, entity)
 * triple returns the existing row with `created: false`.
 *
 * Validates the link target (existence + same org) HERE, not only in the
 * router — a dangling capability_links row silently corrupts coverage and
 * unmapped reports for every caller, so the invariant lives with the write.
 * Throws {@link CapabilityLinkEntityError}; pass `skipEntityValidation: true`
 * only for trusted bulk seeding.
 */
export async function linkCapability(
	db: DbClient,
	params: LinkCapabilityParams,
): Promise<{ link: CapabilityLink; created: boolean }> {
	if (!params.skipEntityValidation) {
		const resolution = await resolveLinkEntity(
			db,
			params.organizationId,
			params.entityKind,
			params.entityId,
		);
		if (!resolution.ok) {
			throw new CapabilityLinkEntityError(
				resolution.reason,
				resolution.reason === "not_found"
					? `${params.entityKind} ${params.entityId} not found`
					: `${params.entityKind} ${params.entityId} belongs to a different organization`,
			);
		}
	}
	const inserted = await db
		.insert(capabilityLinks)
		.values({
			id: params.id,
			capabilityId: params.capabilityId,
			organizationId: params.organizationId,
			entityKind: params.entityKind,
			entityId: params.entityId,
			createdAt: params.createdAt,
		})
		.onConflictDoNothing({
			target: [
				capabilityLinks.capabilityId,
				capabilityLinks.entityKind,
				capabilityLinks.entityId,
			],
		})
		.returning();
	if (inserted.length > 0) return { link: inserted[0]!, created: true };

	const existing = await db
		.select()
		.from(capabilityLinks)
		.where(
			and(
				eq(capabilityLinks.capabilityId, params.capabilityId),
				eq(capabilityLinks.entityKind, params.entityKind),
				eq(capabilityLinks.entityId, params.entityId),
			),
		);
	return { link: existing[0]!, created: false };
}

/** Idempotent unlink: returns false when the link did not exist. */
export async function unlinkCapability(
	db: DbClient,
	params: {
		capabilityId: string;
		entityKind: CapabilityLinkKind;
		entityId: string;
	},
): Promise<boolean> {
	const rows = await db
		.delete(capabilityLinks)
		.where(
			and(
				eq(capabilityLinks.capabilityId, params.capabilityId),
				eq(capabilityLinks.entityKind, params.entityKind),
				eq(capabilityLinks.entityId, params.entityId),
			),
		)
		.returning();
	return rows.length > 0;
}

export type LinkEntityResolution =
	| { ok: true }
	| { ok: false; reason: "not_found" | "wrong_org" };

/**
 * Kind-specific existence + org check for a link target. Every kind (skill,
 * app, tedi, objective) must exist and belong to the capability's org.
 */
export async function resolveLinkEntity(
	db: DbClient,
	organizationId: string,
	entityKind: CapabilityLinkKind,
	entityId: string,
): Promise<LinkEntityResolution> {
	switch (entityKind) {
		case "external_agent": {
			const rows = await db
				.select({
					organizationId: externalAgentPrincipals.organizationId,
					status: externalAgentPrincipals.status,
				})
				.from(externalAgentPrincipals)
				.where(eq(externalAgentPrincipals.id, entityId));
			if (!rows[0] || rows[0].status !== "active")
				return { ok: false, reason: "not_found" };
			if (rows[0].organizationId !== organizationId)
				return { ok: false, reason: "wrong_org" };
			return { ok: true };
		}
		case "skill": {
			const rows = await db
				.select({ organizationId: skillEntries.organizationId })
				.from(skillEntries)
				.where(eq(skillEntries.id, entityId));
			if (!rows[0]) return { ok: false, reason: "not_found" };
			if (rows[0].organizationId !== organizationId)
				return { ok: false, reason: "wrong_org" };
			return { ok: true };
		}
		case "tedi": {
			const rows = await db
				.select({ organizationId: tedis.organizationId })
				.from(tedis)
				.where(eq(tedis.id, entityId));
			if (!rows[0]) return { ok: false, reason: "not_found" };
			if (rows[0].organizationId !== organizationId)
				return { ok: false, reason: "wrong_org" };
			return { ok: true };
		}
		case "objective": {
			const rows = await db
				.select({ orgId: tediObjectives.orgId })
				.from(tediObjectives)
				.where(eq(tediObjectives.id, entityId));
			if (!rows[0]) return { ok: false, reason: "not_found" };
			if (rows[0].orgId !== organizationId)
				return { ok: false, reason: "wrong_org" };
			return { ok: true };
		}
		case "app": {
			const rows = await db
				.select({ organizationId: apps.organizationId })
				.from(apps)
				.where(eq(apps.id, entityId));
			if (!rows[0]) return { ok: false, reason: "not_found" };
			if (rows[0].organizationId !== organizationId)
				return { ok: false, reason: "wrong_org" };
			return { ok: true };
		}
	}
}

// ============================================================================
// Coverage report
// ============================================================================

/**
 * Per-capability coverage: linked skill count + skill maturity mix
 * (lifecycle + pace-layer distributions of linked skills), linked tedis,
 * objectives, and apps. Active capabilities only.
 */
export async function getCapabilityCoverage(
	db: DbClient,
	organizationId: string,
): Promise<CapabilityCoverageReport> {
	const capabilities = await db
		.select()
		.from(orgCapabilities)
		.where(
			and(
				eq(orgCapabilities.organizationId, organizationId),
				eq(orgCapabilities.status, "active"),
			),
		)
		.orderBy(asc(orgCapabilities.name));

	const links = await db
		.select()
		.from(capabilityLinks)
		.where(eq(capabilityLinks.organizationId, organizationId));

	// Depth per capability from the in-memory parent chain.
	const byId = new Map(capabilities.map((cap) => [cap.id, cap]));
	const depthOf = (capId: string): number => {
		let depth = 1;
		let current = byId.get(capId);
		while (current?.parentId && depth <= MAX_CAPABILITY_DEPTH) {
			current = byId.get(current.parentId);
			if (current) depth += 1;
			else break;
		}
		return depth;
	};

	// Lifecycle/pace mix for every linked skill in one batched read.
	const skillIds = [
		...new Set(
			links
				.filter((link) => link.entityKind === "skill")
				.map((link) => link.entityId),
		),
	];
	const skillMeta = new Map<
		string,
		{ lifecycleState: string | null; paceLayer: string | null }
	>();
	for (const ids of chunkForBoundParams(skillIds, CAPABILITY_IN_LIST_CHUNK)) {
		const rows = await db
			.select({
				id: skillEntries.id,
				lifecycleState: skillEntries.lifecycleState,
				paceLayer: skillEntries.paceLayer,
			})
			.from(skillEntries)
			.where(inArray(skillEntries.id, ids));
		for (const row of rows) {
			skillMeta.set(row.id, {
				lifecycleState: row.lifecycleState,
				paceLayer: row.paceLayer,
			});
		}
	}

	const linksByCapability = new Map<string, CapabilityLink[]>();
	for (const link of links) {
		const bucket = linksByCapability.get(link.capabilityId) ?? [];
		bucket.push(link);
		linksByCapability.set(link.capabilityId, bucket);
	}

	const entries: CapabilityCoverageEntry[] = capabilities.map((cap) => {
		const capLinks = linksByCapability.get(cap.id) ?? [];
		const skillLinks = capLinks.filter((link) => link.entityKind === "skill");
		const skillLifecycleMix: Record<string, number> = {};
		const skillPaceLayerMix: Record<string, number> = {};
		for (const link of skillLinks) {
			const meta = skillMeta.get(link.entityId);
			const lifecycle = meta?.lifecycleState ?? "unknown";
			const pace = meta?.paceLayer ?? "unknown";
			skillLifecycleMix[lifecycle] = (skillLifecycleMix[lifecycle] ?? 0) + 1;
			skillPaceLayerMix[pace] = (skillPaceLayerMix[pace] ?? 0) + 1;
		}
		return {
			capabilityId: cap.id,
			name: cap.name,
			slug: cap.slug,
			parentId: cap.parentId,
			depth: depthOf(cap.id),
			paceLayer: cap.paceLayer,
			valueStream: cap.valueStream,
			maturityScore: cap.maturityScore,
			linkedSkillCount: skillLinks.length,
			skillLifecycleMix,
			skillPaceLayerMix,
			linkedTediCount: capLinks.filter((link) => link.entityKind === "tedi")
				.length,
			linkedObjectiveCount: capLinks.filter(
				(link) => link.entityKind === "objective",
			).length,
			linkedAppCount: capLinks.filter((link) => link.entityKind === "app")
				.length,
		};
	});

	const activeCapabilityIds = new Set(capabilities.map((cap) => cap.id));
	const distinctMapped = (kind: CapabilityLinkKind): number =>
		new Set(
			links
				.filter(
					(link) =>
						link.entityKind === kind &&
						activeCapabilityIds.has(link.capabilityId),
				)
				.map((link) => link.entityId),
		).size;

	return {
		capabilities: entries,
		totals: {
			capabilityCount: capabilities.length,
			mappedSkillCount: distinctMapped("skill"),
			mappedTediCount: distinctMapped("tedi"),
			mappedObjectiveCount: distinctMapped("objective"),
			mappedAppCount: distinctMapped("app"),
		},
	};
}

// ============================================================================
// Unmapped-entity report (the relevance-filter gap list)
// ============================================================================

/**
 * Skills and objectives with NO capability link — the Wilmes relevance-filter
 * gap: entities the pattern-mining loops cannot situate against what the
 * business does.
 *
 * Skills: org rows excluding archived lifecycle; app-scoped rows (appId set)
 * are excluded by default because they are MCP progressive-disclosure docs,
 * not org routines (see the WS6 portfolio population audit note).
 * Objectives: active only.
 */
export async function getUnmappedEntities(
	db: DbClient,
	organizationId: string,
	options?: { includeAppScopedSkills?: boolean; limit?: number },
): Promise<UnmappedEntityReport> {
	const limit = options?.limit ?? 100;

	const skillConditions = [
		eq(skillEntries.organizationId, organizationId),
		isNull(capabilityLinks.id),
	];
	// NULL lifecycle counts as draft, not archived: `lifecycle_state <>
	// 'archived'` alone is NULL (not true) for NULL rows and silently drops
	// them from the gap list.
	const notArchived = sql`coalesce(${skillEntries.lifecycleState}, 'draft') <> 'archived'`;
	skillConditions.push(notArchived);
	if (!options?.includeAppScopedSkills) {
		skillConditions.push(isNull(skillEntries.appId));
	}

	const unmappedSkills = await db
		.select({
			id: skillEntries.id,
			title: skillEntries.title,
			slug: skillEntries.slug,
			lifecycleState: skillEntries.lifecycleState,
			paceLayer: skillEntries.paceLayer,
			appId: skillEntries.appId,
		})
		.from(skillEntries)
		.leftJoin(
			capabilityLinks,
			and(
				eq(capabilityLinks.entityId, skillEntries.id),
				eq(capabilityLinks.entityKind, "skill"),
				eq(capabilityLinks.organizationId, organizationId),
			),
		)
		.where(and(...skillConditions))
		.orderBy(asc(skillEntries.title))
		.limit(limit);

	const skillTotalConditions = [
		eq(skillEntries.organizationId, organizationId),
		notArchived,
	];
	if (!options?.includeAppScopedSkills) {
		skillTotalConditions.push(isNull(skillEntries.appId));
	}
	const skillTotal = await db.$count(
		skillEntries,
		and(...skillTotalConditions),
	);

	const unmappedObjectives = await db
		.select({
			id: tediObjectives.id,
			tediId: tediObjectives.tediId,
			title: tediObjectives.title,
			type: tediObjectives.type,
			status: tediObjectives.status,
		})
		.from(tediObjectives)
		.leftJoin(
			capabilityLinks,
			and(
				eq(capabilityLinks.entityId, tediObjectives.id),
				eq(capabilityLinks.entityKind, "objective"),
				eq(capabilityLinks.organizationId, organizationId),
			),
		)
		.where(
			and(
				eq(tediObjectives.orgId, organizationId),
				eq(tediObjectives.status, "active"),
				isNull(capabilityLinks.id),
			),
		)
		.orderBy(asc(tediObjectives.title))
		.limit(limit);

	const objectiveTotal = await db.$count(
		tediObjectives,
		and(
			eq(tediObjectives.orgId, organizationId),
			eq(tediObjectives.status, "active"),
		),
	);

	return {
		skills: unmappedSkills.map((row) => ({
			id: row.id,
			title: row.title,
			slug: row.slug,
			lifecycleState: row.lifecycleState,
			paceLayer: row.paceLayer,
			appId: row.appId,
		})),
		objectives: unmappedObjectives,
		totals: {
			unmappedSkillCount: unmappedSkills.length,
			unmappedObjectiveCount: unmappedObjectives.length,
			skillTotal,
			objectiveTotal,
		},
	};
}
