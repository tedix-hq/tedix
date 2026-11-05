import {
	and,
	count,
	eq,
	exists,
	gt,
	inArray,
	isNotNull,
	notExists,
	or,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbQueryClient } from "../query-client";
import { cmsDeprovisionOperations } from "../schema/cms-deprovision-operations";
import { cmsSites } from "../schema/cms-sites";
import {
	cmsCaptureCronPauses,
	cmsRestoreFences,
	cmsRestorePermits,
	type CmsRestoreFenceRow,
} from "../schema/cms-restore-fences";

export interface CmsRestoreSiteParams {
	siteId: string;
	slug: string;
}

export interface CmsRestorePermitParams extends CmsRestoreSiteParams {
	permitId: string;
	restoreEpoch: number;
	kind: "outer" | "nested" | "scheduled";
}

export interface CmsRestoreFenceParams extends CmsRestoreSiteParams {
	generation: string;
	captureId: string;
}

export interface CmsCaptureCronPauseParams extends CmsRestoreSiteParams {
	captureId: string;
}

/** Correlated guard: the outer `cms_sites` row has no closed restore fence. */
function siteHasNoFence(db: DbQueryClient) {
	return notExists(
		db
			.select({ one: sql`1` })
			.from(cmsRestoreFences)
			.where(eq(cmsRestoreFences.siteId, cmsSites.id)),
	);
}

/** Correlated guard: the outer `cms_sites` row has no deprovision reservation. */
function siteHasNoDeprovision(db: DbQueryClient) {
	return notExists(
		db
			.select({ one: sql`1` })
			.from(cmsDeprovisionOperations)
			.where(eq(cmsDeprovisionOperations.id, cmsSites.id)),
	);
}

/** Terminal capture cleanup removes only its own pause, even before drain.
 * It never reclaims permits or touches a replacement capture's ownership. */
export async function abortCmsCaptureCronPause(
	db: DbQueryClient,
	input: CmsCaptureCronPauseParams,
): Promise<number> {
	const rows = await db
		.delete(cmsCaptureCronPauses)
		.where(
			and(
				eq(cmsCaptureCronPauses.siteId, input.siteId),
				eq(cmsCaptureCronPauses.slug, input.slug),
				eq(cmsCaptureCronPauses.captureId, input.captureId),
			),
		)
		.returning({ siteId: cmsCaptureCronPauses.siteId });
	return rows.length;
}

/** One D1 write serializes pause admission against scheduled permit admission. */
export async function claimCmsCaptureCronPause(
	db: DbQueryClient,
	input: CmsCaptureCronPauseParams,
): Promise<boolean> {
	const rows = await db
		.insert(cmsCaptureCronPauses)
		.select(
			db
				.select({
					siteId: cmsSites.id,
					slug: cmsSites.slug,
					captureId: sql<string>`${input.captureId}`.as("capture_id"),
					expiresAtUnix: sql<number>`unixepoch() + 3600`.as("expires_at_unix"),
				})
				.from(cmsSites)
				.where(
					and(
						eq(cmsSites.id, input.siteId),
						eq(cmsSites.slug, input.slug),
						eq(cmsSites.status, "active"),
						siteHasNoFence(db),
						siteHasNoDeprovision(db),
					),
				),
		)
		.onConflictDoUpdate({
			target: cmsCaptureCronPauses.siteId,
			set: {
				slug: sql`excluded.slug`,
				captureId: sql`excluded.capture_id`,
				expiresAtUnix: sql`excluded.expires_at_unix`,
				drainedAtUnix: null,
			},
			setWhere: or(
				sql`${cmsCaptureCronPauses.expiresAtUnix} <= unixepoch()`,
				and(
					sql`${cmsCaptureCronPauses.slug} = excluded.slug`,
					sql`${cmsCaptureCronPauses.captureId} = excluded.capture_id`,
				),
			),
		})
		.returning({ siteId: cmsCaptureCronPauses.siteId });
	return rows.length === 1;
}

/** The UPDATE is a primary D1 write: once it succeeds, no older cron remains. */
export async function drainCmsCaptureCronPause(
	db: DbQueryClient,
	input: CmsCaptureCronPauseParams,
): Promise<boolean> {
	const rows = await db
		.update(cmsCaptureCronPauses)
		.set({ drainedAtUnix: sql`unixepoch()` })
		.where(
			and(
				eq(cmsCaptureCronPauses.siteId, input.siteId),
				eq(cmsCaptureCronPauses.slug, input.slug),
				eq(cmsCaptureCronPauses.captureId, input.captureId),
				sql`${cmsCaptureCronPauses.expiresAtUnix} > unixepoch()`,
				notExists(
					db
						.select({ one: sql`1` })
						.from(cmsRestorePermits)
						.where(
							and(
								eq(cmsRestorePermits.siteId, input.siteId),
								eq(cmsRestorePermits.kind, "scheduled"),
							),
						),
				),
			),
		)
		.returning({ siteId: cmsCaptureCronPauses.siteId });
	return rows.length === 1;
}

