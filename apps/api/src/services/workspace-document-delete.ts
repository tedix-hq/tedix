import type { DbQueryClient } from "@tedix/db/query-client";
import type { OsWorkspaceRow } from "@tedix/db/schema/os-workspaces";
import {
	createOsWorkspace,
	deleteOsWorkspace,
	getOsWorkspace,
	listWorkspaceDocuments,
	deleteWorkspaceDocumentIndex,
	listOrganizationWorkspaceDeletionCandidates,
} from "@tedix/db/queries/os-workspaces/workspaces";
import {
	createInitializedWorkspace,
	workspaceOwnsDocuments,
	workspaceDocumentRuntime,
} from "./workspace-document-owner";
import {
	placeWorkspaceDocuments,
	workspacePlacementId,
} from "./workspace-document-placement";

/** Callers authorize deletion and installation/share guards before this operation. */
export async function deleteWorkspaceWithDocuments(
	db: DbQueryClient,
	workspace: OsWorkspaceRow,
	preferenceNamespace?: string,
) {
	const scope = {
		organizationId: workspace.organizationId,
		workspaceId: workspace.id,
	};
	if (await deleteObjectWorkspaceDocuments(db, scope))
		return deleteOsWorkspace(db, { ...scope, preferenceNamespace });
	if (workspace.visibility === "private") {
		if (!workspace.ownerUserId)
			throw new Error("Private workspace has no owner");
		const retainedId = await workspacePlacementId(
			workspace.organizationId,
			`delete:${workspace.id}`,
		);
		const documents = await listWorkspaceDocuments(db, scope);
		let retained = await getOsWorkspace(db, {
			organizationId: workspace.organizationId,
			workspaceId: retainedId,
		});
		if (documents.length || retained) {
			const authorize = async (sourceId: string) => {
				const [source, target] = await Promise.all([
					getOsWorkspace(db, scope),
					getOsWorkspace(db, {
						organizationId: workspace.organizationId,
						workspaceId: retainedId,
					}),
				]);
				if (
					sourceId !== workspace.id ||
					source?.visibility !== "private" ||
					source.ownerUserId !== workspace.ownerUserId ||
					target?.visibility !== "private" ||
					target.ownerUserId !== workspace.ownerUserId
				)
					throw new Error(
						"Document transfer crosses the private owner boundary",
					);
			};
			retained = await createInitializedWorkspace(async () => {
				if (!retained) {
					try {
						retained = await createOsWorkspace(db, {
							id: retainedId,
							organizationId: workspace.organizationId,
							name: `Saved documents ${retainedId.slice(0, 8)}`,
							visibility: "private",
							ownerUserId: workspace.ownerUserId,
							createdByKind: workspace.createdByKind,
							createdById: workspace.createdById,
						});
					} catch (error) {
						retained = await getOsWorkspace(db, {
							organizationId: workspace.organizationId,
							workspaceId: retainedId,
						});
						if (!retained) throw error;
					}
				}

				await authorize(workspace.id);
				return retained;
			});
			await placeWorkspaceDocuments(
				db,
				workspace.organizationId,
				retainedId,
				`delete:${workspace.id}`,
				documents,
				authorize,
			);
		}
	}
	return deleteOsWorkspace(db, {
		...scope,
		preferenceNamespace,
		...(workspace.visibility === "private"
			? { expectedOwnerUserId: workspace.ownerUserId! }
			: {}),
	});
}

/** Keep the directory and owner marker until both stores acknowledge cleanup. */
export async function deleteObjectWorkspaceDocuments(
	db: DbQueryClient,
	scope: { organizationId: string; workspaceId: string },
) {
	if (!(await workspaceOwnsDocuments(scope))) return false;
	await workspaceDocumentRuntime().outputQuery(scope, { op: "purge" });
	await deleteWorkspaceDocumentIndex(db, scope);
	return true;
}

export async function deleteOrganizationWorkspaceDocuments(
	db: DbQueryClient,
	organizationId: string,
) {
	let afterId: string | undefined;
	for (;;) {
		const page = await listOrganizationWorkspaceDeletionCandidates(
			db,
			organizationId,
			afterId,
		);
		for (const workspace of page) {
			await deleteObjectWorkspaceDocuments(db, {
				organizationId,
				workspaceId: workspace.id,
			});
		}
		if (page.length < 100) return;
		afterId = page[page.length - 1]!.id;
	}
}
