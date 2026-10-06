import { and, desc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type NewOsOutputRevisionRow,
	type NewOsOutputRow,
	type OsOutputRevisionRow,
	type OsOutputRow,
	type OsWorkspaceRow,
	osOutputRevisions,
	osOutputs,
	osWorkspaces,
} from "../../schema/os-workspaces";
import { getAffectedRows } from "../../utils/d1-result";
import { prefixedColumns } from "../../utils/select";
import { mergeOsOutputAccessEnvelopes } from "../../utils/os-output-access-envelope";

export interface OsOutputScopeParams {
	organizationId: string;
	outputId: string;
}

export interface ListOsOutputsOptions {
	workspaceId?: string;
	kind?: OsOutputRow["kind"];
	status?: OsOutputRow["status"];
	limit?: number;
}

export interface UpdateOsOutputPatch {
	title?: string;
	status?: OsOutputRow["status"];
}

export interface OsOutputLibraryRow {
	output: OsOutputRow;
	revision: OsOutputRevisionRow;
	workspace: OsWorkspaceRow | null;
}

export interface CreateOsOutputRevisionParams {
	/** Caller-generated UUID for the new revision row. */
	id: string;
	organizationId: string;
	outputId: string;
	/** JSON string: the semantic content body. */
	content: string;
	note?: string | null;
	createdByKind: OsOutputRevisionRow["createdByKind"];
	createdById: string;
	/**
	 * Producer lineage forwarded by the workflow bridge. Null for a
	 * human-authored revision; never inferred from the caller principal.
	 */
	skillRunId?: string | null;
	skillId?: string | null;
	/** JSON OsDerivedAccessEnvelope; null is legacy/unverifiable. */
	accessEnvelope?: string | null;
	/**
	 * Additional caller precondition: when set, the captured current revision
	 * must also equal this value. Every append is independently CAS-fenced on
	 * the exact base revision whose access envelope it inherits.
	 */
	expectedRevision?: number;
}

export type CreateOsOutputRevisionResult =
	| { ok: true; revision: OsOutputRevisionRow }
	| { ok: false; reason: "output_not_found" | "revision_conflict" };

/**
 * Create an output with its revision-1 body in one atomic `db.batch()`. Both
 * ids are caller-generated, so the output row is inserted with
 * `current_revision_id` already pointing at the revision row.
 */
export async function createOsOutput(
	db: DbQueryClient,
	output: NewOsOutputRow,
	revision: NewOsOutputRevisionRow,
): Promise<{ output: OsOutputRow; revision: OsOutputRevisionRow }> {
	const [outputRows, revisionRows] = await db.batch([
		db.insert(osOutputs).values(output).returning(),
		db.insert(osOutputRevisions).values(revision).returning(),
	]);
	const outputRow = outputRows[0];
	const revisionRow = revisionRows[0];
	if (!outputRow || !revisionRow) {
		throw new Error("OS output insert returned no row");
	}
	return { output: outputRow, revision: revisionRow };
}

export async function getOsOutput(
	db: DbQueryClient,
	params: OsOutputScopeParams,
): Promise<OsOutputRow | undefined> {
	const [row] = await db
		.select()
		.from(osOutputs)
		.where(
			and(
				eq(osOutputs.organizationId, params.organizationId),
				eq(osOutputs.id, params.outputId),
			),
		)
		.limit(1);
	return row;
}

export async function listOsOutputs(
	db: DbQueryClient,
	organizationId: string,
	options: ListOsOutputsOptions = {},
): Promise<OsOutputRow[]> {
	const conditions = [eq(osOutputs.organizationId, organizationId)];
	if (options.workspaceId) {
		conditions.push(eq(osOutputs.workspaceId, options.workspaceId));
	}
	if (options.kind) {
		conditions.push(eq(osOutputs.kind, options.kind));
	}
	if (options.status) {
		conditions.push(eq(osOutputs.status, options.status));
	}
	return db
		.select()
		.from(osOutputs)
		.where(and(...conditions))
		.orderBy(desc(osOutputs.updatedAt), desc(osOutputs.id))
		.limit(Math.min(Math.max(options.limit ?? 100, 1), 500));
}

