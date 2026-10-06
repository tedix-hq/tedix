import { and, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { cmsSites } from "../schema/cms-sites";
import { cmsRestoreFences } from "../schema/cms-restore-fences";
import {
	cmsDeprovisionOperations,
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
	// D1 serializes this write with restore-fence close and permit admission.
	// Selecting the canonical site row prevents a caller from reserving another identity.
	await db.all(sql`
		INSERT INTO cms_deprovision_operations
			(id, organization_id, slug, authoring_app_id)
		SELECT site.id, site.organization_id, site.slug, site.authoring_app_id
		FROM cms_sites AS site
		WHERE site.id = ${input.siteId}
			AND site.organization_id = ${input.organizationId}
			AND site.slug = ${input.slug}
			AND site.authoring_app_id IS ${input.authoringAppId}
			AND NOT EXISTS (
				SELECT 1 FROM cms_restore_fences AS fence
				WHERE fence.site_id = site.id
			)
		ON CONFLICT(id) DO NOTHING
		RETURNING id
	`);
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
	const [row] = await db
		.select()
		.from(cmsDeprovisionOperations)
		.where(eq(cmsDeprovisionOperations.id, siteId))
		.limit(1);
	return row ?? null;
}

export async function getCmsDeprovisionOperationForOrganization(
	db: DbQueryClient,
	input: { siteId: string; organizationId: string },
): Promise<CmsDeprovisionOperationRow | null> {
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
	const [row] = await db
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
		.returning();
	return row ?? null;
}

/** Commit the final site removal and durable success receipt in one D1 batch. */
export async function completeCmsDeprovisionOperation(
	db: DbQueryClient,
	input: { siteId: string; organizationId: string; deleted: string[] },
): Promise<CmsDeprovisionOperationRow> {
	const [, updated] = await db.batch([
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
