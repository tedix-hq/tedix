import { osGadgetHasWorkNavigation } from "./gadget-navigation";
import { and, asc, desc, eq, getColumns, sql } from "drizzle-orm";
import { coreTable } from "../../core-store/client";
import {
	changedRows,
	containsText,
	coreStore,
	jsonRead,
	jsonWrite,
} from "../../core-store/dialect";
import type { DbQueryClient } from "../../query-client";
import {
	type NewOsGadgetRow,
	type OsGadgetCodeRow,
	type OsGadgetRevisionRow,
	type OsGadgetRow,
	osGadgetCode as d1OsGadgetCode,
	osGadgetCodeBlobs as d1OsGadgetCodeBlobs,
	osGadgetRevisions as d1OsGadgetRevisions,
	osGadgetExecutions as d1OsGadgetExecutions,
	osGadgets as d1OsGadgets,
	osWorkspaces as d1OsWorkspaces,
} from "../../schema/os-workspaces";
import {
	buildOsGadgetRevisionCodeStatements,
	osGadgetCodeSha256,
} from "./gadget-code";
import { prefixedColumns } from "../../utils/select";
import {
	osWorkspaceVisibleToPredicate,
	type OsWorkspaceViewer,
} from "./workspaces";
import { osGadgetHasRuntimeTriggers } from "./gadget-triggers";

export interface OsGadgetScopeParams {
	organizationId: string;
	gadgetId: string;
}

/** Update one switch without overwriting a concurrent choice for another trigger. */
export async function setOsAppTriggerEnabled(
	db: DbQueryClient,
	params: OsGadgetScopeParams & {
		workspaceId: string;
		revisionId: string;
		triggerId: string;
		enabled: boolean;
		/** What the trigger does now (`appTriggerDefinition`); the choice lapses when it changes. */
		definition: string;
	},
) {
	const osGadgets = coreTable(db, d1OsGadgets);
	const choice = { enabled: params.enabled, definition: params.definition };
	const [row] = await db
		.update(osGadgets)
		.set({
			triggerEnabled: jsonWrite(
				db,
				osGadgets.triggerEnabled,
				[params.triggerId],
				choice,
			),
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(osGadgets.organizationId, params.organizationId),
				eq(osGadgets.workspaceId, params.workspaceId),
				eq(osGadgets.id, params.gadgetId),
				eq(osGadgets.currentRevisionId, params.revisionId),
				eq(osGadgets.status, "active"),
			),
		)
		.returning();
	return row;
}

