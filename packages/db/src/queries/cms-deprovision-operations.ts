import { coreStore } from "../core-store/dialect";
import { coreTable } from "../core-store/client";
import { runCmsWrite, runCmsWriteBatch } from "./cms-write-batch";
import { and, desc, eq, notExists, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { cmsSites as schemaCmsSites } from "../schema/cms-sites";
import {
	cmsRestoreFences as schemaCmsRestoreFences,
	cmsRestorePermits as schemaCmsRestorePermits,
} from "../schema/cms-restore-fences";
import {
	cmsDeprovisionOperations as schemaCmsDeprovisionOperations,
	type CmsDeprovisionOperationRow,
} from "../schema/cms-deprovision-operations";

export interface ReserveCmsDeprovisionOperationParams {
	siteId: string;
	organizationId: string;
	slug: string;
	authoringAppId: string | null;
}

export class CmsDeprovisionReservationConflictError extends Error {
	constructor(readonly reason: "restore_fenced" | "site_identity_mismatch") {
		super(`CMS deprovision reservation conflict: ${reason}`);
		this.name = "CmsDeprovisionReservationConflictError";
	}
}

/** The site ID is the operation ID, so a replay cannot dispatch a second cleanup. */
export async function reserveCmsDeprovisionOperation(
	db: DbQueryClient,
	input: ReserveCmsDeprovisionOperationParams,
): Promise<CmsDeprovisionOperationRow> {
	const cmsSites = coreTable(db, schemaCmsSites);
	const cmsRestoreFences = coreTable(db, schemaCmsRestoreFences);
	const cmsDeprovisionOperations = coreTable(
		db,
		schemaCmsDeprovisionOperations,
	);
	// Serialize this write with restore-fence close and permit admission.
	// Selecting the canonical site row prevents a caller from reserving another identity.
	await runCmsWrite(
		db,
		db
			.insert(cmsDeprovisionOperations)
			.select(
				db
					.select({
						id: cmsSites.id,
						organizationId: cmsSites.organizationId,
						slug: cmsSites.slug,
						authoringAppId: cmsSites.authoringAppId,
					})
					.from(cmsSites)
					.where(
						and(
							eq(cmsSites.id, input.siteId),
							eq(cmsSites.organizationId, input.organizationId),
							eq(cmsSites.slug, input.slug),
							coreStore(db) === "d1"
								? sql`${cmsSites.authoringAppId} IS ${input.authoringAppId}`
								: sql`${cmsSites.authoringAppId} IS NOT DISTINCT FROM ${input.authoringAppId}`,
							notExists(
								db
									.select({ one: sql`1` })
									.from(cmsRestoreFences)
									.where(eq(cmsRestoreFences.siteId, cmsSites.id)),
							),
						),
					),
			)
			.onConflictDoNothing({ target: cmsDeprovisionOperations.id }),
	);
	const [fence] = await db
		.select({ siteId: cmsRestoreFences.siteId })
		.from(cmsRestoreFences)
		.where(eq(cmsRestoreFences.siteId, input.siteId))
		.limit(1);
	if (fence) throw new CmsDeprovisionReservationConflictError("restore_fenced");
	const row = await getCmsDeprovisionOperationForOrganization(db, input);
	if (
		!row ||
		row.slug !== input.slug ||
		row.authoringAppId !== input.authoringAppId
	) {
		throw new CmsDeprovisionReservationConflictError("site_identity_mismatch");
	}
	return row;
}

export async function getCmsDeprovisionOperation(
	db: DbQueryClient,
	siteId: string,
): Promise<CmsDeprovisionOperationRow | null> {
	const cmsDeprovisionOperations = coreTable(
		db,
		schemaCmsDeprovisionOperations,
	);
	const [row] = await db
		.select()
		.from(cmsDeprovisionOperations)
		.where(eq(cmsDeprovisionOperations.id, siteId))
		.limit(1);
	return row ?? null;
}

/** The newest finished deprovision of a slug. It was created before any of
 * the site's data was deleted, which makes it the point to recover to. */
export async function getLatestSucceededCmsDeprovisionBySlug(
	db: DbQueryClient,
	slug: string,
): Promise<CmsDeprovisionOperationRow | null> {
	const cmsDeprovisionOperations = coreTable(
		db,
		schemaCmsDeprovisionOperations,
	);
	const [row] = await db
		.select()
		.from(cmsDeprovisionOperations)
		.where(
			and(
				eq(cmsDeprovisionOperations.slug, slug),
				eq(cmsDeprovisionOperations.status, "succeeded"),
			),
		)
		.orderBy(desc(cmsDeprovisionOperations.createdAt))
		.limit(1);
	return row ?? null;
}

export async function getCmsDeprovisionOperationForOrganization(
	db: DbQueryClient,
	input: { siteId: string; organizationId: string },
): Promise<CmsDeprovisionOperationRow | null> {
	const cmsDeprovisionOperations = coreTable(
		db,
		schemaCmsDeprovisionOperations,
	);
	const [row] = await db
		.select()
		.from(cmsDeprovisionOperations)
		.where(
			and(
				eq(cmsDeprovisionOperations.id, input.siteId),
				eq(cmsDeprovisionOperations.organizationId, input.organizationId),
			),
		)
		.limit(1);
	return row ?? null;
}

export interface UpdateCmsDeprovisionOperationParams {
	siteId: string;
	organizationId: string;
	status: CmsDeprovisionOperationRow["status"];
	stage: string;
	deleted?: string[];
	errors?: string[];
}

export async function updateCmsDeprovisionOperation(
	db: DbQueryClient,
	input: UpdateCmsDeprovisionOperationParams,
): Promise<CmsDeprovisionOperationRow | null> {
	const cmsDeprovisionOperations = coreTable(
		db,
		schemaCmsDeprovisionOperations,
	);
	const [row] = await runCmsWrite(
		db,
		db
			.update(cmsDeprovisionOperations)
			.set({
				status: input.status,
				stage: input.stage,
				...(input.deleted !== undefined ? { deleted: input.deleted } : {}),
				...(input.errors !== undefined ? { errors: input.errors } : {}),
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(cmsDeprovisionOperations.id, input.siteId),
					eq(cmsDeprovisionOperations.organizationId, input.organizationId),
				),
			)
			.returning(),
	);
	return row ?? null;
}

/** Commit the final site removal, its leftover permits and the durable success
 * receipt in one batch. */
export async function completeCmsDeprovisionOperation(
	db: DbQueryClient,
	input: { siteId: string; organizationId: string; deleted: string[] },
): Promise<CmsDeprovisionOperationRow> {
	const cmsSites = coreTable(db, schemaCmsSites);
	const cmsRestorePermits = coreTable(db, schemaCmsRestorePermits);
	const cmsDeprovisionOperations = coreTable(
		db,
		schemaCmsDeprovisionOperations,
	);
	const [, , updated] = await runCmsWriteBatch(db, [
		db
			.delete(cmsRestorePermits)
			.where(eq(cmsRestorePermits.siteId, input.siteId)),
		db
			.delete(cmsSites)
			.where(
				and(
					eq(cmsSites.id, input.siteId),
					eq(cmsSites.organizationId, input.organizationId),
				),
			),
		db
			.update(cmsDeprovisionOperations)
			.set({
				status: "succeeded",
				stage: "Complete",
				deleted: input.deleted,
				errors: [],
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(cmsDeprovisionOperations.id, input.siteId),
					eq(cmsDeprovisionOperations.organizationId, input.organizationId),
				),
			)
			.returning(),
	]);
	if (!updated[0])
		throw new Error("CMS deprovision operation disappeared before completion");
	return updated[0];
}
