import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type CognitiveVisibility,
	type NewSkillEntry,
	type SkillEntry,
	skillEntries,
} from "../../schema/cognitive";
import { getAffectedRows } from "../../utils/d1-result";
import {
	assertForcedSkillPromotionAuthority,
	assertInitialSkillLifecycleState,
	assertSkillLifecycleTransition,
	type ForcedSkillPromotionAuthority,
	paceLayerForLifecycle,
	SkillPaceLayerOverrideError,
} from "../skill-lifecycle";
import { resolveSkillMcpAppBindings } from "./skill-mcp-bindings";
import { slugify } from "./skill-validation";

export type { CognitiveVisibility };

/**
 * Apply supersedes logic: when a tedi-specific skill overrides a baseline,
 * remove the baseline from the result set. Tedi overrides win.
 */
export function applySupersedes(skills: SkillEntry[]): SkillEntry[] {
	const supersededIds = new Set<string>();
	for (const skill of skills) {
		if (skill.supersedesId) {
			supersededIds.add(skill.supersedesId);
		}
	}
	if (supersededIds.size === 0) return skills;
	return skills.filter((s) => !supersededIds.has(s.id));
}

/** Generate a URL-safe slug from a title (ext-skills convention: lowercase alphanumeric + hyphens, 1-64 chars). */

export async function createSkillEntry(
	db: DbClient,
	entry: Omit<NewSkillEntry, "paceLayer"> &
		Partial<Pick<NewSkillEntry, "paceLayer">>,
): Promise<SkillEntry> {
	assertInitialSkillLifecycleState(entry.lifecycleState);
	const lifecycleState = entry.lifecycleState ?? "draft";
	// WS6 pace-layer auto-classification: new rows are drafts → innovation.
	const paceLayer = entry.paceLayer ?? paceLayerForLifecycle(lifecycleState);
	// NOTE: D1's HTTP API rejects interactive transactions ("Failed query: begin").
	// We do a read-then-insert without wrapping in a transaction. The slug
	// collision check is a best-effort race guard; the unique index on
	// (organization_id, slug) is the real safety net.
	const id = entry.id ?? crypto.randomUUID();
	const mcpAppBindings =
		entry.mcpAppBindings !== undefined
			? entry.mcpAppBindings
			: await resolveSkillMcpAppBindings(db, {
					organizationId: entry.organizationId,
					content: entry.content,
				});
	let slug = entry.slug;
	if (!slug && entry.title) {
		const base = slugify(entry.title);
		slug = base;
		const existing = await db.query.skillEntries.findFirst({
			where: { organizationId: entry.organizationId, slug },
		});
		if (existing) {
			slug = `${base}-${id.slice(0, 8)}`;
		}
	}
	try {
		const [created] = await db
			.insert(skillEntries)
			.values({
				...entry,
				id,
				slug,
				lifecycleState,
				paceLayer,
				mcpAppBindings,
			})
			.returning();
		if (!created) throw new Error(`Failed to create skill entry: ${id}`);
		return created;
	} catch (err) {
		// If the unique index trips (concurrent insert with the same auto-slug),
		// fall back to a UUID-suffixed slug and retry once.
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("UNIQUE") && entry.title) {
			const fallbackSlug = `${slugify(entry.title)}-${id.slice(0, 8)}`;
			const [created] = await db
				.insert(skillEntries)
				.values({
					...entry,
					id,
					slug: fallbackSlug,
					lifecycleState,
					paceLayer,
					mcpAppBindings,
				})
				.returning();
			if (!created)
				throw new Error(`Failed to create skill entry on retry: ${id}`);
			return created;
		}
		throw err;
	}
}

export async function getSkillEntry(
	db: DbClient,
	id: string,
	orgId?: string,
): Promise<SkillEntry | undefined> {
	const conditions = [eq(skillEntries.id, id)];
	if (orgId) {
		conditions.push(eq(skillEntries.organizationId, orgId));
	}
	const rows = await db
		.select()
		.from(skillEntries)
		.where(and(...conditions))
		.limit(1);
	return rows[0];
}

