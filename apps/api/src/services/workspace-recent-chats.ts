import { operationAllowed } from "@tedix/api-contract/schemas/os-collaborators";
import type { WorkspaceRecentChat } from "@tedix/api-contract/schemas/workspace-unread";
import { readWorkspaceRuntimeRole } from "@tedix/db/queries/os-workspace-access";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import type { DbQueryClient } from "@tedix/db/query-client";

export interface PersonChatsOwner {
	organizationId: string;
	/** The sign-in id the workspace records a person's turns under. */
	userId: string;
}

/** The workspace runtime's per-person chat index (apps/workspace-do person-chats.ts). */
export interface PersonChatsRuntime {
	listPersonChats(
		owner: PersonChatsOwner,
		limit?: number,
	): Promise<
		Array<{
			workspaceId: string;
			conversationId: string;
			title: string | null;
			lastMessageAt: string;
		}>
	>;
	forgetPersonChatWorkspace(
		owner: PersonChatsOwner,
		workspaceId: string,
	): Promise<void>;
}

/**
 * The person's recent workspace chats, newest first. Each workspace is checked
 * the way the workspace checks a chat connection; one the person can no longer
 * open is left out and dropped from their index. A failed check leaves the
 * entries out this time but keeps them.
 */
export async function listRecentWorkspaceChats(
	db: DbQueryClient,
	runtime: PersonChatsRuntime,
	owner: PersonChatsOwner,
	limit: number,
	defer: (work: Promise<unknown>) => void = () => {},
): Promise<WorkspaceRecentChat[]> {
	const entries = await runtime.listPersonChats(
		owner,
		Math.min(200, limit * 2),
	);
	const names = new Map<string, string | null>();
	for (const workspaceId of new Set(
		entries.map((entry) => entry.workspaceId),
	)) {
		const scope = { organizationId: owner.organizationId, workspaceId };
		try {
			const role = await readWorkspaceRuntimeRole(db, scope, {
				actorId: owner.userId,
				actorKind: "user",
			});
			if (!operationAllowed(role, "app.chat")) {
				names.set(workspaceId, null);
				defer(
					runtime.forgetPersonChatWorkspace(owner, workspaceId).catch(() => {}),
				);
				continue;
			}
			const workspace = await getOsWorkspace(db, scope);
			names.set(workspaceId, workspace?.name ?? null);
		} catch {
			names.set(workspaceId, null);
		}
	}
	return entries
		.flatMap((entry) => {
			const workspaceName = names.get(entry.workspaceId);
			return workspaceName == null ? [] : [{ ...entry, workspaceName }];
		})
		.slice(0, limit);
}
