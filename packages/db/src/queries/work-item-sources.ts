/**
 * Source graph — attach, read, and reconcile external sources against work.
 *
 * The engine half of the source graph: identity, hashing semantics, and the
 * tombstone ladder live here in TypeScript because they are org-agnostic
 * invariants. WHICH sources a tenant attaches, on what cadence, and what a
 * digest does with them is skill-workflow config, not platform code
 * (`docs/engineering/cognition/skills.md`).
 *
 * Federation over ingestion: this module stores identity and a content hash,
 * never source content.
 */

import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { chunkForBoundParams } from "../utils/batch";
import { projects } from "../schema/projects";
import {
	type NewWorkItemSource,
	type WorkItemSource,
	type WorkItemSourceKind,
	type WorkItemSourceState,
	workItemSources,
} from "../schema/work-item-sources";
import { workItems } from "../schema/work-items";

export class WorkItemSourceError extends Error {
	constructor(
		message: string,
		readonly reason:
			| "no_owner"
			| "owner_not_found"
			| "owner_wrong_org"
			| "not_found",
	) {
		super(message);
		this.name = "WorkItemSourceError";
	}
}

/** Grace period before a source observed missing is eligible for tombstoning. */
export const DEFAULT_TOMBSTONE_GRACE_HOURS = 72;

/** Kept well under D1's per-statement bound-parameter ceiling. */
const SEEN_ID_CHUNK = 50;

export interface AttachSourceInput {
	id: string;
	orgId: string;
	projectId?: string | null;
	workItemId?: string | null;
	provider: string;
	externalId: string;
	kind?: WorkItemSourceKind;
	externalUrl?: string | null;
	title?: string | null;
	contentHash?: string | null;
	attributedTo?: string | null;
	metadata?: Record<string, unknown>;
	now: string;
}

/**
 * Validate the polymorphic owner. `work_item_sources.workItemId` carries no FK
 * (adding one would force a destructive recreate of the pre-existing
 * `work_items` table), so existence and org are checked here — the same
 * query-layer pattern `work_items.parentWorkItemId` already uses.
 */
async function assertOwner(
	db: DbClient,
	params: {
		orgId: string;
		projectId?: string | null;
		workItemId?: string | null;
	},
): Promise<void> {
	const projectId = params.projectId?.trim() || null;
	const workItemId = params.workItemId?.trim() || null;
	if (!projectId && !workItemId) {
		throw new WorkItemSourceError(
			"A source must attach to a project, a work item, or both.",
			"no_owner",
		);
	}
	if (projectId) {
		const [row] = await db
			.select({ orgId: projects.orgId })
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1);
		if (!row) {
			throw new WorkItemSourceError(
				`Project ${projectId} does not exist.`,
				"owner_not_found",
			);
		}
		if (row.orgId !== params.orgId) {
			throw new WorkItemSourceError(
				`Project ${projectId} belongs to another org.`,
				"owner_wrong_org",
			);
		}
	}
	if (workItemId) {
		const [row] = await db
			.select({ orgId: workItems.orgId })
			.from(workItems)
			.where(eq(workItems.id, workItemId))
			.limit(1);
		if (!row) {
			throw new WorkItemSourceError(
				`Work item ${workItemId} does not exist.`,
				"owner_not_found",
			);
		}
		if (row.orgId !== params.orgId) {
			throw new WorkItemSourceError(
				`Work item ${workItemId} belongs to another org.`,
				"owner_wrong_org",
			);
		}
	}
}

/**
 * Idempotent attach. Re-attaching the same source is the normal case — the
 * digest re-runs three times a week — so this is an upsert keyed on
 * (org, provider, externalId, owner).
 *
 * Hash transitions are the point: an unchanged hash only refreshes
 * `lastCheckedAt`; a moved hash sets `state='changed'` and stamps
 * `lastChangedAt`. Re-attaching a tombstoned source revives it, because the
 * source reappearing upstream is exactly the evidence that the tombstone was
 * premature.
 */