export async function getSkillEntryBySlug(
	db: DbClient,
	orgId: string,
	slug: string,
): Promise<SkillEntry | undefined> {
	// Resolve to the LATEST entry for a slug. Multiple rows can share a slug
	// (record_skills inserts a new revision rather than upserting), and an
	// unordered findFirst returns an arbitrary — usually the oldest — row, which
	// can be a stale revision missing a newly-declared capability manifest (the
	// run_skill_workflow{slug} → CAPABILITY_NOT_DECLARED footgun). Prefer the
	// highest revision, then the most recently created.
	return db.query.skillEntries.findFirst({
		where: { organizationId: orgId, slug },
		orderBy: { revision: "desc", createdAt: "desc" },
	});
}

/** Return any live owner of a slug, independent of archived revision ordering. */
export async function getNonArchivedSkillEntryBySlug(
	db: DbClient,
	orgId: string,
	slug: string,
): Promise<SkillEntry | undefined> {
	const rows = await db
		.select()
		.from(skillEntries)
		.where(
			and(
				eq(skillEntries.organizationId, orgId),
				eq(skillEntries.slug, slug),
				ne(skillEntries.lifecycleState, "archived"),
			),
		)
		.orderBy(desc(skillEntries.revision), desc(skillEntries.createdAt))
		.limit(1);
	return rows[0];
}

export function readableSkillCondition(tediId?: string) {
	const orgVisible = and(
		isNull(skillEntries.tediId),
		ne(skillEntries.visibility, "private"),
	)!;
	if (tediId) {
		return or(orgVisible, eq(skillEntries.tediId, tediId))!;
	}
	return orgVisible;
}

export type SkillReadabilitySubject = Pick<SkillEntry, "tediId" | "visibility">;

export function isSkillReadableByTedi(
	entry: SkillReadabilitySubject,
	tediId?: string,
): boolean {
	if (tediId && entry.tediId === tediId) return true;
	return entry.tediId == null && entry.visibility !== "private";
}

export async function getSkillEntryForMcp(
	db: DbClient,
	orgId: string,
	input: { id?: string; slug?: string; tediId?: string },
): Promise<SkillEntry | undefined> {
	const entry = input.id
		? await getSkillEntry(db, input.id, orgId)
		: input.slug
			? await getSkillEntryBySlug(db, orgId, input.slug)
			: undefined;
	if (!entry) return undefined;
	return isSkillReadableByTedi(entry, input.tediId) ? entry : undefined;
}

export interface UpdateSkillEntryOptions {
	/**
	 * Override for execute-to-promote lifecycle gating. The handler layer must
	 * verify the caller via the capability-mutation-gate allowlist and pass the
	 * proven identity as `forceAuthority` — a force PROMOTION without a named
	 * authority is rejected at this layer (fails closed).
	 */
	force?: boolean;
	/**
	 * Disposer separation: who is exercising the force promotion. Required
	 * for upward transitions when `force` is set; a `tedi` authority is
	 * rejected when it equals the entry's authoring identity.
	 */
	forceAuthority?: ForcedSkillPromotionAuthority;
	/** Internal: lifecycle write performed by muscle-memory crystallization. */
	via?: "crystallize";
	/**
	 * Defense in depth: when set, both the lifecycle pre-read and the UPDATE
	 * itself are additionally scoped to this organization, so a foreign-org id
	 * can never mutate a row even if a handler's own scoping regresses.
	 */
	organizationId?: string;
}

