import {
	Archive,
	Bell,
	BellSlash,
	Checks,
	DotsThree,
	Info,
	PencilSimple,
	PushPin,
	PushPinSlash,
	ShareNetwork,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import type { OsWorkspace } from "@tedix/api-contract/schemas/os-workspaces";
import { type ReactElement, type ReactNode, useState } from "react";
import { Button } from "@/components/kumo/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/kumo/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import {
	useWorkspaceMute,
	WorkspaceArchiveDialog,
	WorkspaceFormDialog,
} from "@/components/workspace-actions";
import { WorkspaceInfoDialog } from "@/components/workspace-info-dialog";
import { WorkspaceShareDialog } from "@/components/workspace-share-dialog";
import { cn } from "@/lib/utils";
import {
	useMarkWorkspaceRead,
	useWorkspaceUnreadCount,
} from "@/lib/workspace-unread";

/** The row's pin, owned by the list that shows it. */
export interface WorkspaceRowPin {
	pinned: boolean;
	/** True while the pin is unknown or being saved. */
	disabled?: boolean;
	onToggle: () => void;
}

type OpenDialog = "rename" | "share" | "archive" | "info" | null;

/**
 * Wraps a workspace row with its actions, so a workspace can be managed
 * without opening it: a "⋯" button and the same menu on right-click.
 */
export function WorkspaceRowMenu({
	workspace,
	pin,
	render,
	className,
	buttonClassName,
	showButton = true,
	children,
}: {
	workspace: OsWorkspace;
	pin: WorkspaceRowPin;
	/** The element the row is; a plain block when left out. */
	render?: ReactElement;
	className?: string;
	buttonClassName?: string;
	/** False where a row has no room for the button; right-click still works. */
	showButton?: boolean;
	children: ReactNode;
}) {
	const navigate = useNavigate();
	const [dialog, setDialog] = useState<OpenDialog>(null);
	const close = (open: boolean) => {
		if (!open) setDialog(null);
	};
	const unread = useWorkspaceUnreadCount(workspace.id);
	const markRead = useMarkWorkspaceRead();
	const mute = useWorkspaceMute(workspace.id);

	const actions = (
		Item: typeof DropdownMenuItem | typeof ContextMenuItem,
		Separator: () => ReactNode,
	) => (
		<>
			<Item onClick={() => setDialog("rename")}>
				<PencilSimple size={14} /> Rename
			</Item>
			<Item disabled={pin.disabled} onClick={pin.onToggle}>
				{pin.pinned ? <PushPinSlash size={14} /> : <PushPin size={14} />}
				{pin.pinned ? "Unpin" : "Pin"}
			</Item>
			<Item disabled={mute.disabled} onClick={mute.toggle}>
				{mute.muted ? <Bell size={14} /> : <BellSlash size={14} />}
				{mute.muted ? "Unmute" : "Mute"}
			</Item>
			<Item
				disabled={unread === 0 || markRead.isPending}
				onClick={() =>
					markRead.mutate({
						workspaceId: workspace.id,
						target: { type: "all" },
					})
				}
			>
				<Checks size={14} /> Mark as read
			</Item>
			<Item onClick={() => setDialog("share")}>
				<ShareNetwork size={14} /> Share
			</Item>
			<Item onClick={() => setDialog("info")}>
				<Info size={14} /> Information
			</Item>
			<Separator />
			<Item variant="danger" onClick={() => setDialog("archive")}>
				<Archive size={14} /> Archive
			</Item>
		</>
	);

	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger
					className={className}
					data-workspace-row-menu=""
					render={render}
				>
					{children}
					{showButton ? (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										aria-label={`Actions for ${workspace.name}`}
										className={cn("shrink-0", buttonClassName)}
										size="icon-sm"
										variant="ghost"
									>
										<DotsThree size={16} weight="bold" />
									</Button>
								}
							/>
							<DropdownMenuContent align="end">
								{actions(DropdownMenuItem, () => (
									<DropdownMenuSeparator />
								))}
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
				</ContextMenuTrigger>
				<ContextMenuContent>
					{actions(ContextMenuItem, () => (
						<ContextMenuSeparator />
					))}
				</ContextMenuContent>
			</ContextMenu>
			{dialog === "rename" ? (
				<WorkspaceFormDialog
					mode="edit"
					open
					workspace={workspace}
					onOpenChange={close}
					onSaved={() => undefined}
				/>
			) : null}
			{dialog === "share" ? (
				<WorkspaceShareDialog
					workspaceId={workspace.id}
					workspaceName={workspace.name}
					visibility={workspace.visibility}
					open
					onOpenChange={close}
				/>
			) : null}
			{dialog === "info" ? (
				<WorkspaceInfoDialog workspace={workspace} onOpenChange={close} />
			) : null}
			{dialog === "archive" ? (
				<WorkspaceArchiveDialog
					workspace={workspace}
					open
					onOpenChange={close}
					onArchived={() => {
						// The person may be looking at the workspace they just archived.
						if (
							window.location.pathname.startsWith(`/workspace/${workspace.id}`)
						)
							void navigate({ to: "/workspaces" });
					}}
				/>
			) : null}
		</>
	);
}
