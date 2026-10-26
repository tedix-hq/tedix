import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type NewOsGadgetRow,
	type OsGadgetCodeRow,
	type OsGadgetRevisionRow,
	type OsGadgetRow,
	osGadgetCode,
	osGadgetRevisions,
	osGadgets,
	osWorkspaces,
} from "../../schema/os-workspaces";
import { prefixedColumns } from "../../utils/select";
import {
	osWorkspaceVisibleToPredicate,
	type OsWorkspaceViewer,
} from "./workspaces";
import { getAffectedRows } from "../../utils/d1-result";

export interface OsGadgetScopeParams {
	organizationId: string;
	gadgetId: string;
}

export interface ListOsGadgetsOptions {
	workspaceId?: string;
	status?: OsGadgetRow["status"];
	limit?: number;
}

export interface UpdateOsGadgetPatch {
	name?: string;
	description?: string | null;
	status?: OsGadgetRow["status"];
}

export interface CreateOsGadgetRevisionParams {
	/** Caller-generated UUID for the new revision row. */
	id: string;
	organizationId: string;
	gadgetId: string;
	/** JSON string: declared capabilities, entry, notes. */
	manifest: string;
	sourceArtifactRef?: string | null;
	createdByKind: OsGadgetRevisionRow["createdByKind"];
	createdById: string;
	/**
	 * Optimistic concurrency guard: when set, the write lands only if the
	 * gadget's highest revision still equals this value.
	 */
	expectedRevision?: number;
	/**
	 * Source files of a runtime app, recorded in the same batch as the
	 * revision; omitted for apps that carry no code.
	 */
	code?: { files: string; codeLength: number };
}

export type CreateOsGadgetRevisionResult =
	| { ok: true; revision: OsGadgetRevisionRow }
	| { ok: false; reason: "gadget_not_found" | "revision_conflict" };

export async function createOsGadget(
	db: DbQueryClient,
	gadget: NewOsGadgetRow,
): Promise<OsGadgetRow> {
	const [row] = await db.insert(osGadgets).values(gadget).returning();
	if (!row) {
		throw new Error("OS gadget insert returned no row");
	}
	return row;
}

export async function getOsGadget(
	db: DbQueryClient,
	params: OsGadgetScopeParams,
): Promise<OsGadgetRow | undefined> {
	const [row] = await db
		.select()
		.from(osGadgets)
		.where(
			and(
				eq(osGadgets.organizationId, params.organizationId),
				eq(osGadgets.id, params.gadgetId),
			),
		)
		.limit(1);
	return row;
}

export async function listOsGadgets(
	db: DbQueryClient,
	organizationId: string,
	options: ListOsGadgetsOptions = {},
): Promise<OsGadgetRow[]> {
	const conditions = [eq(osGadgets.organizationId, organizationId)];
	if (options.workspaceId) {
		conditions.push(eq(osGadgets.workspaceId, options.workspaceId));
	}
	if (options.status) {
		conditions.push(eq(osGadgets.status, options.status));
	}
	return db
		.select()
		.from(osGadgets)
		.where(and(...conditions))
		.orderBy(asc(osGadgets.name))
		.limit(Math.min(Math.max(options.limit ?? 100, 1), 500));
}

export async function updateOsGadget(
	db: DbQueryClient,
	params: OsGadgetScopeParams,
	patch: UpdateOsGadgetPatch,
): Promise<OsGadgetRow | undefined> {
	const [row] = await db
		.update(osGadgets)
		.set({ ...patch, updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(osGadgets.organizationId, params.organizationId),
				eq(osGadgets.id, params.gadgetId),
			),
		)
		.returning();
	return row;
}

export async function deleteOsGadget(
	db: DbQueryClient,
	params: OsGadgetScopeParams,
): Promise<boolean> {
	const result = await db
		.delete(osGadgets)
		.where(
			and(
				eq(osGadgets.organizationId, params.organizationId),
				eq(osGadgets.id, params.gadgetId),
			),
		);
	return getAffectedRows(result) > 0;
}

export async function getOsGadgetRevision(
	db: DbQueryClient,
	params: { organizationId: string; revisionId: string },
): Promise<OsGadgetRevisionRow | undefined> {
	const [row] = await db
		.select()
		.from(osGadgetRevisions)
		.where(
			and(
				eq(osGadgetRevisions.organizationId, params.organizationId),
				eq(osGadgetRevisions.id, params.revisionId),
			),
		)
		.limit(1);
	return row;
}