export async function lastOsAppTriggerRuns(
	db: DbQueryClient,
	params: OsGadgetScopeParams,
) {
	const osGadgetExecutions = coreTable(db, d1OsGadgetExecutions);
	const triggerId =
		coreStore(db) === "postgres"
			? sql<string>`${osGadgetExecutions.policyDecision}::jsonb #>> '{trigger,id}'`
			: sql<string>`json_extract(${osGadgetExecutions.policyDecision}, '$.trigger.id')`;
	return db
		.select({
			triggerId,
			lastRunAt: sql<string>`max(${osGadgetExecutions.createdAt})`,
		})
		.from(osGadgetExecutions)
		.where(
			and(
				eq(osGadgetExecutions.organizationId, params.organizationId),
				eq(osGadgetExecutions.gadgetId, params.gadgetId),
				sql`${triggerId} IS NOT NULL`,
			),
		)
		.groupBy(triggerId);
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
	sourceBlueprintRevisionId?: string;
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
	const osGadgets = coreTable(db, d1OsGadgets);
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
	const osGadgets = coreTable(db, d1OsGadgets);
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
	const osGadgets = coreTable(db, d1OsGadgets);
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
	const osGadgets = coreTable(db, d1OsGadgets);
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

export async function restoreOsGadget(
	db: DbQueryClient,
	params: OsGadgetScopeParams,
): Promise<OsGadgetRow | undefined> {
	const osGadgets = coreTable(db, d1OsGadgets);
	const [row] = await db
		.update(osGadgets)
		.set({ status: "active", updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(osGadgets.organizationId, params.organizationId),
				eq(osGadgets.id, params.gadgetId),
				eq(osGadgets.status, "archived"),
			),
		)
		.returning();
	return row ?? getOsGadget(db, params);
}

export async function deleteOsGadget(
	db: DbQueryClient,
	params: OsGadgetScopeParams,
): Promise<boolean> {
	const osGadgets = coreTable(db, d1OsGadgets);
	const result = await db
		.delete(osGadgets)
		.where(
			and(
				eq(osGadgets.organizationId, params.organizationId),
				eq(osGadgets.id, params.gadgetId),
			),
		)
		.returning({ id: osGadgets.id });
	return changedRows(result) > 0;
}

export async function getOsGadgetRevision(
	db: DbQueryClient,
	params: { organizationId: string; revisionId: string },
): Promise<OsGadgetRevisionRow | undefined> {
	const osGadgetRevisions = coreTable(db, d1OsGadgetRevisions);
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

/**
 * The source files recorded with one revision; undefined when it carries no
 * code. The files come from the shared blob the row points at.
 */
export async function getOsGadgetCode(
	db: DbQueryClient,
	params: { organizationId: string; revisionId: string },
): Promise<OsGadgetCodeRow | undefined> {
	const osGadgetCode = coreTable(db, d1OsGadgetCode);
	const osGadgetCodeBlobs = coreTable(db, d1OsGadgetCodeBlobs);
	const [row] = await db
		.select({
			revisionId: osGadgetCode.revisionId,
			organizationId: osGadgetCode.organizationId,
			gadgetId: osGadgetCode.gadgetId,
			codeLength: osGadgetCode.codeLength,
			createdAt: osGadgetCode.createdAt,
			filesSha256: osGadgetCode.filesSha256,
			blobFiles: sql<string | null>`${osGadgetCodeBlobs.files}`.as(
				"blob_files",
			),
		})
		.from(osGadgetCode)
		.leftJoin(
			osGadgetCodeBlobs,
			and(
				eq(osGadgetCodeBlobs.organizationId, osGadgetCode.organizationId),
				eq(osGadgetCodeBlobs.sha256, osGadgetCode.filesSha256),
			),
		)
		.where(
			and(
				eq(osGadgetCode.organizationId, params.organizationId),
				eq(osGadgetCode.revisionId, params.revisionId),
			),
		)
		.limit(1);
	if (!row) return undefined;
	const { blobFiles, ...code } = row;
	if (blobFiles === null)
		throw new Error(`Gadget code files are missing for ${code.revisionId}`);
	return { ...code, files: blobFiles };
}

/**
 * The hash of one revision's files without the files themselves, so a caller
 * that already holds that content skips the large read. Null for a row
 * written before the files were shared: it has no stored hash.
 */
export async function getOsGadgetCodeHash(
	db: DbQueryClient,
	params: { organizationId: string; revisionId: string },
): Promise<
	| { filesSha256: string | null; codeLength: number; createdAt: string }
	| undefined
> {
	const osGadgetCode = coreTable(db, d1OsGadgetCode);
	const [row] = await db
		.select({
			filesSha256: osGadgetCode.filesSha256,
			codeLength: osGadgetCode.codeLength,
			createdAt: osGadgetCode.createdAt,
		})
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
	const osGadgetRevisions = coreTable(db, d1OsGadgetRevisions);
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
 * 2. The pointer and code writes select the revision just inserted. Postgres
 *    first locks the gadget row in that same batch to serialize revision writers.
 *
 * A CAS miss is a typed result, not a throw.
 */
export async function createOsGadgetRevision(
	db: DbQueryClient,
	params: CreateOsGadgetRevisionParams,
): Promise<CreateOsGadgetRevisionResult> {
	const osGadgets = coreTable(db, d1OsGadgets);
	const osGadgetRevisions = coreTable(db, d1OsGadgetRevisions);
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
	if (coreStore(db) === "postgres") {
		const osGadgetCode = coreTable(db, d1OsGadgetCode);
		const osGadgetCodeBlobs = coreTable(db, d1OsGadgetCodeBlobs);
		const codeHash = params.code
			? await osGadgetCodeSha256(params.code.files)
			: null;
		const inserted = db
			.$with("inserted", getColumns(osGadgetRevisions))
			.as(insertRevision.getSQL());
		const advanced = db.$with("advanced", { id: osGadgets.id }).as(
			db
				.update(osGadgets)
				.set({
					currentRevisionId: params.id,
					hasRuntimeTriggers: osGadgetHasRuntimeTriggers(params.manifest),
					hasWorkNavigation: osGadgetHasWorkNavigation(params.manifest),
					updatedAt: now,
					...(params.sourceBlueprintRevisionId
						? { sourceBlueprintRevisionId: params.sourceBlueprintRevisionId }
						: {}),
				})
				.from(inserted)
				.where(
					and(
						eq(osGadgets.id, inserted.gadgetId),
						eq(osGadgets.organizationId, inserted.organizationId),
					),
				)
				.returning({ id: osGadgets.id })
				.getSQL(),
		);
		const codeCtes = params.code
			? [
					db.$with("blobs", { sha256: osGadgetCodeBlobs.sha256 }).as(
						db
							.insert(osGadgetCodeBlobs)
							.select(
								db
									.select({
										organizationId: inserted.organizationId,
										sha256: sql<string>`${codeHash}`.as("sha256"),
										files: sql<string>`${params.code.files}`.as("files"),
										codeLength: sql<number>`${params.code.codeLength}`.as(
											"code_length",
										),
										createdAt: sql<string>`${now}`.as("created_at"),
									})
									.from(inserted),
							)
							.onConflictDoNothing()
							.returning({ sha256: osGadgetCodeBlobs.sha256 })
							.getSQL(),
					),
					db.$with("code", { revisionId: osGadgetCode.revisionId }).as(
						db
							.insert(osGadgetCode)
							.select(
								db
									.select({
										revisionId: inserted.id,
										organizationId: inserted.organizationId,
										gadgetId: inserted.gadgetId,
										files: sql<string>`''`.as("files"),
										codeLength: sql<number>`${params.code.codeLength}`.as(
											"code_length",
										),
										createdAt: sql<string>`${now}`.as("created_at"),
										filesSha256: sql<string>`${codeHash}`.as("files_sha256"),
									})
									.from(inserted),
							)
							.returning({ revisionId: osGadgetCode.revisionId })
							.getSQL(),
					),
				]
			: [];
		// Only this statement's inserted rows may advance pointers or write code;
		// finding an older row with the same id is not proof that this CAS won.
		const write = db
			.with(inserted, advanced, ...codeCtes)
			.select()
			.from(inserted);
		const lockQuery = db
			.select({ id: osGadgets.id })
			.from(osGadgets)
			.where(
				and(
					eq(osGadgets.id, params.gadgetId),
					eq(osGadgets.organizationId, params.organizationId),
				),
			);
		// The shared boundary retains SQLite types; this branch is a native Pg builder.
		const lock = (
			lockQuery as typeof lockQuery & {
				for(strength: "update"): typeof lockQuery;
			}
		).for("update");
		const [, revisionRows] = await db.batch([lock, write]);
		const revision = revisionRows[0];
		if (revision) return { ok: true, revision };
		const gadget = await getOsGadget(db, params);
		return {
			ok: false,
			reason: gadget ? "revision_conflict" : "gadget_not_found",
		};
	}
	const advancePointer = db
		.update(osGadgets)
		.set({
			currentRevisionId: params.id,
			hasRuntimeTriggers: osGadgetHasRuntimeTriggers(params.manifest),
			hasWorkNavigation: osGadgetHasWorkNavigation(params.manifest),
			updatedAt: now,
			...(params.sourceBlueprintRevisionId
				? { sourceBlueprintRevisionId: params.sourceBlueprintRevisionId }
				: {}),
		})
		.where(
			and(
				eq(osGadgets.id, params.gadgetId),
				eq(osGadgets.organizationId, params.organizationId),
				sql`changes() = 1`,
			),
		);
	// The code statements select from the revision just written, so they land
	// only when the guarded revision insert did: one batch, no half-recorded app.
	const codeStatements = params.code
		? buildOsGadgetRevisionCodeStatements(db, {
				...params.code,
				revisionId: params.id,
				sha256: await osGadgetCodeSha256(params.code.files),
				createdAt: now,
				guardD1PreviousWrite: true,
			})
		: null;
	const writes = codeStatements
		? ([insertRevision, advancePointer, ...codeStatements] as const)
		: ([insertRevision, advancePointer] as const);
	const revisionRows = (await db.batch(writes))[0];
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
	workspaceId?: string,
) {
	const osGadgets = coreTable(db, d1OsGadgets);
	const osGadgetRevisions = coreTable(db, d1OsGadgetRevisions);
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
	// CROSS JOIN keeps the ordered gadget seek ahead of workspace and revision lookups.
	return db
		.select({
			gadget: prefixedColumns(osGadgets, "gadget"),
			revision: prefixedColumns(osGadgetRevisions, "revision"),
		})
		.from(osGadgets)
		.crossJoin(osWorkspaces)
		.crossJoin(osGadgetRevisions)
		.where(
			and(
				eq(osWorkspaces.id, osGadgets.workspaceId),
				eq(osWorkspaces.organizationId, organizationId),
				eq(osGadgetRevisions.id, osGadgets.currentRevisionId),
				coreStore(db) === "postgres"
					? eq(osGadgetRevisions.organizationId, organizationId)
					: sql`+${osGadgetRevisions.organizationId} = ${organizationId}`,
				coreStore(db) === "postgres"
					? eq(osGadgetRevisions.gadgetId, osGadgets.id)
					: sql`+${osGadgetRevisions.gadgetId} = ${osGadgets.id}`,
				eq(osGadgets.organizationId, organizationId),
				eq(osGadgets.status, "active"),
				workspaceId ? eq(osGadgets.workspaceId, workspaceId) : undefined,
				eq(osWorkspaces.status, "active"),
				osWorkspaceVisibleToPredicate(viewer, db),
				eq(osGadgets.hasWorkNavigation, true),
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
	const osGadgets = coreTable(db, d1OsGadgets);
	const osGadgetRevisions = coreTable(db, d1OsGadgetRevisions);
	const manifest =
		coreStore(db) === "postgres"
			? sql`${osGadgetRevisions.manifest}::jsonb`
			: osGadgetRevisions.manifest;
	const entry = jsonRead(db, manifest, ["entry"]);
	const workView = jsonRead(db, manifest, ["config", "settings", "workView"]);
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
				sql`(${entry} IN ('tedix:app/card-review', 'tedix:app/decision-deck') OR (${entry} = 'tedix:runtime/v1' AND ${workView} = 'deck'))`,
				params.weightUpdateOnly
					? containsText(db, osGadgetRevisions.manifest, '"weightUpdate"')
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
	const osGadgets = coreTable(db, d1OsGadgets);
	const osGadgetRevisions = coreTable(db, d1OsGadgetRevisions);
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
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
				// Keep the revision-id seek: an app's revision history is unbounded.
				coreStore(db) === "postgres"
					? eq(osGadgetRevisions.gadgetId, osGadgets.id)
					: sql`+${osGadgetRevisions.gadgetId} = ${osGadgets.id}`,
			),
		)
		.where(
			and(
				eq(osGadgets.status, "active"),
				eq(osWorkspaces.status, "active"),
				eq(osGadgets.hasRuntimeTriggers, true),
			),
		)
		.orderBy(asc(osGadgets.createdAt), asc(osGadgets.id))
		.limit(Math.min(Math.max(params.limit, 1), 500));
}
