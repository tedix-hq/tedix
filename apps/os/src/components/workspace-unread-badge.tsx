import { UnreadBadge } from "@/components/unread-badge";
import { useWorkspaceUnreadCount } from "@/lib/workspace-unread";

/** How many new chat messages and changed files a workspace has for the person. */
export function WorkspaceUnreadBadge({
	workspaceId,
	name,
	className,
}: {
	workspaceId: string;
	name: string;
	className?: string;
}) {
	return (
		<UnreadBadge
			className={className}
			count={useWorkspaceUnreadCount(workspaceId)}
			label={`unread in ${name}`}
		/>
	);
}