/** Check close to publication, leaving a minute for the short manifest write. */
export async function assertCmsCaptureCronPause(
	db: DbQueryClient,
	input: CmsCaptureCronPauseParams,
): Promise<boolean> {
	const rows = await db
		.update(cmsCaptureCronPauses)
		.set({ drainedAtUnix: sql`${cmsCaptureCronPauses.drainedAtUnix}` })
		.where(
			and(
				eq(cmsCaptureCronPauses.siteId, input.siteId),
				eq(cmsCaptureCronPauses.slug, input.slug),
				eq(cmsCaptureCronPauses.captureId, input.captureId),
				isNotNull(cmsCaptureCronPauses.drainedAtUnix),
				sql`${cmsCaptureCronPauses.expiresAtUnix} > unixepoch() + 60`,
			),
		)
		.returning({ siteId: cmsCaptureCronPauses.siteId });
	return rows.length === 1;
}

export async function releaseCmsCaptureCronPause(
	db: DbQueryClient,
	input: CmsCaptureCronPauseParams,
): Promise<boolean> {
	const rows = await db
		.delete(cmsCaptureCronPauses)
		.where(
			and(
				eq(cmsCaptureCronPauses.siteId, input.siteId),
				eq(cmsCaptureCronPauses.slug, input.slug),
				eq(cmsCaptureCronPauses.captureId, input.captureId),
				isNotNull(cmsCaptureCronPauses.drainedAtUnix),
				sql`${cmsCaptureCronPauses.expiresAtUnix} > unixepoch()`,
			),
		)
		.returning({ siteId: cmsCaptureCronPauses.siteId });
	if (rows.length === 1) return true;
	// A D1 response can be lost after the exact row was deleted. Replaying the
	// Workflow release must succeed only if no replacement owns this site.
	const remaining = await db
		.select({ siteId: cmsCaptureCronPauses.siteId })
		.from(cmsCaptureCronPauses)
		.where(eq(cmsCaptureCronPauses.siteId, input.siteId))
		.limit(1);
	return remaining.length === 0;
}

/**
 * The single D1 write is the admission point. Closing the fence and admitting
 * a permit are serialized writes, so a close cannot miss an admitted request.
 */
export async function enterCmsRestorePermit(
	db: DbQueryClient,
	input: CmsRestorePermitParams,
): Promise<boolean> {
	const rows = await db
		.insert(cmsRestorePermits)
		.select(
			db
				.select({
					id: sql<string>`${input.permitId}`.as("id"),
					siteId: cmsSites.id,
					slug: cmsSites.slug,
					restoreEpoch: cmsSites.restoreEpoch,
					kind: sql<CmsRestorePermitParams["kind"]>`${input.kind}`.as("kind"),
				})
				.from(cmsSites)
				.where(
					and(
						eq(cmsSites.id, input.siteId),
						eq(cmsSites.slug, input.slug),
						eq(cmsSites.restoreEpoch, input.restoreEpoch),
						eq(cmsSites.status, "active"),
						siteHasNoFence(db),
						siteHasNoDeprovision(db),
						// A scheduled permit also waits for an unexpired capture pause.
						input.kind === "scheduled"
							? notExists(
									db
										.select({ one: sql`1` })
										.from(cmsCaptureCronPauses)
										.where(
											and(
												eq(cmsCaptureCronPauses.siteId, cmsSites.id),
												eq(cmsCaptureCronPauses.slug, cmsSites.slug),
												sql`${cmsCaptureCronPauses.expiresAtUnix} > unixepoch()`,
											),
										),
								)
							: undefined,
					),
				),
		)
		.onConflictDoNothing({ target: cmsRestorePermits.id })
		.returning({ id: cmsRestorePermits.id });
	return rows.length === 1;
}

/** A current archived site may purge its private capture, but a restore close
 * or deprovision reservation must drain the entire purge before proceeding. */
export async function enterCmsRecoveryPurgePermit(
	db: DbQueryClient,
	input: CmsRestorePermitParams,
): Promise<boolean> {
	const rows = await db
		.insert(cmsRestorePermits)
		.select(
			db
				.select({
					id: sql<string>`${input.permitId}`.as("id"),
					siteId: cmsSites.id,
					slug: cmsSites.slug,
					restoreEpoch: cmsSites.restoreEpoch,
					kind: sql<CmsRestorePermitParams["kind"]>`${input.kind}`.as("kind"),
				})
				.from(cmsSites)
				.where(
					and(
						eq(cmsSites.id, input.siteId),
						eq(cmsSites.slug, input.slug),
						eq(cmsSites.restoreEpoch, input.restoreEpoch),
						inArray(cmsSites.status, ["active", "paused"]),
						siteHasNoFence(db),
						siteHasNoDeprovision(db),
					),
				),
		)
		.onConflictDoNothing({ target: cmsRestorePermits.id })
		.returning({ id: cmsRestorePermits.id });
	return rows.length === 1;
}