/** The source files recorded with one revision; undefined when it carries no code. */
export async function getOsGadgetCode(
	db: DbQueryClient,
	params: { organizationId: string; revisionId: string },
): Promise<OsGadgetCodeRow | undefined> {
	const [row] = await db
		.select()
		.from(osGadgetCode)
		.where(
			and(
				eq(osGadgetCode.organizationId, params.organizationId),
				eq(osGadgetCode.revisionId, params.revisionId),
			),
		)
		.limit(1);
	return row;
}

export async function listOsGadgetRevisions(
	db: DbQueryClient,
	params: OsGadgetScopeParams,
	options: { limit?: number } = {},
): Promise<OsGadgetRevisionRow[]> {
	return db
		.select()
		.from(osGadgetRevisions)
		.where(
			and(
				eq(osGadgetRevisions.organizationId, params.organizationId),
				eq(osGadgetRevisions.gadgetId, params.gadgetId),
			),
		)
		.orderBy(desc(osGadgetRevisions.revision))
		.limit(Math.min(Math.max(options.limit ?? 50, 1), 200));
}

/**
 * Append the next gadget revision and advance `current_revision_id`, atomically.
 *
 * D1 has no `db.transaction()`; the whole operation is one `db.batch()`:
 *
 * 1. `INSERT ... SELECT` sourced from the gadget row itself — the insert lands
 *    only when the gadget exists in this organization, computes the revision as
 *    `max(revision) + 1` inside the statement, and (when `expectedRevision` is
 *    given) only when the current highest revision still matches it.
 * 2. The pointer update is fenced on `changes() = 1`, so it applies only when
 *    statement 1 actually inserted.
 *
 * A CAS miss is a typed result, not a throw.
 */
export async function createOsGadgetRevision(
	db: DbQueryClient,
	params: CreateOsGadgetRevisionParams,
): Promise<CreateOsGadgetRevisionResult> {
	const now = new Date().toISOString();
	const currentMaxRevision = sql<number>`coalesce((select max(${osGadgetRevisions.revision}) from ${osGadgetRevisions} where ${osGadgetRevisions.gadgetId} = ${params.gadgetId}), 0)`;
	const sourceConditions = [
		eq(osGadgets.id, params.gadgetId),
		eq(osGadgets.organizationId, params.organizationId),
	];
	if (params.expectedRevision !== undefined) {
		sourceConditions.push(
			sql`${currentMaxRevision} = ${params.expectedRevision}`,
		);
	}
	const insertRevision = db
		.insert(osGadgetRevisions)
		.select(
			db
				.select({
					id: sql<string>`${params.id}`.as("id"),
					organizationId: sql<string>`${params.organizationId}`.as(
						"organization_id",
					),
					gadgetId: sql<string>`${params.gadgetId}`.as("gadget_id"),
					revision: sql<number>`${currentMaxRevision} + 1`.as("revision"),
					manifest: sql<string>`${params.manifest}`.as("manifest"),
					sourceArtifactRef: sql<
						string | null
					>`${params.sourceArtifactRef ?? null}`.as("source_artifact_ref"),
					createdByKind: sql<
						OsGadgetRevisionRow["createdByKind"]
					>`${params.createdByKind}`.as("created_by_kind"),
					createdById: sql<string>`${params.createdById}`.as("created_by_id"),
					createdAt: sql<string>`${now}`.as("created_at"),
				})
				.from(osGadgets)
				.where(and(...sourceConditions)),
		)
		.returning();
	const advancePointer = db
		.update(osGadgets)
		.set({ currentRevisionId: params.id, updatedAt: now })
		.where(
			and(
				eq(osGadgets.id, params.gadgetId),
				eq(osGadgets.organizationId, params.organizationId),
				sql`changes() = 1`,
			),
		);
	// The code row selects from the revision just written, so it lands only
	// when the guarded revision insert did: one batch, no half-recorded app.
	const insertCode = params.code
		? db.insert(osGadgetCode).select(
				db
					.select({
						revisionId: osGadgetRevisions.id,
						organizationId: osGadgetRevisions.organizationId,
						gadgetId: osGadgetRevisions.gadgetId,
						files: sql<string>`${params.code.files}`.as("files"),
						codeLength: sql<number>`${params.code.codeLength}`.as(
							"code_length",
						),
						createdAt: sql<string>`${now}`.as("created_at"),
					})
					.from(osGadgetRevisions)
					.where(eq(osGadgetRevisions.id, params.id)),
			)
		: null;
	const [revisionRows] = insertCode
		? await db.batch([insertRevision, advancePointer, insertCode])
		: await db.batch([insertRevision, advancePointer]);
	const revision = revisionRows[0];
	if (revision) {
		return { ok: true, revision };
	}
	const gadget = await getOsGadget(db, {
		organizationId: params.organizationId,
		gadgetId: params.gadgetId,
	});
	return {
		ok: false,
		reason: gadget ? "revision_conflict" : "gadget_not_found",
	};
}

