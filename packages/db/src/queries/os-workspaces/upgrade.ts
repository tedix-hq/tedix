import { and, eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DbQueryClient } from "../../query-client";
import {
	type NewOsGadgetRevisionRow,
	type NewOsGadgetRow,
	type OsGadgetRevisionRow,
	type OsGadgetRow,
	type OsWorkspaceRow,
	osGadgetRevisions,
	osGadgets,
	osWorkspaces,
} from "../../schema/os-workspaces";

/**
 * Blueprint upgrade application: re-pin one workspace onto a newer revision of
 * the blueprint it came from and reconcile its gadgets to that revision, in a
 * single D1 batch.
 *
 * CONCURRENCY. The whole operation is a compare-and-swap on the pin the plan
 * was computed against. Every statement is fenced on that OLD pin still being
 * the workspace's `source_blueprint_revision_id`, and the workspace re-pin runs
 * LAST — so a second apply that lost the race finds the fence false on every
 * statement, writes nothing, and reports `pin_moved` instead of appending a
 * duplicate set of gadget revisions. Fencing the gadget writes on the NEW pin
 * would not work: both racers target the same new revision.
 *
 * HISTORY. Gadget revisions are append-only and blueprint revisions are
 * immutable, so an applied upgrade destroys nothing: gadgets the candidate drops
 * are archived (not deleted), and the pin the workspace left — with the
 * preflight envelope recorded there — is retained as its rollback reference
 * rather than overwritten. Skills and policy packs version in place with no
 * history table, so discarding that envelope would destroy evidence that cannot
 * be reconstructed.
 */

/** A gadget the candidate revision declares that the workspace does not have yet. */
export interface OsBlueprintUpgradeGadgetInsert {
	/** Gadget row with `currentRevisionId` preset to the revision's id. */
	gadget: NewOsGadgetRow;
	/** Revision-1 row whose id matches the preset pointer. */
	revision: NewOsGadgetRevisionRow;
}

/**
 * A gadget the workspace already has and the candidate still declares: its
 * lineage stamp moves to the new blueprint revision and it is (re)activated,
 * plus an appended revision when the candidate changed its manifest.
 */
export interface OsBlueprintUpgradeGadgetSync {
	gadgetId: string;
	/** Omitted when the manifest is unchanged and only the lineage stamp moves. */
	append: {
		/** Caller-generated UUID for the appended revision row. */
		revisionId: string;
		/** JSON string: the candidate revision's manifest for this gadget. */
		manifest: string;
		createdByKind: OsGadgetRevisionRow["createdByKind"];
		createdById: string;
	} | null;
}

export interface ApplyOsBlueprintUpgradeParams {
	organizationId: string;
	workspaceId: string;
	/** The pin the upgrade plan was computed against; the CAS predicate. */
	expectedRevisionId: string;
	/** The pin's revision number, carried into the rollback reference. */
	expectedRevisionNumber: number | null;
	/** JSON: the preflight envelope recorded while the workspace was on the old pin. */
	expectedInstantiationPreflight: string | null;
	nextRevisionId: string;
	nextRevisionNumber: number;
	/** JSON: the candidate's preflight envelope, resolved in this organization. */
	nextInstantiationPreflight: string;
	/** JSON: the `OsWorkspaceBlueprintDecision` this apply records. */
	blueprintDecision: string;
	added: OsBlueprintUpgradeGadgetInsert[];
	synced: OsBlueprintUpgradeGadgetSync[];
	/** Gadgets the candidate no longer declares; archived, never deleted. */
	archivedGadgetIds: string[];
	now: string;
}

export type ApplyOsBlueprintUpgradeResult =
	| {
			ok: true;
			workspace: OsWorkspaceRow;
			addedGadgets: OsGadgetRow[];
			appendedRevisions: OsGadgetRevisionRow[];
	  }
	| { ok: false; reason: "pin_moved" };

