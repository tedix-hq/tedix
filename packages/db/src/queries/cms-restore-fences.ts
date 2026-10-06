import { and, count, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { cmsSites } from "../schema/cms-sites";
import {
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

/** Terminal capture cleanup removes only its own pause, even before drain.
 * It never reclaims permits or touches a replacement capture's ownership. */
export async function abortCmsCaptureCronPause(
	db: DbQueryClient,
	input: CmsCaptureCronPauseParams,
): Promise<number> {
	const rows = await db.all(sql`
  DELETE FROM cms_capture_cron_pauses
  WHERE site_id = ${input.siteId}
   AND slug = ${input.slug}
   AND capture_id = ${input.captureId}
  RETURNING site_id
 `);
	return rows.length;
}

/** One D1 write serializes pause admission against scheduled permit admission. */
export async function claimCmsCaptureCronPause(
	db: DbQueryClient,
	input: CmsCaptureCronPauseParams,
): Promise<boolean> {
	const rows = await db.all(sql`
		INSERT INTO cms_capture_cron_pauses (site_id, slug, capture_id, expires_at_unix)
		SELECT site.id, site.slug, ${input.captureId}, unixepoch() + 3600
		FROM cms_sites AS site
		WHERE site.id = ${input.siteId}
			AND site.slug = ${input.slug}
			AND site.status = 'active'
			AND NOT EXISTS (SELECT 1 FROM cms_restore_fences AS fence WHERE fence.site_id = site.id)
			AND NOT EXISTS (SELECT 1 FROM cms_deprovision_operations AS operation WHERE operation.id = site.id)
		ON CONFLICT(site_id) DO UPDATE SET
			slug = excluded.slug,
			capture_id = excluded.capture_id,
			expires_at_unix = excluded.expires_at_unix,
			drained_at_unix = NULL
		WHERE cms_capture_cron_pauses.expires_at_unix <= unixepoch()
			OR (cms_capture_cron_pauses.slug = excluded.slug
				AND cms_capture_cron_pauses.capture_id = excluded.capture_id)
		RETURNING site_id
	`);
	return rows.length === 1;
}

/** The UPDATE is a primary D1 write: once it succeeds, no older cron remains. */
export async function drainCmsCaptureCronPause(
	db: DbQueryClient,
	input: CmsCaptureCronPauseParams,
): Promise<boolean> {
	const rows = await db.all(sql`
		UPDATE cms_capture_cron_pauses
		SET drained_at_unix = unixepoch()
		WHERE site_id = ${input.siteId}
			AND slug = ${input.slug}
			AND capture_id = ${input.captureId}
			AND expires_at_unix > unixepoch()
			AND NOT EXISTS (
				SELECT 1 FROM cms_restore_permits AS permit
				WHERE permit.site_id = ${input.siteId}
					AND permit.kind = 'scheduled'
			)
		RETURNING site_id
	`);
	return rows.length === 1;
}

/** Check close to publication, leaving a minute for the short manifest write. */
export async function assertCmsCaptureCronPause(
	db: DbQueryClient,
	input: CmsCaptureCronPauseParams,
): Promise<boolean> {
	const rows = await db.all(sql`
		UPDATE cms_capture_cron_pauses
		SET drained_at_unix = drained_at_unix
		WHERE site_id = ${input.siteId}
			AND slug = ${input.slug}
			AND capture_id = ${input.captureId}
			AND drained_at_unix IS NOT NULL
			AND expires_at_unix > unixepoch() + 60
		RETURNING site_id
	`);
	return rows.length === 1;
}

export async function releaseCmsCaptureCronPause(
	db: DbQueryClient,
	input: CmsCaptureCronPauseParams,
): Promise<boolean> {
	const rows = await db.all(sql`
		DELETE FROM cms_capture_cron_pauses
		WHERE site_id = ${input.siteId}
			AND slug = ${input.slug}
			AND capture_id = ${input.captureId}
			AND drained_at_unix IS NOT NULL
			AND expires_at_unix > unixepoch()
		RETURNING site_id
	`);
	if (rows.length === 1) return true;
	// A D1 response can be lost after the exact row was deleted. Replaying the
	// Workflow release must succeed only if no replacement owns this site.
	const remaining = await db.all(sql`
		SELECT site_id FROM cms_capture_cron_pauses
		WHERE site_id = ${input.siteId}
		LIMIT 1
	`);
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
	const rows = await db.all(sql`
		INSERT INTO cms_restore_permits (id, site_id, slug, restore_epoch, kind)
		SELECT ${input.permitId}, site.id, site.slug, site.restore_epoch, ${input.kind}
		FROM cms_sites AS site
		WHERE site.id = ${input.siteId}
			AND site.slug = ${input.slug}
			AND site.restore_epoch = ${input.restoreEpoch}
			AND site.status = 'active'
			AND NOT EXISTS (
				SELECT 1 FROM cms_restore_fences AS fence
				WHERE fence.site_id = site.id
			)
			AND NOT EXISTS (
				SELECT 1 FROM cms_deprovision_operations AS operation
				WHERE operation.id = site.id
			)
			AND (${input.kind} <> 'scheduled' OR NOT EXISTS (
				SELECT 1 FROM cms_capture_cron_pauses AS pause
				WHERE pause.site_id = site.id
					AND pause.slug = site.slug
					AND pause.expires_at_unix > unixepoch()
			))
		ON CONFLICT(id) DO NOTHING
		RETURNING id
	`);
	return rows.length === 1;
}

/** A current archived site may purge its private capture, but a restore close
 * or deprovision reservation must drain the entire purge before proceeding. */
export async function enterCmsRecoveryPurgePermit(
	db: DbQueryClient,
	input: CmsRestorePermitParams,
): Promise<boolean> {
	const rows = await db.all(sql`
		INSERT INTO cms_restore_permits (id, site_id, slug, restore_epoch, kind)
		SELECT ${input.permitId}, site.id, site.slug, site.restore_epoch, ${input.kind}
		FROM cms_sites AS site
		WHERE site.id = ${input.siteId}
			AND site.slug = ${input.slug}
			AND site.restore_epoch = ${input.restoreEpoch}
			AND site.status IN ('active', 'paused')
			AND NOT EXISTS (
				SELECT 1 FROM cms_restore_fences AS fence
				WHERE fence.site_id = site.id
			)
			AND NOT EXISTS (
				SELECT 1 FROM cms_deprovision_operations AS operation
				WHERE operation.id = site.id
			)
		ON CONFLICT(id) DO NOTHING
		RETURNING id
	`);
	return rows.length === 1;
}

/** Admit media provisioning only for the immutable site awaiting activation. */
export async function enterCmsProvisioningPermit(
	db: DbQueryClient,
	input: CmsRestorePermitParams,
): Promise<boolean> {
	const rows = await db.all(sql`
		INSERT INTO cms_restore_permits (id, site_id, slug, restore_epoch, kind)
		SELECT ${input.permitId}, site.id, site.slug, site.restore_epoch, ${input.kind}
		FROM cms_sites AS site
		WHERE site.id = ${input.siteId}
			AND site.slug = ${input.slug}
			AND site.restore_epoch = ${input.restoreEpoch}
			AND site.status = 'provisioning'
			AND NOT EXISTS (
				SELECT 1 FROM cms_restore_fences AS fence
				WHERE fence.site_id = site.id
			)
			AND NOT EXISTS (
				SELECT 1 FROM cms_deprovision_operations AS operation
				WHERE operation.id = site.id
			)
		ON CONFLICT(id) DO NOTHING
		RETURNING id
	`);
	return rows.length === 1;
}

/** The owner removes only its own claim; missing claims remain visible to reconciliation. */
export async function leaveCmsRestorePermit(
	db: DbQueryClient,
	input: CmsRestorePermitParams,
): Promise<boolean> {
	const rows = await db.all(sql`
		DELETE FROM cms_restore_permits
		WHERE id = ${input.permitId}
			AND site_id = ${input.siteId}
			AND slug = ${input.slug}
			AND restore_epoch = ${input.restoreEpoch}
			AND kind = ${input.kind}
		RETURNING id
	`);
	return rows.length === 1;
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
	const rows = await db.all(sql`
		DELETE FROM cms_restore_permits AS permit
		WHERE permit.site_id = ${input.siteId}
			AND permit.slug = ${input.slug}
			AND permit.kind = 'outer'
			AND EXISTS (
				SELECT 1 FROM cms_restore_fences AS fence
				JOIN cms_sites AS site ON site.id = fence.site_id
				WHERE fence.site_id = ${input.siteId}
					AND fence.slug = ${input.slug}
					AND fence.generation = ${input.generation}
					AND fence.capture_id = ${input.captureId}
					AND fence.restore_epoch IS NOT NULL
					AND site.slug = ${input.slug}
					AND site.restore_epoch > fence.restore_epoch
					AND site.restore_epoch > permit.restore_epoch
			)
			AND NOT EXISTS (
				SELECT 1 FROM cms_restore_permits AS blocker
				WHERE blocker.site_id = ${input.siteId}
					AND blocker.kind IN ('nested', 'legacy')
			)
		RETURNING id
	`);
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
	const rows = await db.all(sql`
		DELETE FROM cms_restore_fences
		WHERE site_id = ${input.siteId}
			AND slug = ${input.slug}
			AND generation = ${input.generation}
			AND capture_id = ${input.captureId}
			AND NOT EXISTS (
				SELECT 1 FROM cms_restore_permits AS permit
				WHERE permit.site_id = ${input.siteId}
			)
		RETURNING site_id
	`);
	return rows.length === 1;
}
