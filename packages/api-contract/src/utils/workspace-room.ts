/**
 * The name of the live room everyone with a workspace open is connected to.
 * Tedix OS joins it for presence; the API posts change notices into it. Both
 * must build the same name, so it lives here.
 */
export function workspaceRoomName(scope: {
	tenantSlug: string;
	workspaceId: string;
}): string {
	return `${scope.tenantSlug}:${scope.workspaceId}:${workspaceRoomDocKey(scope.workspaceId)}`;
}

/** The document key of that room within its workspace. */
export function workspaceRoomDocKey(workspaceId: string): string {
	return `workspace:${workspaceId}`;
}

/** Internal route on the room that tells its members a file has a new revision. */
export const WORKSPACE_ROOM_OUTPUT_REVISION_PATH =
	"/__internal/output-revision";

/** What a change notice carries: which file, and the revision it is at now. */
export interface WorkspaceOutputRevisionNotice {
	outputId: string;
	revisionId: string;
	revision: number;
}