/** Admit media provisioning only for the immutable site awaiting activation. */
export async function enterCmsProvisioningPermit(
	db: DbQueryClient,
	input: CmsRestorePermitParams,
): Promise<boolean> {
	const rows = await db
		.insert(cmsRestorePermits)
		.select(
			db
				.select({
					id: sql<string>`${input.permitId}`.as("id"),
					siteId: cmsSites.id,
					slug: cmsSites.slug,
					restoreEpoch: cmsSites.restoreEpoch,
					kind: sql<CmsRestorePermitParams["kind"]>`${input.kind}`.as("kind"),
				})
				.from(cmsSites)
				.where(
					and(
						eq(cmsSites.id, input.siteId),
						eq(cmsSites.slug, input.slug),
						eq(cmsSites.restoreEpoch, input.restoreEpoch),
						eq(cmsSites.status, "provisioning"),
						siteHasNoFence(db),
						siteHasNoDeprovision(db),
					),
				),
		)
		.onConflictDoNothing({ target: cmsRestorePermits.id })
		.returning({ id: cmsRestorePermits.id });
	return rows.length === 1;
}

/** The owner removes only its own claim; missing claims remain visible to reconciliation. */
export async function leaveCmsRestorePermit(
	db: DbQueryClient,
	input: CmsRestorePermitParams,
): Promise<boolean> {
	const rows = await db
		.delete(cmsRestorePermits)
		.where(
			and(
				eq(cmsRestorePermits.id, input.permitId),
				eq(cmsRestorePermits.siteId, input.siteId),
				eq(cmsRestorePermits.slug, input.slug),
				eq(cmsRestorePermits.restoreEpoch, input.restoreEpoch),
				eq(cmsRestorePermits.kind, input.kind),
			),
		)
		.returning({ id: cmsRestorePermits.id });
	return rows.length === 1;
}

/** After durable completion proof, an already reconciled claim is success.
 * A conflicting row with the same ID must remain visible and fail closed. */
export async function leaveCompletedCmsScheduledPermit(
	db: DbQueryClient,
	input: CmsRestorePermitParams,
): Promise<boolean> {
	if (input.kind !== "scheduled") return false;
	if (await leaveCmsRestorePermit(db, input)) return true;
	const rows = await db
		.select({ id: cmsRestorePermits.id })
		.from(cmsRestorePermits)
		.where(eq(cmsRestorePermits.id, input.permitId))
		.limit(1);
	return rows.length === 0;
}

/**
 * A different generation cannot replace an existing close. A failed restore
 * therefore stays closed until the exact generation and capture are released.
 */
export async function closeCmsRestoreFence(
	db: DbQueryClient,
	input: CmsRestoreFenceParams,
): Promise<boolean> {
	const insertFence = db
		.insert(cmsRestoreFences)
		.select(
			db
				.select({
					siteId: cmsSites.id,
					slug: cmsSites.slug,
					generation: sql<string>`${input.generation}`.as("generation"),
					captureId: sql<string>`${input.captureId}`.as("capture_id"),
					restoreEpoch: cmsSites.restoreEpoch,
				})
				.from(cmsSites).where(sql`${cmsSites.id} = ${input.siteId}
					AND ${cmsSites.slug} = ${input.slug}
					AND ${cmsSites.status} = 'active'
					AND NOT EXISTS (
						SELECT 1 FROM cms_deprovision_operations AS operation
						WHERE operation.id = ${cmsSites.id}
					)`),
		)
		.onConflictDoNothing({ target: cmsRestoreFences.siteId })
		.returning({ siteId: cmsRestoreFences.siteId });
	const rotateEpoch = db
		.update(cmsSites)
		.set({ restoreEpoch: sql`${cmsSites.restoreEpoch} + 1` })
		.where(sql`${cmsSites.id} = ${input.siteId}
			AND ${cmsSites.slug} = ${input.slug}
			AND EXISTS (
				SELECT 1 FROM cms_restore_fences AS fence
				WHERE fence.site_id = ${cmsSites.id}
					AND fence.slug = ${cmsSites.slug}
					AND fence.generation = ${input.generation}
					AND fence.capture_id = ${input.captureId}
					AND fence.restore_epoch = ${cmsSites.restoreEpoch}
			)`)
		.returning({ siteId: cmsSites.id });
	const [inserted, rotated] = await db.batch([insertFence, rotateEpoch]);
	if (inserted.length !== rotated.length)
		throw new Error("CMS restore fence epoch rotation was not atomic");
	return inserted.length === 1;
}