/**
 * Read Outputs-library cards in one D1-safe query. The workspace join is
 * deliberately optional and never filters workspace lifecycle: outputs are
 * durable deliverables and remain visible after their grouping workspace is
 * archived (or no longer exists).
 */
export async function listOsOutputLibraryRows(
	db: DbQueryClient,
	organizationId: string,
	options: Pick<
		ListOsOutputsOptions,
		"workspaceId" | "kind" | "status" | "limit"
	> = {},
): Promise<OsOutputLibraryRow[]> {
	const conditions = [eq(osOutputs.organizationId, organizationId)];
	if (options.workspaceId) {
		conditions.push(eq(osOutputs.workspaceId, options.workspaceId));
	}
	if (options.kind) conditions.push(eq(osOutputs.kind, options.kind));
	if (options.status) conditions.push(eq(osOutputs.status, options.status));
	const rows = await db
		.select({
			output: prefixedColumns(osOutputs, "output"),
			revision: prefixedColumns(osOutputRevisions, "revision"),
			workspace: prefixedColumns(osWorkspaces, "workspace"),
		})
		.from(osOutputs)
		.innerJoin(
			osOutputRevisions,
			and(
				eq(osOutputRevisions.id, osOutputs.currentRevisionId),
				eq(osOutputRevisions.organizationId, organizationId),
			),
		)
		.leftJoin(
			osWorkspaces,
			and(
				eq(osWorkspaces.id, osOutputs.workspaceId),
				eq(osWorkspaces.organizationId, organizationId),
			),
		)
		.where(and(...conditions))
		.orderBy(desc(osOutputs.updatedAt), desc(osOutputs.id))
		.limit(Math.min(Math.max(options.limit ?? 100, 1), 500));
	return rows.map((row) => ({
		output: row.output as OsOutputRow,
		revision: row.revision as OsOutputRevisionRow,
		workspace:
			row.workspace.id === null
				? null
				: (row.workspace as unknown as OsWorkspaceRow),
	}));
}

export async function updateOsOutput(
	db: DbQueryClient,
	params: OsOutputScopeParams,
	patch: UpdateOsOutputPatch,
): Promise<OsOutputRow | undefined> {
	const [row] = await db
		.update(osOutputs)
		.set({ ...patch, updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(osOutputs.organizationId, params.organizationId),
				eq(osOutputs.id, params.outputId),
			),
		)
		.returning();
	return row;
}

export async function deleteOsOutput(
	db: DbQueryClient,
	params: OsOutputScopeParams,
): Promise<boolean> {
	const result = await db
		.delete(osOutputs)
		.where(
			and(
				eq(osOutputs.organizationId, params.organizationId),
				eq(osOutputs.id, params.outputId),
			),
		);
	return getAffectedRows(result) > 0;
}

export async function getOsOutputRevision(
	db: DbQueryClient,
	params: { organizationId: string; revisionId: string },
): Promise<OsOutputRevisionRow | undefined> {
	const [row] = await db
		.select()
		.from(osOutputRevisions)
		.where(
			and(
				eq(osOutputRevisions.organizationId, params.organizationId),
				eq(osOutputRevisions.id, params.revisionId),
			),
		)
		.limit(1);
	return row;
}

/** Resolve one immutable revision by its per-output display number. */
export async function getOsOutputRevisionByNumber(
	db: DbQueryClient,
	params: { organizationId: string; outputId: string; revision: number },
): Promise<OsOutputRevisionRow | undefined> {
	const [row] = await db
		.select()
		.from(osOutputRevisions)
		.where(
			and(
				eq(osOutputRevisions.organizationId, params.organizationId),
				eq(osOutputRevisions.outputId, params.outputId),
				eq(osOutputRevisions.revision, params.revision),
			),
		)
		.limit(1);
	return row;
}

export async function listOsOutputRevisions(
	db: DbQueryClient,
	params: OsOutputScopeParams,
	options: { limit?: number } = {},
): Promise<OsOutputRevisionRow[]> {
	return db
		.select()
		.from(osOutputRevisions)
		.where(
			and(
				eq(osOutputRevisions.organizationId, params.organizationId),
				eq(osOutputRevisions.outputId, params.outputId),
			),
		)
		.orderBy(desc(osOutputRevisions.revision))
		.limit(Math.min(Math.max(options.limit ?? 50, 1), 200));
}