export async function attachWorkItemSource(
	db: DbClient,
	input: AttachSourceInput,
): Promise<WorkItemSource> {
	await assertOwner(db, input);

	const projectId = input.projectId?.trim() || null;
	const workItemId = input.workItemId?.trim() || null;

	const existing = await findSource(db, {
		orgId: input.orgId,
		provider: input.provider,
		externalId: input.externalId,
		projectId,
		workItemId,
	});

	if (!existing) {
		const values: NewWorkItemSource = {
			id: input.id,
			orgId: input.orgId,
			projectId,
			workItemId,
			provider: input.provider,
			externalId: input.externalId,
			kind: input.kind ?? "other",
			externalUrl: input.externalUrl ?? null,
			title: input.title ?? null,
			contentHash: input.contentHash ?? null,
			state: "current",
			lastCheckedAt: input.contentHash ? input.now : null,
			attributedTo: input.attributedTo ?? null,
			metadata: (input.metadata ?? {}) as NewWorkItemSource["metadata"],
			createdAt: input.now,
			updatedAt: input.now,
		};
		const [row] = await db.insert(workItemSources).values(values).returning();
		return row!;
	}

	const hashMoved =
		input.contentHash != null &&
		existing.contentHash != null &&
		input.contentHash !== existing.contentHash;

	const [row] = await db
		.update(workItemSources)
		.set({
			kind: input.kind ?? existing.kind,
			externalUrl: input.externalUrl ?? existing.externalUrl,
			title: input.title ?? existing.title,
			contentHash: input.contentHash ?? existing.contentHash,
			state: hashMoved ? "changed" : "current",
			lastCheckedAt: input.now,
			lastChangedAt: hashMoved ? input.now : existing.lastChangedAt,
			// Reappearing upstream clears the tombstone clock in both directions.
			missingSinceAt: null,
			tombstonedAt: null,
			metadata: (input.metadata ??
				existing.metadata) as NewWorkItemSource["metadata"],
			updatedAt: input.now,
		})
		.where(eq(workItemSources.id, existing.id))
		.returning();
	return row!;
}

