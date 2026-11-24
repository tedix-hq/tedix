import { osGadgetHasWorkNavigation } from "./gadget-navigation";
import { and, eq } from "drizzle-orm";
import { osGadgetHasRuntimeTriggers } from "./gadget-triggers";
import { getOsWorkspace } from "./workspaces";
import { recordWorkRelationEdges } from "../decision-graph-writers";
import {
	buildBlueprintProvisioningStatements,
	type BlueprintProvisioningRows,
} from "./provisioning";
import type { BatchItem } from "drizzle-orm/batch";
import type { DbQueryClient } from "../../query-client";
import { chunkForBoundParams } from "../../utils/batch";
import {
	buildEnsureOsGadgetCodeBlobStatement,
	splitOsGadgetCodeRow,
} from "./gadget-code";
import {
	type NewOsBlueprintRevisionRow,
	type NewOsBlueprintRow,
	type NewOsGadgetRevisionRow,
	type NewOsGadgetRow,
	type NewOsWorkspaceRow,
	type NewOsWorkspaceResourceRow,
	type OsBlueprintRevisionRow,
	type OsBlueprintRow,
	type OsGadgetRevisionRow,
	type OsGadgetRow,
	type OsWorkspaceRow,
	type OsWorkspaceResourceRow,
	osGadgetCode,
	osBlueprintRevisions,
	osBlueprints,
	osGadgetRevisions,
	osGadgets,
	osWorkspaces,
	osWorkspaceResources,
} from "../../schema/os-workspaces";
import {
	type osOutputs,
	type osOutputRevisions,
} from "../../tenant-store/outputs-schema";

/**
 * A gallery import's blueprint copy, materialized in the SAME batch as the
 * workspace it instantiates. Copying first and materializing second used to be
 * two independent batches, so a lost workspace-name race left the copied
 * blueprint committed in the caller's organization with no workspace.
 */
export interface InstantiateOsBlueprintCopyParams {
	/** New blueprint row with `currentRevisionId` preset to the revision's id. */
	blueprint: NewOsBlueprintRow;
	/** Revision-1 row whose id matches the preset pointer. */
	revision: NewOsBlueprintRevisionRow;
}

export interface InstantiateOsBlueprintParams {
	/** Optional blueprint copy to create in the same transaction (gallery import). */
	blueprintCopy?: InstantiateOsBlueprintCopyParams;
	workspace: NewOsWorkspaceRow;
	/** Gadget rows with `currentRevisionId` preset to the matching revision id. */
	gadgets: NewOsGadgetRow[];
	/** Revision-1 rows, one per gadget, ids matching the preset pointers. */
	revisions: NewOsGadgetRevisionRow[];
	resources?: NewOsWorkspaceResourceRow[];
	outputs?: (typeof osOutputs.$inferInsert)[];
	outputRevisions?: (typeof osOutputRevisions.$inferInsert)[];
	code?: (typeof osGadgetCode.$inferInsert)[];
	provisioning?: BlueprintProvisioningRows;
}

export interface InstantiateOsBlueprintResult {
	/** The copied blueprint and its revision-1 row; undefined unless `blueprintCopy` was given. */
	blueprintCopy?: {
		blueprint: OsBlueprintRow;
		revision: OsBlueprintRevisionRow;
	};
	workspace: OsWorkspaceRow;
	gadgets: OsGadgetRow[];
	revisions: OsGadgetRevisionRow[];
	resources: OsWorkspaceResourceRow[];
}

/**
 * D1 caps a statement at 100 bound parameters; a gadget row binds 15 columns
 * and a revision row 9, so multi-row inserts are chunked well under the cap.
 * The chunks stay inside one `db.batch()`, which D1 rolls back as a unit.
 */
const GADGETS_PER_STATEMENT = 6;
const REVISIONS_PER_STATEMENT = 8;
const RESOURCES_PER_STATEMENT = 5;

/** Retain a retryable directory without publishing a successful apply receipt. */
export async function prepareOsBlueprintWorkspace(
	db: DbQueryClient,
	input: NewOsWorkspaceRow,
) {
	await db
		.insert(osWorkspaces)
		.values(input)
		.onConflictDoNothing({ target: osWorkspaces.id });
	const existing = await getOsWorkspace(db, {
		organizationId: input.organizationId,
		workspaceId: input.id,
	});
	if (existing) {
		for (const key of [
			"name",
			"createdByKind",
			"createdById",
			"sourceBlueprintId",
			"sourceBlueprintRevisionId",
			"sourceBlueprintRevisionNumber",
			"visibility",
			"ownerUserId",
		] as const) {
			const expected = input[key] ?? (key === "visibility" ? "org" : null);
			if (existing[key] !== expected)
				throw new Error(
					"Blueprint workspace destination conflicts with its preparation",
				);
		}
		return existing;
	}
	throw new Error("Blueprint workspace directory is missing");
}

