/**
 * Tenant-store variant of `../os-workspaces/outputs.ts`.
 *
 * Same tables, same row shapes, same visibility and lineage semantics; the
 * differences are exactly the ones the storage plane imposes:
 *
 * - Atomic multi-statement writes use `db.transaction()` (`transactionSync`
 *   on the DO), which D1 cannot do, instead of `db.batch()`. Transaction
 *   callbacks are synchronous: statements resolve through `.all()`/`.run()`,
 *   not `await`, so nothing suspends past the commit.
 * - Bodies stay in R2. Revision writes require `bodyR2Key` plus the caller's
 *   `contentSha256`/`contentBytes` — this plane never holds body bytes, so
 *   `content` is persisted as the empty string, matching how R2-offloaded
 *   rows already look on the platform plane.
 * - No log-store reads: a workspace store is one SQLite file, not a
 *   partitioned ledger.
 */

import { and, desc, eq, getColumns, sql } from "drizzle-orm";
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
import { prefixedColumns } from "../../utils/select";
import { mergeOsOutputAccessEnvelopes } from "../../utils/os-output-access-envelope";
import {
	type OsWorkspaceViewer,
	osWorkspaceChildVisibleToPredicate,
} from "../os-workspaces/workspaces";
import { hasSharedWorkspaceOutputs } from "../os-workspaces/outputs";
import type { TenantStoreDb } from "./tenant-store";

/** Imported workspaces own their rows; transfer destinations may have only output rows. */
export async function hasWorkspaceOutputAuthority(
	db: TenantStoreDb,
	scope: { organizationId: string; workspaceId: string },
	core: DbQueryClient,
): Promise<boolean> {
	const imported = db
		.select({ id: osWorkspaces.id })
		.from(osWorkspaces)
		.where(
			and(
				eq(osWorkspaces.organizationId, scope.organizationId),
				eq(osWorkspaces.id, scope.workspaceId),
			),
		)
		.get();
	if (imported) return true;
	const local = db
		.select({ id: osOutputs.id })
		.from(osOutputs)
		.where(
			and(
				eq(osOutputs.organizationId, scope.organizationId),
				eq(osOutputs.workspaceId, scope.workspaceId),
			),
		)
		.limit(1)
		.get();
	return Boolean(local) && !(await hasSharedWorkspaceOutputs(core, scope));
}

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
	workspaceId?: string;
}

export interface OsOutputLibraryRow {
	output: OsOutputRow;
	revision: OsOutputRevisionMetadataRow;
	workspace: OsWorkspaceRow | null;
}

/**
 * Tenant-plane revision append. `content` is absent by design: the body the
 * caller uploaded to R2 is described by `bodyR2Key`, `contentSha256`, and
 * `contentBytes`, all three required because this layer never sees the bytes.
 */
