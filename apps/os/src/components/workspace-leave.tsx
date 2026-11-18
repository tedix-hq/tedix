import { SignOut } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OsWorkspaceLeaveStatus } from "@tedix/api-contract/schemas/os-collaborators";
import { type ReactNode, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/kumo/alert-dialog";
import { DropdownMenuItem } from "@/components/kumo/dropdown-menu";
import { osApi } from "@/lib/api";
import { osQuery, osQueryKeys } from "@/lib/os-query-options";
import { errorMessage } from "@/lib/orpc-error";
import { isWorkspaceAccessDenied } from "@/lib/workspace-verification";

/** Why leaving is not possible, in the words shown to the person. */
export const LEAVE_BLOCKED_TEXT: Record<
	Exclude<OsWorkspaceLeaveStatus, "allowed">,
	string
> = {
	owner:
		"You own this workspace, so you can't leave it. To stop using it, archive it instead.",
	organization:
		"This workspace is open to everyone in the organization, and that includes you. There is no access of your own to give up.",
	link: "You have access through a share link that is still on, so leaving wouldn't remove it. Ask the owner to turn the link off.",
};

export const LEAVE_CONFIRM_TEXT =
	"You will no longer be able to open this workspace or anything in it. People you invited lose the access you gave them. To come back, someone has to invite you again.";

function workspaceAccessOptions(workspaceId: string) {
	return osQuery.osCollaborators.access.queryOptions({
		input: { workspaceId },
	});
}

/**
 * Leaving a workspace someone shared with you. It first checks whether your
 * access is yours to give up; when it is not, it says why and offers nothing
 * to confirm.
 */
export function LeaveWorkspaceDialog(props: {
	workspaceId: string;
	workspaceName: string;
	onOpenChange: (open: boolean) => void;
	/** Called once access is gone, before the dialog closes. */
	onLeft?: () => void;
}) {
	const { workspaceId, workspaceName } = props;
	const queryClient = useQueryClient();
	const access = useQuery({
		...workspaceAccessOptions(workspaceId),
		staleTime: 0,
		retry: false,
	});
	const leave = useMutation({
		mutationFn: () => osApi.osCollaborators.leave({ workspaceId }),
		onSuccess: async () => {
			props.onLeft?.();
			props.onOpenChange(false);
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: osQueryKeys.collaborators(),
				}),
				queryClient.invalidateQueries({ queryKey: osQueryKeys.workspaces() }),
			]);
		},
	});
	const status = access.data?.leave;
	if (status === "allowed" || access.isPending)
		return (
			<ConfirmDialog
				open
				onOpenChange={props.onOpenChange}
				title={`Leave ${workspaceName}?`}
				description={
					access.isPending ? "Checking your access…" : LEAVE_CONFIRM_TEXT
				}
				confirmLabel="Leave workspace"
				pendingLabel="Leaving…"
				destructive
				confirmDisabled={access.isPending}
				isPending={leave.isPending}
				error={leave.error}
				onConfirm={() => leave.mutate()}
			/>
		);
	return (
		<AlertDialog open onOpenChange={props.onOpenChange}>
			<AlertDialogContent size="sm">
				<AlertDialogHeader>
					<AlertDialogTitle>{`You can't leave ${workspaceName}`}</AlertDialogTitle>
					<AlertDialogDescription data-leave-blocked>
						{status
							? LEAVE_BLOCKED_TEXT[status]
							: isWorkspaceAccessDenied(access.error)
								? "You no longer have access to this workspace, so there is nothing to leave."
								: errorMessage(access.error)}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Close</AlertDialogCancel>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

/**
 * The "Leave workspace" entry for a workspace's menu, with its dialog. The
 * owner never sees the entry. Render `menuItem` inside the menu and `dialog`
 * outside it, so the dialog outlives the menu closing.
 */
export function useWorkspaceLeave(
	workspace: { id: string; name: string } | undefined,
	onLeft: () => void,
): { menuItem: ReactNode; dialog: ReactNode } {
	const [open, setOpen] = useState(false);
	const access = useQuery({
		...workspaceAccessOptions(workspace?.id ?? ""),
		enabled: workspace !== undefined,
		retry: false,
	});
	const status = access.data?.leave;
	if (!workspace || !status || status === "owner")
		return { menuItem: null, dialog: null };
	return {
		menuItem: (
			<DropdownMenuItem
				variant={status === "allowed" ? "destructive" : undefined}
				onClick={() => setOpen(true)}
			>
				<SignOut size={14} /> Leave workspace
			</DropdownMenuItem>
		),
		dialog: open ? (
			<LeaveWorkspaceDialog
				workspaceId={workspace.id}
				workspaceName={workspace.name}
				onOpenChange={setOpen}
				onLeft={onLeft}
			/>
		) : null,
	};
}