export async function findSource(
	db: DbClient,
	params: {
		orgId: string;
		provider: string;
		externalId: string;
		projectId: string | null;
		workItemId: string | null;
	},
): Promise<WorkItemSource | null> {
	const [row] = await db
		.select()
		.from(workItemSources)
		.where(
			and(
				eq(workItemSources.orgId, params.orgId),
				eq(workItemSources.provider, params.provider),
				eq(workItemSources.externalId, params.externalId),
				params.projectId
					? eq(workItemSources.projectId, params.projectId)
					: isNull(workItemSources.projectId),
				params.workItemId
					? eq(workItemSources.workItemId, params.workItemId)
					: isNull(workItemSources.workItemId),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function listWorkItemSources(
	db: DbClient,
	params: {
		orgId: string;
		projectId?: string;
		workItemId?: string;
		provider?: string;
		states?: WorkItemSourceState[];
		includeTombstoned?: boolean;
		limit?: number;
		offset?: number;
	},
): Promise<{ data: WorkItemSource[]; total: number }> {
	const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
	const offset = Math.max(params.offset ?? 0, 0);

	const conditions = [eq(workItemSources.orgId, params.orgId)];
	if (params.projectId) {
		conditions.push(eq(workItemSources.projectId, params.projectId));
	}
	if (params.workItemId) {
		conditions.push(eq(workItemSources.workItemId, params.workItemId));
	}
	if (params.provider) {
		conditions.push(eq(workItemSources.provider, params.provider));
	}
	if (params.states?.length) {
		// bound-params: subset of the closed source-state enum
		conditions.push(inArray(workItemSources.state, params.states));
	} else if (!params.includeTombstoned) {
		// Tombstoned rows are evidence, not live context — excluded by default so a
		// brief never renders a dead link.
		conditions.push(sql`${workItemSources.state} != 'tombstoned'`);
	}
	const where = and(...conditions);

	const data = await db
		.select()
		.from(workItemSources)
		.where(where)
		.orderBy(workItemSources.provider, workItemSources.externalId)
		.limit(limit)
		.offset(offset);

	const [counted] = await db
		.select({ total: sql<number>`count(*)` })
		.from(workItemSources)
		.where(where);

	return { data, total: counted?.total ?? 0 };
}

/**
 * Mark the sources a sweep did NOT return for a provider as missing.
 *
 * `seenExternalIds` is the full set the sweep observed for this owner+provider;
 * anything current and absent from it is now missing. This is the delete-detection
 * path a timestamp poll cannot give you — a deleted page simply stops appearing.
 *
 * Report-only in effect: rows move `current|changed → missing` and start the
 * grace clock. Nothing is destroyed, and a later attach revives them.
 */
export async function markMissingSources(
	db: DbClient,
	params: {
		orgId: string;
		provider: string;
		projectId?: string;
		seenExternalIds: string[];
		now: string;
	},
): Promise<{ marked: number }> {
	const conditions = [
		eq(workItemSources.orgId, params.orgId),
		eq(workItemSources.provider, params.provider),
		inArray(workItemSources.state, ["current", "changed"]),
	];
	if (params.projectId) {
		conditions.push(eq(workItemSources.projectId, params.projectId));
	}

	// The seen-set cannot be inlined as a `NOT IN`: D1 caps bound parameters per
	// STATEMENT, and splitting the list across several `NOT IN` conditions leaves
	// every parameter in the same statement — it does not help at all. Read the
	// attached set, diff in memory, then update by id in bounded chunks.
	const attached = await db
		.select({
			id: workItemSources.id,
			externalId: workItemSources.externalId,
		})
		.from(workItemSources)
		.where(and(...conditions));

	const seen = new Set(params.seenExternalIds);
	const missingIds = attached
		.filter((row) => !seen.has(row.externalId))
		.map((row) => row.id);
	if (missingIds.length === 0) return { marked: 0 };

	let marked = 0;
	for (const idChunk of chunkForBoundParams(missingIds, SEEN_ID_CHUNK)) {
		const rows = await db
			.update(workItemSources)
			.set({
				state: "missing",
				missingSinceAt: params.now,
				lastCheckedAt: params.now,
				updatedAt: params.now,
			})
			.where(inArray(workItemSources.id, idChunk))
			.returning({ id: workItemSources.id });
		marked += rows.length;
	}

	return { marked };
}

/**
 * Tombstone sources that have stayed missing past the grace period.
 *
 * Deliberately a second, delayed step rather than tombstoning on first miss: a
 * revoked OAuth token or a transient provider error makes every source look
 * deleted at once, and an eager sweep would tombstone an entire engagement's
 * context on one bad run.
 */
export async function tombstoneMissingSources(
	db: DbClient,
	params: {
		orgId: string;
		now: string;
		graceHours?: number;
		provider?: string;
	},
): Promise<{ tombstoned: string[] }> {
	const graceMs =
		(params.graceHours ?? DEFAULT_TOMBSTONE_GRACE_HOURS) * 3_600_000;
	const cutoff = new Date(Date.parse(params.now) - graceMs).toISOString();

	const conditions = [
		eq(workItemSources.orgId, params.orgId),
		eq(workItemSources.state, "missing"),
		lt(workItemSources.missingSinceAt, cutoff),
	];
	if (params.provider) {
		conditions.push(eq(workItemSources.provider, params.provider));
	}

	const rows = await db
		.update(workItemSources)
		.set({
			state: "tombstoned",
			tombstonedAt: params.now,
			updatedAt: params.now,
		})
		.where(and(...conditions))
		.returning({ id: workItemSources.id });

	return { tombstoned: rows.map((r) => r.id) };
}

/**
 * Freshness report for an org or one project: how much of the attached context
 * is current, drifted, or gone, and how stale the oldest check is. This is the
 * "index rot" metric — a rising `changed`/`missing` count means the digest is
 * not keeping up with source-change velocity.
 */
export async function getSourceFreshness(
	db: DbClient,
	params: { orgId: string; projectId?: string },
): Promise<{
	byState: Record<string, number>;
	total: number;
	oldestCheckedAt: string | null;
	neverChecked: number;
}> {
	const conditions = [eq(workItemSources.orgId, params.orgId)];
	if (params.projectId) {
		conditions.push(eq(workItemSources.projectId, params.projectId));
	}
	const where = and(...conditions);

	const rows = await db
		.select({
			state: workItemSources.state,
			count: sql<number>`count(*)`,
			oldest: sql<string | null>`min(${workItemSources.lastCheckedAt})`,
			never: sql<number>`sum(case when ${workItemSources.lastCheckedAt} is null then 1 else 0 end)`,
		})
		.from(workItemSources)
		.where(where)
		.groupBy(workItemSources.state);

	const byState: Record<string, number> = {};
	let total = 0;
	let neverChecked = 0;
	let oldestCheckedAt: string | null = null;
	for (const row of rows) {
		byState[row.state] = Number(row.count);
		total += Number(row.count);
		neverChecked += Number(row.never ?? 0);
		if (row.oldest && (!oldestCheckedAt || row.oldest < oldestCheckedAt)) {
			oldestCheckedAt = row.oldest;
		}
	}
	return { byState, total, oldestCheckedAt, neverChecked };
}
