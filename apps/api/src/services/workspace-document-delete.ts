import type { DbQueryClient } from "@tedix/db/query-client";
import type { OsWorkspaceRow } from "@tedix/db/schema/os-workspaces";
import {
	deleteOsWorkspace,
	deleteWorkspaceDocumentIndex,
	listOrganizationWorkspaceDeletionCandidates,
} from "@tedix/db/queries/os-workspaces/workspaces";
import { workspaceDocumentRuntime } from "./workspace-document-owner";

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
	await deleteObjectWorkspaceDocuments(db, scope);
	return deleteOsWorkspace(db, { ...scope, preferenceNamespace });
}

/** Keep the directory and owner marker until both stores acknowledge cleanup. */
export async function deleteObjectWorkspaceDocuments(
	db: DbQueryClient,
	scope: { organizationId: string; workspaceId: string },
) {
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