export async function updateSkillEntry(
	db: DbClient,
	id: string,
	updates: Partial<NewSkillEntry>,
	options?: UpdateSkillEntryOptions,
): Promise<void> {
	// WS6: a manual pace-layer override is governance metadata — it rides the
	// same force-authority path as lifecycle overrides (human/operator only).
	if (updates.paceLayer !== undefined && !options?.force) {
		throw new SkillPaceLayerOverrideError(
			"paceLayer is auto-derived from lifecycle; a manual override requires the human/operator force path",
			{ skillId: id, to: updates.paceLayer ?? "innovation" },
		);
	}
	const scopedWhere = options?.organizationId
		? and(
				eq(skillEntries.id, id),
				eq(skillEntries.organizationId, options.organizationId),
			)!
		: eq(skillEntries.id, id);
	// Execute-to-promote: every lifecycle transition through this write path
	// is verified against the skill_usage_events ledger, so no caller can
	// promote a skill that never executed. Demotions/archival always pass.
	// Force promotions carry the proposer≠approver backstop instead.
	if (updates.lifecycleState != null) {
		const rows = await db
			.select({
				id: skillEntries.id,
				organizationId: skillEntries.organizationId,
				lifecycleState: skillEntries.lifecycleState,
				tediId: skillEntries.tediId,
				proposedByTediId: skillEntries.proposedByTediId,
			})
			.from(skillEntries)
			.where(scopedWhere)
			.limit(1);
		const current = rows[0];
		if (current && updates.lifecycleState !== current.lifecycleState) {
			if (options?.force) {
				assertForcedSkillPromotionAuthority(
					current,
					updates.lifecycleState,
					options.forceAuthority,
				);
			} else {
				await assertSkillLifecycleTransition(
					db,
					current,
					updates.lifecycleState,
					{ via: options?.via },
				);
			}
		}
	}
	// WS6 pace-layer auto-classification: every lifecycle transition re-derives
	// the layer unless the caller explicitly overrides it in the same write.
	let patch =
		updates.lifecycleState != null && updates.paceLayer === undefined
			? { ...updates, paceLayer: paceLayerForLifecycle(updates.lifecycleState) }
			: updates;
	// A content write re-derives the MCP namespace → app id bindings, keeping
	// existing ones whose app still exists so a renamed app stays bound.
	if (updates.content !== undefined && updates.mcpAppBindings === undefined) {
		const [current] = await db
			.select({
				organizationId: skillEntries.organizationId,
				mcpAppBindings: skillEntries.mcpAppBindings,
			})
			.from(skillEntries)
			.where(scopedWhere)
			.limit(1);
		if (current) {
			patch = {
				...patch,
				mcpAppBindings: await resolveSkillMcpAppBindings(db, {
					organizationId: current.organizationId,
					content: updates.content,
					existing: current.mcpAppBindings,
				}),
			};
		}
	}
	await db
		.update(skillEntries)
		.set({ ...patch, updatedAt: new Date().toISOString() })
		.where(scopedWhere);
}

export async function deleteSkillEntry(
	db: DbClient,
	id: string,
	orgId: string,
): Promise<boolean> {
	const result = await db
		.delete(skillEntries)
		.where(
			and(eq(skillEntries.id, id), eq(skillEntries.organizationId, orgId)),
		);
	return getAffectedRows(result) !== 0;
}

/** Canonical eligible candidates; bounded IDs and tenant/readability enforced in SQL. */
export async function listRankableSkillEntries(
	db: DbClient,
	orgId: string,
	tediId: string,
	ids: readonly string[],
): Promise<SkillEntry[]> {
	if (!ids.length) return [];
	if (ids.length > 40) throw new Error("Too many skill candidates");
	return db
		.select()
		.from(skillEntries)
		.where(
			and(
				eq(skillEntries.organizationId, orgId),
				// bound-params: IDs are rejected above 40, leaving room for tenant, visibility, and lifecycle binds.
				inArray(skillEntries.id, [...ids]),
				readableSkillCondition(tediId),
				inArray(skillEntries.lifecycleState, [
					"active",
					"proven",
					"crystallized",
				]),
			),
		);
}