export interface CmsRestoreFenceStateResult {
	fence: CmsRestoreFenceRow | null;
	inFlight: number;
}

/** Pin an invocation to the site's current admission generation. */
export async function getCmsRestoreEpoch(
	db: DbQueryClient,
	input: CmsRestoreSiteParams,
): Promise<number | null> {
	const [site] = await db
		.select({ restoreEpoch: cmsSites.restoreEpoch })
		.from(cmsSites)
		.where(and(eq(cmsSites.id, input.siteId), eq(cmsSites.slug, input.slug)))
		.limit(1);
	return site?.restoreEpoch ?? null;
}

/** Deprovision drains by immutable site ID, including permits entered under an older slug. */
export async function countCmsRestorePermitsForSite(
	db: DbQueryClient,
	siteId: string,
): Promise<number> {
	const [permits] = await db
		.select({ inFlight: count() })
		.from(cmsRestorePermits)
		.where(eq(cmsRestorePermits.siteId, siteId));
	return permits?.inFlight ?? 0;
}

/**
 * Explicit reconciliation after a restore close has rotated the epoch. Nested
 * or historical permits for this immutable site prevent reclaim, regardless
 * of their slug; neither kind is ever deleted here.
 */
export async function reconcileCmsRestoreOuterPermits(
	db: DbQueryClient,
	input: CmsRestoreFenceParams,
): Promise<number> {
	const blocker = alias(cmsRestorePermits, "blocker");
	const rows = await db
		.delete(cmsRestorePermits)
		.where(
			and(
				eq(cmsRestorePermits.siteId, input.siteId),
				eq(cmsRestorePermits.slug, input.slug),
				eq(cmsRestorePermits.kind, "outer"),
				exists(
					db
						.select({ one: sql`1` })
						.from(cmsRestoreFences)
						.innerJoin(cmsSites, eq(cmsSites.id, cmsRestoreFences.siteId))
						.where(
							and(
								eq(cmsRestoreFences.siteId, input.siteId),
								eq(cmsRestoreFences.slug, input.slug),
								eq(cmsRestoreFences.generation, input.generation),
								eq(cmsRestoreFences.captureId, input.captureId),
								isNotNull(cmsRestoreFences.restoreEpoch),
								eq(cmsSites.slug, input.slug),
								gt(cmsSites.restoreEpoch, cmsRestoreFences.restoreEpoch),
								gt(cmsSites.restoreEpoch, cmsRestorePermits.restoreEpoch),
							),
						),
				),
				notExists(
					db
						.select({ one: sql`1` })
						.from(blocker)
						.where(
							and(
								eq(blocker.siteId, input.siteId),
								inArray(blocker.kind, ["nested", "legacy"]),
							),
						),
				),
			),
		)
		.returning({ id: cmsRestorePermits.id });
	return rows.length;
}

/** Administrative drain read; an orphan permit remains counted indefinitely. */
export async function getCmsRestoreFenceState(
	db: DbQueryClient,
	input: CmsRestoreSiteParams,
): Promise<CmsRestoreFenceStateResult> {
	const [fence] = await db
		.select()
		.from(cmsRestoreFences)
		.where(
			and(
				eq(cmsRestoreFences.siteId, input.siteId),
				eq(cmsRestoreFences.slug, input.slug),
			),
		)
		.limit(1);
	const [permits] = await db
		.select({ inFlight: count() })
		.from(cmsRestorePermits)
		.where(
			and(
				eq(cmsRestorePermits.siteId, input.siteId),
				eq(cmsRestorePermits.slug, input.slug),
			),
		);
	return { fence: fence ?? null, inFlight: permits?.inFlight ?? 0 };
}

/** Exact-generation, exact-capture release is refused until all permits leave. */
export async function releaseCmsRestoreFence(
	db: DbQueryClient,
	input: CmsRestoreFenceParams,
): Promise<boolean> {
	const rows = await db
		.delete(cmsRestoreFences)
		.where(
			and(
				eq(cmsRestoreFences.siteId, input.siteId),
				eq(cmsRestoreFences.slug, input.slug),
				eq(cmsRestoreFences.generation, input.generation),
				eq(cmsRestoreFences.captureId, input.captureId),
				notExists(
					db
						.select({ one: sql`1` })
						.from(cmsRestorePermits)
						.where(eq(cmsRestorePermits.siteId, input.siteId)),
				),
			),
		)
		.returning({ siteId: cmsRestoreFences.siteId });
	return rows.length === 1;
}