export async function applyOsBlueprintUpgrade(
	db: DbQueryClient,
	params: ApplyOsBlueprintUpgradeParams,
): Promise<ApplyOsBlueprintUpgradeResult> {
	// The one predicate every statement in the batch hangs off: this workspace,
	// in this organization, still pinned where the plan was computed.
	const pinnedWorkspace = and(
		eq(osWorkspaces.id, params.workspaceId),
		eq(osWorkspaces.organizationId, params.organizationId),
		eq(osWorkspaces.sourceBlueprintRevisionId, params.expectedRevisionId),
	);
	const stillPinned = sql`exists (select 1 from ${osWorkspaces} where ${pinnedWorkspace})`;

	const statements: BatchItem<"sqlite">[] = [];
	for (const insert of params.added) {
		const { gadget, revision } = insert;
		statements.push(
			db
				.insert(osGadgets)
				.select(
					db
						.select({
							id: sql<string>`${gadget.id}`.as("id"),
							organizationId: sql<string>`${gadget.organizationId}`.as(
								"organization_id",
							),
							workspaceId: sql<string>`${gadget.workspaceId}`.as(
								"workspace_id",
							),
							name: sql<string>`${gadget.name}`.as("name"),
							description: sql<string | null>`${gadget.description ?? null}`.as(
								"description",
							),
							status: sql<
								OsGadgetRow["status"]
							>`${gadget.status ?? "active"}`.as("status"),
							currentRevisionId: sql<
								string | null
							>`${gadget.currentRevisionId ?? null}`.as("current_revision_id"),
							sourceBlueprintRevisionId: sql<
								string | null
							>`${gadget.sourceBlueprintRevisionId ?? null}`.as(
								"source_blueprint_revision_id",
							),
							createdByKind: sql<
								OsGadgetRow["createdByKind"]
							>`${gadget.createdByKind}`.as("created_by_kind"),
							createdById: sql<string>`${gadget.createdById}`.as(
								"created_by_id",
							),
							createdAt: sql<string>`${gadget.createdAt ?? params.now}`.as(
								"created_at",
							),
							updatedAt: sql<string>`${gadget.updatedAt ?? params.now}`.as(
								"updated_at",
							),
						})
						.from(osWorkspaces)
						.where(pinnedWorkspace),
				)
				.returning() as unknown as BatchItem<"sqlite">,
		);
		statements.push(
			db
				.insert(osGadgetRevisions)
				.select(
					db
						.select({
							id: sql<string>`${revision.id}`.as("id"),
							organizationId: sql<string>`${revision.organizationId}`.as(
								"organization_id",
							),
							gadgetId: sql<string>`${revision.gadgetId}`.as("gadget_id"),
							revision: sql<number>`${revision.revision}`.as("revision"),
							manifest: sql<string>`${revision.manifest}`.as("manifest"),
							sourceArtifactRef: sql<
								string | null
							>`${revision.sourceArtifactRef ?? null}`.as(
								"source_artifact_ref",
							),
							createdByKind: sql<
								OsGadgetRevisionRow["createdByKind"]
							>`${revision.createdByKind}`.as("created_by_kind"),
							createdById: sql<string>`${revision.createdById}`.as(
								"created_by_id",
							),
							createdAt: sql<string>`${revision.createdAt ?? params.now}`.as(
								"created_at",
							),
						})
						.from(osWorkspaces)
						.where(pinnedWorkspace),
				)
				.returning() as unknown as BatchItem<"sqlite">,
		);
	}

	// Index of the first statement of each sync entry, so the appended revision
	// rows can be read back out of the batch results positionally.
	const syncOffsets: number[] = [];
	for (const sync of params.synced) {
		syncOffsets.push(statements.length);
		if (sync.append) {
			// max+1 is computed inside the statement, so an unrelated concurrent
			// gadget revision cannot collide with the appended counter.
			const nextRevision = sql<number>`coalesce((select max(${osGadgetRevisions.revision}) from ${osGadgetRevisions} where ${osGadgetRevisions.gadgetId} = ${sync.gadgetId}), 0) + 1`;
			const append = sync.append;
			statements.push(
				db
					.insert(osGadgetRevisions)
					.select(
						db
							.select({
								id: sql<string>`${append.revisionId}`.as("id"),
								organizationId: sql<string>`${params.organizationId}`.as(
									"organization_id",
								),
								gadgetId: sql<string>`${sync.gadgetId}`.as("gadget_id"),
								revision: nextRevision.as("revision"),
								manifest: sql<string>`${append.manifest}`.as("manifest"),
								sourceArtifactRef: sql<string | null>`null`.as(
									"source_artifact_ref",
								),
								createdByKind: sql<
									OsGadgetRevisionRow["createdByKind"]
								>`${append.createdByKind}`.as("created_by_kind"),
								createdById: sql<string>`${append.createdById}`.as(
									"created_by_id",
								),
								createdAt: sql<string>`${params.now}`.as("created_at"),
							})
							.from(osWorkspaces)
							.where(pinnedWorkspace),
					)
					.returning() as unknown as BatchItem<"sqlite">,
			);
		}
		// The gadget the candidate declares is (re)activated and restamped with the
		// declaring revision, whether or not its manifest moved.
		statements.push(
			db
				.update(osGadgets)
				.set({
					...(sync.append ? { currentRevisionId: sync.append.revisionId } : {}),
					sourceBlueprintRevisionId: params.nextRevisionId,
					status: "active",
					updatedAt: params.now,
				})
				.where(
					and(
						eq(osGadgets.id, sync.gadgetId),
						eq(osGadgets.organizationId, params.organizationId),
						eq(osGadgets.workspaceId, params.workspaceId),
						stillPinned,
					),
				) as unknown as BatchItem<"sqlite">,
		);
	}

	for (const gadgetId of params.archivedGadgetIds) {
		statements.push(
			db
				.update(osGadgets)
				.set({ status: "archived", updatedAt: params.now })
				.where(
					and(
						eq(osGadgets.id, gadgetId),
						eq(osGadgets.organizationId, params.organizationId),
						eq(osGadgets.workspaceId, params.workspaceId),
						stillPinned,
					),
				) as unknown as BatchItem<"sqlite">,
		);
	}

	statements.push(
		db
			.update(osWorkspaces)
			.set({
				sourceBlueprintRevisionId: params.nextRevisionId,
				sourceBlueprintRevisionNumber: params.nextRevisionNumber,
				instantiationPreflight: params.nextInstantiationPreflight,
				previousBlueprintRevisionId: params.expectedRevisionId,
				previousBlueprintRevisionNumber: params.expectedRevisionNumber,
				previousInstantiationPreflight: params.expectedInstantiationPreflight,
				blueprintDecision: params.blueprintDecision,
				updatedAt: params.now,
			})
			.where(pinnedWorkspace)
			.returning() as unknown as BatchItem<"sqlite">,
	);

	const results = (await db.batch(
		statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
	)) as unknown[][];
	const workspace = (results[results.length - 1] as OsWorkspaceRow[])[0];
	if (!workspace) {
		// The fence was false, so nothing above it wrote either.
		return { ok: false, reason: "pin_moved" };
	}
	const addedGadgets: OsGadgetRow[] = [];
	for (let index = 0; index < params.added.length; index += 1) {
		const rows = results[index * 2] as OsGadgetRow[];
		if (rows[0]) addedGadgets.push(rows[0]);
	}
	const appendedRevisions: OsGadgetRevisionRow[] = [];
	params.synced.forEach((sync, index) => {
		if (!sync.append) return;
		const rows = results[syncOffsets[index] as number] as OsGadgetRevisionRow[];
		if (rows[0]) appendedRevisions.push(rows[0]);
	});
	return { ok: true, workspace, addedGadgets, appendedRevisions };
}

export interface RecordOsWorkspaceBlueprintDecisionParams {
	organizationId: string;
	workspaceId: string;
	/** CAS: the pin the decision was reviewed against. */
	expectedRevisionId: string;
	/** JSON: the `OsWorkspaceBlueprintDecision` being recorded. */
	blueprintDecision: string;
	now: string;
}

/**
 * Record a `stay_pinned` review without moving anything.
 *
 * The pin predicate is still a compare-and-swap: a decision that names a pin the
 * workspace has already left is not a decision about this workspace's current
 * state, so it must not be recorded. Nothing else on the row changes — that is
 * the point of the verb.
 */
export async function recordOsWorkspaceBlueprintDecision(
	db: DbQueryClient,
	params: RecordOsWorkspaceBlueprintDecisionParams,
): Promise<OsWorkspaceRow | undefined> {
	const [row] = await db
		.update(osWorkspaces)
		.set({
			blueprintDecision: params.blueprintDecision,
			updatedAt: params.now,
		})
		.where(
			and(
				eq(osWorkspaces.id, params.workspaceId),
				eq(osWorkspaces.organizationId, params.organizationId),
				eq(osWorkspaces.sourceBlueprintRevisionId, params.expectedRevisionId),
			),
		)
		.returning();
	return row;
}