/**
 * Materialize a blueprint revision as a workspace with its gadgets and their
 * first revisions — optionally together with the blueprint copy a gallery
 * import creates — atomically.
 *
 * All ids are caller-generated fresh UUIDs, so unlike the append path there is
 * no CAS to guard: gadget rows are inserted with `current_revision_id` already
 * pointing at their revision-1 row, and a copied blueprint row with its pointer
 * already on its revision-1 row. The whole materialization is one `db.batch()`
 * (D1 has no `BEGIN`; `batch` IS the transaction primitive), so a lost
 * unique-name race on EITHER the blueprint name or the workspace name fails the
 * batch and leaves nothing behind — no orphan blueprint, no partial gadgets.
 * The caller maps the violation to CONFLICT. A prepared directory is retained
 * across failed object writes; provisioning and its receipt still commit together.
 */
export async function instantiateOsBlueprint(
	db: DbQueryClient,
	params: InstantiateOsBlueprintParams,
	preparedWorkspace?: OsWorkspaceRow,
): Promise<InstantiateOsBlueprintResult> {
	if (params.outputs?.length || params.outputRevisions?.length)
		throw new Error(
			"Blueprint document writes require the workspace object service",
		);
	const revisionsById = new Map(
		params.revisions.map((revision) => [revision.id, revision]),
	);
	const gadgetChunks = chunkForBoundParams(
		params.gadgets.map((gadget) => ({
			...gadget,
			hasRuntimeTriggers: osGadgetHasRuntimeTriggers(
				revisionsById.get(gadget.currentRevisionId ?? "")?.manifest ?? "{}",
			),
			hasWorkNavigation: osGadgetHasWorkNavigation(
				revisionsById.get(gadget.currentRevisionId ?? "")?.manifest ?? "{}",
			),
		})),
		GADGETS_PER_STATEMENT,
	);
	const revisionChunks = chunkForBoundParams(
		params.revisions,
		REVISIONS_PER_STATEMENT,
	);
	const resourceChunks = chunkForBoundParams(
		params.resources ?? [],
		RESOURCES_PER_STATEMENT,
	);
	const copy = params.blueprintCopy;
	// Apps that share the same files share one blob; each keeps its own pointer.
	const code = await Promise.all((params.code ?? []).map(splitOsGadgetCodeRow));
	const blobs = new Map(
		code.map(({ blob }) => [`${blob.organizationId}:${blob.sha256}`, blob]),
	);
	const statements = [
		...(copy
			? [
					db.insert(osBlueprints).values(copy.blueprint).returning(),
					db.insert(osBlueprintRevisions).values(copy.revision).returning(),
				]
			: []),
		preparedWorkspace
			? db
					.select()
					.from(osWorkspaces)
					.where(
						and(
							eq(osWorkspaces.id, params.workspace.id),
							eq(osWorkspaces.organizationId, params.workspace.organizationId),
						),
					)
			: db.insert(osWorkspaces).values(params.workspace).returning(),
		...resourceChunks.map((rows) =>
			db.insert(osWorkspaceResources).values(rows).returning(),
		),
		...gadgetChunks.map((rows) =>
			db.insert(osGadgets).values(rows).returning(),
		),
		...revisionChunks.map((rows) =>
			db.insert(osGadgetRevisions).values(rows).returning(),
		),
		...[...blobs.values()].map((blob) =>
			buildEnsureOsGadgetCodeBlobStatement(db, blob),
		),
		...code.map((row) => db.insert(osGadgetCode).values(row.code)),
		...(params.provisioning
			? buildBlueprintProvisioningStatements(db, params.provisioning)
			: []),
	] as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];
	const results = (await db.batch(statements)) as unknown[][];

	const copyWidth = copy ? 2 : 0;
	const workspace = (results[copyWidth] as OsWorkspaceRow[])[0];
	if (!workspace) {
		throw new Error("OS blueprint instantiation returned no workspace row");
	}
	const resources = results
		.slice(copyWidth + 1, copyWidth + 1 + resourceChunks.length)
		.flat() as OsWorkspaceResourceRow[];
	const gadgetStart = copyWidth + 1 + resourceChunks.length;
	const gadgets = results
		.slice(gadgetStart, gadgetStart + gadgetChunks.length)
		.flat() as OsGadgetRow[];
	const revisions = results
		.slice(
			gadgetStart + gadgetChunks.length,
			gadgetStart + gadgetChunks.length + revisionChunks.length,
		)
		.flat() as OsGadgetRevisionRow[];
	let blueprintCopy: InstantiateOsBlueprintResult["blueprintCopy"];
	if (copy) {
		const blueprintRow = (results[0] as OsBlueprintRow[])[0];
		const revisionRow = (results[1] as OsBlueprintRevisionRow[])[0];
		if (!blueprintRow || !revisionRow) {
			throw new Error("OS blueprint copy returned no row");
		}
		blueprintCopy = { blueprint: blueprintRow, revision: revisionRow };
	}
	if (params.provisioning)
		await recordWorkRelationEdges(
			db,
			workspace.organizationId,
			params.provisioning.relations,
		);
	return { blueprintCopy, workspace, resources, gadgets, revisions };
}