export interface CreateOsOutputRevisionParams {
	/** Caller-generated UUID for the new revision row. */
	id: string;
	organizationId: string;
	outputId: string;
	/** R2 object key holding the immutable body. */
	bodyR2Key: string;
	/** Hex SHA-256 of the exact R2 bytes, computed by the uploader. */
	contentSha256: string;
	/** Byte size of the R2 object. */
	contentBytes: number;
	note?: string | null;
	createdByKind: OsOutputRevisionRow["createdByKind"];
	createdById: string;
	/** Producer lineage forwarded by the workflow bridge; null for human edits. */
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
 * Create an output with its revision-1 pointer in one `transactionSync`.
 * `revision.bodyR2Key` is required: bodies stay in R2 on this plane, so the
 * stored `content` is always the empty string.
 */
export async function createOsOutput(
	db: TenantStoreDb,
	output: NewOsOutputRow,
	revision: NewOsOutputRevisionRow,
): Promise<{ output: OsOutputRow; revision: OsOutputRevisionRow }> {
	if (!revision.bodyR2Key) {
		throw new Error(
			"TENANT_STORE_OUTPUT_BODY_INLINE: revision bodies live in R2; bodyR2Key is required.",
		);
	}
	const { outputRow, revisionRow } = db.transaction((tx) => {
		const outputRows = tx.insert(osOutputs).values(output).returning().all();
		const revisionRows = tx
			.insert(osOutputRevisions)
			.values({ ...revision, content: "" })
			.returning()
			.all();
		return { outputRow: outputRows[0], revisionRow: revisionRows[0] };
	});
	if (!outputRow || !revisionRow) {
		throw new Error("OS output insert returned no row");
	}
	return { output: outputRow, revision: revisionRow };
}

export async function getOsOutput(
	db: TenantStoreDb,
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

/**
 * A workspace's newest active sheet with exactly this title, with its current
 * revision. Server jobs use it to find a configured sheet by name, such as a
 * factory source's rules sheet.
 */
export async function getActiveSheetByTitle(
	db: TenantStoreDb,
	params: { organizationId: string; workspaceId: string; title: string },
): Promise<{ output: OsOutputRow; revision: OsOutputRevisionRow } | undefined> {
	const rows = db
		.select({
			output: prefixedColumns(osOutputs, "output"),
			revision: prefixedColumns(osOutputRevisions, "revision"),
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
				eq(osOutputs.organizationId, params.organizationId),
				eq(osOutputs.workspaceId, params.workspaceId),
				eq(osOutputs.kind, "sheet"),
				eq(osOutputs.status, "active"),
				eq(osOutputs.title, params.title),
			),
		)
		.orderBy(desc(osOutputs.updatedAt), desc(osOutputs.id))
		.limit(1)
		.all();
	return rows[0];
}

export async function listOsOutputs(
	db: TenantStoreDb,
	organizationId: string,
	viewer: OsWorkspaceViewer,
	options: ListOsOutputsOptions = {},
): Promise<OsOutputRow[]> {
	const conditions = [
		eq(osOutputs.organizationId, organizationId),
		// The db argument only constructs the hidden-workspace subquery; the SQL
		// it emits is client-agnostic, so the platform predicate signature is
		// satisfied with this module's client.
		osWorkspaceChildVisibleToPredicate(
			db as unknown as DbQueryClient,
			organizationId,
			osOutputs.workspaceId,
			viewer,
		),
	];
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
 * Read Outputs-library cards in one query. The workspace join is deliberately
 * optional and never filters workspace lifecycle: outputs are durable
 * deliverables and remain visible after their grouping workspace is archived
 * (or no longer exists).
 */
export async function listOsOutputLibraryRows(
	db: TenantStoreDb,
	organizationId: string,
	viewer: OsWorkspaceViewer,
	options: Pick<
		ListOsOutputsOptions,
		"workspaceId" | "kind" | "status" | "limit"
	> = {},
): Promise<OsOutputLibraryRow[]> {
	const conditions = [
		eq(osOutputs.organizationId, organizationId),
		osWorkspaceChildVisibleToPredicate(
			db as unknown as DbQueryClient,
			organizationId,
			osOutputs.workspaceId,
			viewer,
		),
	];
	if (options.workspaceId) {
		conditions.push(eq(osOutputs.workspaceId, options.workspaceId));
	}
	if (options.kind) conditions.push(eq(osOutputs.kind, options.kind));
	if (options.status) conditions.push(eq(osOutputs.status, options.status));
	const { content: _content, ...revisionMetadata } = prefixedColumns(
		osOutputRevisions,
		"revision",
	);
	const rows = db
		.select({
			output: prefixedColumns(osOutputs, "output"),
			revision: revisionMetadata,
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
		.limit(Math.min(Math.max(options.limit ?? 100, 1), 500))
		.all();
	return rows.map((row) => ({
		output: row.output as OsOutputRow,
		revision: row.revision as OsOutputRevisionMetadataRow,
		workspace:
			row.workspace.id === null
				? null
				: (row.workspace as unknown as OsWorkspaceRow),
	}));
}

export async function updateOsOutput(
	db: TenantStoreDb,
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

/**
 * Delete the output and its revisions in one transaction. Revisions are
 * deleted explicitly: DO SQLite does not enforce foreign keys by default, so
 * the cascade the platform plane relies on is expressed here as the second
 * statement.
 */
export async function deleteOsOutput(
	db: TenantStoreDb,
	params: OsOutputScopeParams,
): Promise<boolean> {
	return db.transaction((tx) => {
		tx.delete(osOutputRevisions)
			.where(
				and(
					eq(osOutputRevisions.organizationId, params.organizationId),
					eq(osOutputRevisions.outputId, params.outputId),
				),
			)
			.run();
		const deleted = tx
			.delete(osOutputs)
			.where(
				and(
					eq(osOutputs.organizationId, params.organizationId),
					eq(osOutputs.id, params.outputId),
				),
			)
			.returning({ id: osOutputs.id })
			.all();
		return deleted.length > 0;
	});
}

export async function getOsOutputRevision(
	db: TenantStoreDb,
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
	db: TenantStoreDb,
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

/**
 * Point one revision at a rewritten copy of its body. Only the migration that
 * moves embedded images out of stored bodies calls this; the fence is the
 * digest of the body the revision had.
 */
export async function replaceOsOutputRevisionBody(
	db: TenantStoreDb,
	params: {
		organizationId: string;
		revisionId: string;
		previousSha256: string;
		bodyR2Key: string;
		contentSha256: string;
		contentBytes: number;
	},
): Promise<boolean> {
	const changed = await db
		.update(osOutputRevisions)
		.set({
			bodyR2Key: params.bodyR2Key,
			contentSha256: params.contentSha256,
			contentBytes: params.contentBytes,
		})
		.where(
			and(
				eq(osOutputRevisions.organizationId, params.organizationId),
				eq(osOutputRevisions.id, params.revisionId),
				eq(osOutputRevisions.contentSha256, params.previousSha256),
			),
		)
		.returning({ id: osOutputRevisions.id });
	return changed.length === 1;
}

export type OsOutputRevisionMetadataRow = Omit<OsOutputRevisionRow, "content">;

export async function listOsOutputRevisions(
	db: TenantStoreDb,
	params: OsOutputScopeParams,
	options: { limit?: number; beforeRevision?: number } = {},
): Promise<OsOutputRevisionMetadataRow[]> {
	const { content: _content, ...metadata } = getColumns(osOutputRevisions);
	return db
		.select(metadata)
		.from(osOutputRevisions)
		.where(
			and(
				eq(osOutputRevisions.organizationId, params.organizationId),
				eq(osOutputRevisions.outputId, params.outputId),
				options.beforeRevision
					? sql`${osOutputRevisions.revision}<${options.beforeRevision}`
					: undefined,
			),
		)
		.orderBy(desc(osOutputRevisions.revision))
		.limit(Math.min(Math.max(options.limit ?? 50, 1), 200));
}

/**
 * Append the next output revision and advance `current_revision_id`,
 * atomically in one `transactionSync`. The existence check, tenant scope,
 * expectedRevision CAS, and the no-op digest shortcut all resolve inside the
 * transaction — the DO serializes the whole callback, so the read fence the
 * platform plane approximates with a batch is exact here. A CAS miss is a
 * typed result, not a throw.
 */
export async function createOsOutputRevision(
	db: TenantStoreDb,
	params: CreateOsOutputRevisionParams,
): Promise<CreateOsOutputRevisionResult> {
	const now = new Date().toISOString();
	return db.transaction((tx): CreateOsOutputRevisionResult => {
		const [base] = tx
			.select({
				id: osOutputRevisions.id,
				revision: osOutputRevisions.revision,
				accessEnvelope: osOutputRevisions.accessEnvelope,
				contentSha256: osOutputRevisions.contentSha256,
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
			.limit(1)
			.all();
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
		// A save that changes nothing returns the current revision instead of
		// storing another pointer at the same R2 bytes.
		if (
			base.contentSha256 === params.contentSha256 &&
			(accessEnvelope ?? null) === (base.accessEnvelope ?? null)
		) {
			const [current] = tx
				.select()
				.from(osOutputRevisions)
				.where(
					and(
						eq(osOutputRevisions.organizationId, params.organizationId),
						eq(osOutputRevisions.id, base.id),
					),
				)
				.limit(1)
				.all();
			if (current) return { ok: true, revision: current };
		}
		const currentMaxRevision = sql<number>`coalesce((select max(${osOutputRevisions.revision}) from ${osOutputRevisions} where ${osOutputRevisions.outputId} = ${params.outputId}), 0)`;
		const sourceConditions = [
			eq(osOutputs.id, params.outputId),
			eq(osOutputs.organizationId, params.organizationId),
			eq(osOutputs.currentRevisionId, base.id),
			sql`${currentMaxRevision} = ${base.revision}`,
		];
		const revisionRows = tx
			.insert(osOutputRevisions)
			.select(
				tx
					.select({
						id: sql<string>`${params.id}`.as("id"),
						organizationId: sql<string>`${params.organizationId}`.as(
							"organization_id",
						),
						outputId: sql<string>`${params.outputId}`.as("output_id"),
						revision: sql<number>`${currentMaxRevision} + 1`.as("revision"),
						content: sql<string>`${""}`.as("content"),
						note: sql<string | null>`${params.note ?? null}`.as("note"),
						createdByKind: sql<
							OsOutputRevisionRow["createdByKind"]
						>`${params.createdByKind}`.as("created_by_kind"),
						createdById: sql<string>`${params.createdById}`.as("created_by_id"),
						createdAt: sql<string>`${now}`.as("created_at"),
						skillRunId: sql<string | null>`${params.skillRunId ?? null}`.as(
							"skill_run_id",
						),
						skillId: sql<string | null>`${params.skillId ?? null}`.as(
							"skill_id",
						),
						accessEnvelope: sql<string | null>`${accessEnvelope}`.as(
							"access_envelope",
						),
						contentSha256: sql<string | null>`${params.contentSha256}`.as(
							"content_sha256",
						),
						contentBytes: sql<number | null>`${params.contentBytes}`.as(
							"content_bytes",
						),
						bodyR2Key: sql<string | null>`${params.bodyR2Key}`.as(
							"body_r2_key",
						),
					})
					.from(osOutputs)
					.where(and(...sourceConditions)),
			)
			.returning()
			.all();
		const revision = revisionRows[0];
		if (!revision) {
			const [output] = tx
				.select()
				.from(osOutputs)
				.where(
					and(
						eq(osOutputs.id, params.outputId),
						eq(osOutputs.organizationId, params.organizationId),
					),
				)
				.limit(1)
				.all();
			return {
				ok: false,
				reason: output ? "revision_conflict" : "output_not_found",
			};
		}
		tx.update(osOutputs)
			.set({ currentRevisionId: params.id, updatedAt: now })
			.where(
				and(
					eq(osOutputs.id, params.outputId),
					eq(osOutputs.organizationId, params.organizationId),
					sql`changes() = 1`,
				),
			)
			.run();
		return { ok: true, revision };
	});
}

/** Every revision is a GC root, including history and inline-backed revisions. */
export async function referencedOutputBodyHashes(
	db: TenantStoreDb,
	organizationId: string,
	hashes: readonly string[],
): Promise<Set<string>> {
	if (hashes.length === 0) return new Set();
	const rows = await db
		.selectDistinct({ hash: osOutputRevisions.contentSha256 })
		.from(osOutputRevisions)
		.where(
			and(
				eq(osOutputRevisions.organizationId, organizationId),
				sql`${osOutputRevisions.contentSha256} IN (SELECT value FROM json_each(${JSON.stringify(hashes)}))`,
			),
		);
	return new Set(rows.flatMap((row) => (row.hash ? [row.hash] : [])));
}

export interface OutputTransferSnapshot {
	output: OsOutputRow;
	revisions: OsOutputRevisionRow[];
}

export async function snapshotOutput(
	db: TenantStoreDb,
	params: OsOutputScopeParams,
): Promise<OutputTransferSnapshot | undefined> {
	const output = await getOsOutput(db, params);
	if (!output) return undefined;
	const revisions = await db
		.select()
		.from(osOutputRevisions)
		.where(
			and(
				eq(osOutputRevisions.organizationId, params.organizationId),
				eq(osOutputRevisions.outputId, params.outputId),
			),
		)
		.orderBy(osOutputRevisions.revision);
	return { output, revisions };
}

/** Import all immutable revision pointers together; bodies remain in R2. */
export async function importOutput(
	db: TenantStoreDb,
	snapshot: OutputTransferSnapshot,
): Promise<OsOutputRow> {
	const { output, revisions } = snapshot;
	if (
		!revisions.length ||
		!revisions.some((row) => row.id === output.currentRevisionId) ||
		revisions.some(
			(row) =>
				row.organizationId !== output.organizationId ||
				row.outputId !== output.id ||
				!row.bodyR2Key,
		)
	)
		throw new Error("Invalid output transfer revisions");
	return db.transaction((tx) => {
		const existing = tx
			.select()
			.from(osOutputs)
			.where(eq(osOutputs.id, output.id))
			.all()[0];
		if (existing) {
			const saved = tx
				.select()
				.from(osOutputRevisions)
				.where(eq(osOutputRevisions.outputId, output.id))
				.orderBy(osOutputRevisions.revision)
				.all();
			if (
				JSON.stringify(existing) !== JSON.stringify(output) ||
				JSON.stringify(saved) !== JSON.stringify(revisions)
			)
				throw new Error("Output transfer conflicts with destination");
			return existing;
		}
		const row = tx.insert(osOutputs).values(output).returning().all()[0]!;
		for (const revision of revisions)
			tx.insert(osOutputRevisions)
				.values({ ...revision, content: "" })
				.run();
		return row;
	});
}
