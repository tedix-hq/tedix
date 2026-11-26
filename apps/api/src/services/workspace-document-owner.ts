import { env } from "cloudflare:workers";
import type { WorkspaceOutputRuntime } from "@tedix/db/queries/durable-sqlite/output-rpc";
import type { DbQueryClient } from "@tedix/db/query-client";
import type { NewOsWorkspaceRow } from "@tedix/db/schema/os-workspaces";
import { createOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";

export function workspaceDocumentRuntime(): WorkspaceOutputRuntime {
	const runtime = (
		env as unknown as { WORKSPACE_RUNTIME?: WorkspaceOutputRuntime }
	).WORKSPACE_RUNTIME;
	if (!runtime) throw new Error("Workspace output runtime is unavailable");
	return runtime;
}

export async function initializeWorkspaceDocumentOwner(workspace: {
	organizationId: string;
	id: string;
}) {
	return workspaceDocumentRuntime().outputQuery(
		{ organizationId: workspace.organizationId, workspaceId: workspace.id },
		{ op: "initialize" },
	);
}

/** Commit the directory first so a failed initialization can recover on document use. */
export async function createInitializedWorkspace<
	T extends
		| { organizationId: string; id: string }
		| { workspace: { organizationId: string; id: string } }
		| null,
>(create: () => Promise<T>): Promise<T> {
	const created = await create();
	if (created) {
		if ("id" in created) await initializeWorkspaceDocumentOwner(created);
		else await initializeWorkspaceDocumentOwner(created.workspace);
	}
	return created;
}

export async function createWorkspaceDocumentOwner(
	db: DbQueryClient,
	input: NewOsWorkspaceRow & { organizationId: string },
) {
	return createInitializedWorkspace(() => createOsWorkspace(db, input));
}
