import { useQuery } from "@tanstack/react-query";
import { osQuery } from "@/lib/os-query-options";

/** What the chat shows a person who can view a workspace but not build in it. */
export const VIEW_ONLY_CHAT_REASON =
	"You can view this workspace. Ask an owner for build access to chat.";

/**
 * True once the signed-in person's role in the workspace is known to be
 * view-only ("use"). Unknown, loading and failed checks are not view-only:
 * the workspace object still refuses a message it may not accept.
 */
export function useWorkspaceViewOnly(workspaceId: string | null): boolean {
	const access = useQuery(
		osQuery.osCollaborators.access.queryOptions({
			input: { workspaceId: workspaceId ?? "" },
			enabled: workspaceId !== null,
			staleTime: 30_000,
			retry: false,
		}),
	);
	return workspaceId !== null && access.data?.role === "use";
}