/** Installed Work apps and their current manifests, authorized before pagination. */
export async function listOsWorkApps(
	db: DbQueryClient,
	organizationId: string,
	viewer: OsWorkspaceViewer,
	limit: number,
) {
	return db
		.select({
			gadget: prefixedColumns(osGadgets, "gadget"),
			revision: prefixedColumns(osGadgetRevisions, "revision"),
		})
		.from(osGadgets)
		.innerJoin(
			osWorkspaces,
			and(
				eq(osWorkspaces.id, osGadgets.workspaceId),
				eq(osWorkspaces.organizationId, organizationId),
			),
		)
		.innerJoin(
			osGadgetRevisions,
			and(
				eq(osGadgetRevisions.id, osGadgets.currentRevisionId),
				eq(osGadgetRevisions.organizationId, organizationId),
				eq(osGadgetRevisions.gadgetId, osGadgets.id),
			),
		)
		.where(
			and(
				eq(osGadgets.organizationId, organizationId),
				eq(osGadgets.status, "active"),
				eq(osWorkspaces.status, "active"),
				osWorkspaceVisibleToPredicate(viewer),
				sql`(json_extract(${osGadgetRevisions.manifest}, '$.navigation.work') IN ('deck', 'feed') OR json_extract(${osGadgetRevisions.manifest}, '$.navigation.board') = 1)`,
			),
		)
		.orderBy(asc(osGadgets.createdAt), asc(osGadgets.id))
		.limit(Math.min(Math.max(limit, 1), 201));
}

/**
 * Active Card review and Decision Deck apps with their current manifests,
 * the apps whose config names factory card sources. With `organizationId`
 * the read is tenant-scoped; without it (the weekly weight job only) it
 * spans organizations, oldest first, and `weightUpdateOnly` keeps apps
 * whose manifest mentions a weight update.
 */
export async function listCardSourceApps(
	db: DbQueryClient,
	params: {
		organizationId?: string;
		weightUpdateOnly?: boolean;
		limit: number;
	},
) {
	return db
		.select({
			gadget: prefixedColumns(osGadgets, "gadget"),
			revision: prefixedColumns(osGadgetRevisions, "revision"),
		})
		.from(osGadgets)
		.innerJoin(
			osGadgetRevisions,
			and(
				eq(osGadgetRevisions.id, osGadgets.currentRevisionId),
				eq(osGadgetRevisions.organizationId, osGadgets.organizationId),
				eq(osGadgetRevisions.gadgetId, osGadgets.id),
			),
		)
		.where(
			and(
				params.organizationId
					? eq(osGadgets.organizationId, params.organizationId)
					: undefined,
				eq(osGadgets.status, "active"),
				sql`json_extract(${osGadgetRevisions.manifest}, '$.entry') IN ('tedix:app/card-review', 'tedix:app/decision-deck')`,
				params.weightUpdateOnly
					? sql`instr(${osGadgetRevisions.manifest}, '"weightUpdate"') > 0`
					: undefined,
			),
		)
		.orderBy(asc(osGadgets.createdAt), asc(osGadgets.id))
		.limit(Math.min(Math.max(params.limit, 1), 500));
}

/**
 * Active runtime apps in active workspaces whose current revision declares
 * triggers, across organizations, oldest first. The trigger tick reads this
 * list and decides per trigger whether it is due.
 */
export async function listTriggeredRuntimeApps(
	db: DbQueryClient,
	params: { limit: number },
) {
	return db
		.select({
			gadget: prefixedColumns(osGadgets, "gadget"),
			revision: prefixedColumns(osGadgetRevisions, "revision"),
		})
		.from(osGadgets)
		.innerJoin(
			osWorkspaces,
			and(
				eq(osWorkspaces.id, osGadgets.workspaceId),
				eq(osWorkspaces.organizationId, osGadgets.organizationId),
			),
		)
		.innerJoin(
			osGadgetRevisions,
			and(
				eq(osGadgetRevisions.id, osGadgets.currentRevisionId),
				eq(osGadgetRevisions.organizationId, osGadgets.organizationId),
				eq(osGadgetRevisions.gadgetId, osGadgets.id),
			),
		)
		.where(
			and(
				eq(osGadgets.status, "active"),
				eq(osWorkspaces.status, "active"),
				sql`json_extract(${osGadgetRevisions.manifest}, '$.entry') = 'tedix:runtime/v1'`,
				sql`json_type(${osGadgetRevisions.manifest}, '$.config.triggers') = 'array'`,
			),
		)
		.orderBy(asc(osGadgets.createdAt), asc(osGadgets.id))
		.limit(Math.min(Math.max(params.limit, 1), 500));
}