/**
 * Append the next output revision and advance `current_revision_id`,
 * atomically — the same single-batch INSERT..SELECT shape as gadget
 * revisions: existence, tenant scope, and the expectedRevision CAS resolve
 * inside statement 1, and the pointer update is fenced on `changes() = 1`.
 * When the caller omits expectedRevision, the captured current revision is
 * used so a concurrent append cannot drop its lineage. A CAS miss is a typed
 * result, not a throw.
 */
export async function createOsOutputRevision(
	db: DbQueryClient,
	params: CreateOsOutputRevisionParams,
): Promise<CreateOsOutputRevisionResult> {
	const now = new Date().toISOString();
	const [base] = await db
		.select({
			id: osOutputRevisions.id,
			revision: osOutputRevisions.revision,
			accessEnvelope: osOutputRevisions.accessEnvelope,
		})
		.from(osOutputs)
		.innerJoin(
			osOutputRevisions,
			and(
				eq(osOutputRevisions.id, osOutputs.currentRevisionId),
				eq(osOutputRevisions.organizationId, params.organizationId),
				eq(osOutputRevisions.outputId, osOutputs.id),
			),
		)
		.where(
			and(
				eq(osOutputs.id, params.outputId),
				eq(osOutputs.organizationId, params.organizationId),
			),
		)
		.limit(1);
	if (!base) return { ok: false, reason: "output_not_found" };
	if (
		params.expectedRevision !== undefined &&
		params.expectedRevision !== base.revision
	) {
		return { ok: false, reason: "revision_conflict" };
	}
	const accessEnvelope = mergeOsOutputAccessEnvelopes(
		base.accessEnvelope,
		params.accessEnvelope,
	);
	const currentMaxRevision = sql<number>`coalesce((select max(${osOutputRevisions.revision}) from ${osOutputRevisions} where ${osOutputRevisions.outputId} = ${params.outputId}), 0)`;
	const sourceConditions = [
		eq(osOutputs.id, params.outputId),
		eq(osOutputs.organizationId, params.organizationId),
		eq(osOutputs.currentRevisionId, base.id),
		sql`${currentMaxRevision} = ${base.revision}`,
	];
	const insertRevision = db
		.insert(osOutputRevisions)
		.select(
			db
				.select({
					id: sql<string>`${params.id}`.as("id"),
					organizationId: sql<string>`${params.organizationId}`.as(
						"organization_id",
					),
					outputId: sql<string>`${params.outputId}`.as("output_id"),
					revision: sql<number>`${currentMaxRevision} + 1`.as("revision"),
					content: sql<string>`${params.content}`.as("content"),
					note: sql<string | null>`${params.note ?? null}`.as("note"),
					createdByKind: sql<
						OsOutputRevisionRow["createdByKind"]
					>`${params.createdByKind}`.as("created_by_kind"),
					createdById: sql<string>`${params.createdById}`.as("created_by_id"),
					createdAt: sql<string>`${now}`.as("created_at"),
					// Positional bind: this is an INSERT..SELECT with no column list,
					// so these must stay last, matching the appended physical columns.
					skillRunId: sql<string | null>`${params.skillRunId ?? null}`.as(
						"skill_run_id",
					),
					skillId: sql<string | null>`${params.skillId ?? null}`.as("skill_id"),
					accessEnvelope: sql<string | null>`${accessEnvelope}`.as(
						"access_envelope",
					),
				})
				.from(osOutputs)
				.where(and(...sourceConditions)),
		)
		.returning();
	const advancePointer = db
		.update(osOutputs)
		.set({ currentRevisionId: params.id, updatedAt: now })
		.where(
			and(
				eq(osOutputs.id, params.outputId),
				eq(osOutputs.organizationId, params.organizationId),
				sql`changes() = 1`,
			),
		);
	const [revisionRows] = await db.batch([insertRevision, advancePointer]);
	const revision = revisionRows[0];
	if (revision) {
		return { ok: true, revision };
	}
	const output = await getOsOutput(db, {
		organizationId: params.organizationId,
		outputId: params.outputId,
	});
	return {
		ok: false,
		reason: output ? "revision_conflict" : "output_not_found",
	};
}
