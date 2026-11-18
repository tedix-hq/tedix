import {
	Archive,
	ArrowCircleUp,
	Bell,
	BellSlash,
	Copy,
	DotsThree,
	PencilSimple,
	Plus,
} from "@phosphor-icons/react";
import type { OsWorkspace } from "@tedix/api-contract/schemas/os-workspaces";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/kumo/button";
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
import { WorkspaceBlueprintDialog } from "@/components/workspace-blueprint-dialog";
import {
	BlueprintUpdateButton,
	BlueprintUpdateDialog,
	useBlueprintUpdate,
} from "@/components/workspace-blueprint-update";
import { ShareButton } from "@/components/share-controls";
import {
	WorkspaceShareDialog,
	type WorkspaceShareItem,
} from "@/components/workspace-share-dialog";

export function CanvasWorkspaceControls({
	workspace,
	showCreate = true,
	compactActions = false,
	openItem,
	menuItems,
	onSelected,
	onArchived,
}: {
	workspace?: OsWorkspace;
	showCreate?: boolean;
	compactActions?: boolean;
	/** The open app or file; Share also offers a link to it alone. */
	openItem?: WorkspaceShareItem;
	/** The host's own entries, listed first in the workspace menu. */
	menuItems?: ReactNode;
	onSelected: (workspaceId: string) => void;
	onArchived: () => void;
}) {
	const [createOpen, setCreateOpen] = useState(false);
	const [editOpen, setEditOpen] = useState(false);
	const [archiveOpen, setArchiveOpen] = useState(false);
	const [shareOpen, setShareOpen] = useState(false);
	const [blueprintOpen, setBlueprintOpen] = useState(false);
	const [updateOpen, setUpdateOpen] = useState(false);
	const blueprintUpdate = useBlueprintUpdate(workspace);

	const {
		muted: pushMuted,
		disabled: pushMuteDisabled,
		toggle: togglePushMute,
	} = useWorkspaceMute(workspace?.id);

	return (
		<>
			<div
				className={
					compactActions
						? "flex items-center gap-1"
						: "flex flex-wrap items-center gap-2"
				}
			>
				{showCreate ? (
					<Button onClick={() => setCreateOpen(true)}>
						<Plus size={14} /> New workspace
					</Button>
				) : null}
				{workspace && (
					<>
						{blueprintUpdate ? (
							<BlueprintUpdateButton
								compact={compactActions}
								revision={blueprintUpdate.candidate.revision}
								blueprintName={blueprintUpdate.blueprintName}
								onOpen={() => setUpdateOpen(true)}
							/>
						) : null}
						<ShareButton
							compact={compactActions}
							title="Share workspace"
							expanded={shareOpen}
							onClick={() => setShareOpen(true)}
						/>
						{/* The compact header keeps Share as its one icon; Edit, mute and
						    Archive live in the menu. */}
						{!compactActions && (
							<span className="hidden items-center gap-2 sm:flex">
								<Button
									size="sm"
									variant="outline"
									onClick={() => setEditOpen(true)}
								>
									<PencilSimple size={14} /> Edit
								</Button>
								<Button
									disabled={pushMuteDisabled}
									size="sm"
									title={
										pushMuted
											? "Notifications muted — approvals still arrive"
											: "Mute notifications"
									}
									variant="ghost"
									onClick={togglePushMute}
								>
									{pushMuted ? <BellSlash size={14} /> : <Bell size={14} />}
									{pushMuted ? "Unmute" : "Mute"}
								</Button>
								<Button
									size="sm"
									variant="ghost"
									onClick={() => setArchiveOpen(true)}
								>
									<Archive size={14} /> Archive
								</Button>
							</span>
						)}
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										aria-label="Workspace actions"
										size="icon-sm"
										variant={compactActions ? "ghost" : "outline"}
									/>
								}
							>
								<DotsThree size={16} weight="bold" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								{menuItems ? (
									<>
										{menuItems}
										<DropdownMenuSeparator />
									</>
								) : null}
								{blueprintUpdate ? (
									<DropdownMenuItem onClick={() => setUpdateOpen(true)}>
										<ArrowCircleUp size={14} /> Update available
									</DropdownMenuItem>
								) : null}
								<DropdownMenuItem onClick={() => setBlueprintOpen(true)}>
									<Copy size={14} /> Save as blueprint
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => setEditOpen(true)}>
									<PencilSimple size={14} /> Edit workspace
								</DropdownMenuItem>
								<DropdownMenuItem
									disabled={pushMuteDisabled}
									onClick={togglePushMute}
								>
									{pushMuted ? <Bell size={14} /> : <BellSlash size={14} />}
									{pushMuted ? "Unmute notifications" : "Mute notifications"}
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									variant="destructive"
									onClick={() => setArchiveOpen(true)}
								>
									<Archive size={14} /> Archive workspace
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</>
				)}
			</div>
			{showCreate ? (
				<WorkspaceFormDialog
					mode="create"
					open={createOpen}
					onOpenChange={setCreateOpen}
					onSaved={(saved) => onSelected(saved.id)}
				/>
			) : null}
			{workspace && (
				<>
					{updateOpen && blueprintUpdate ? (
						<BlueprintUpdateDialog
							workspace={workspace}
							blueprintName={blueprintUpdate.blueprintName}
							candidate={blueprintUpdate.candidate}
							onOpenChange={setUpdateOpen}
						/>
					) : null}
					{blueprintOpen ? (
						<WorkspaceBlueprintDialog
							workspace={workspace}
							onOpenChange={setBlueprintOpen}
						/>
					) : null}
					{shareOpen ? (
						<WorkspaceShareDialog
							workspaceId={workspace.id}
							workspaceName={workspace.name}
							visibility={workspace.visibility}
							item={openItem}
							open
							onOpenChange={setShareOpen}
						/>
					) : null}
					<WorkspaceFormDialog
						mode="edit"
						open={editOpen}
						workspace={workspace}
						onOpenChange={setEditOpen}
						onSaved={(saved) => onSelected(saved.id)}
					/>
					<WorkspaceArchiveDialog
						workspace={workspace}
						open={archiveOpen}
						onOpenChange={setArchiveOpen}
						onArchived={onArchived}
					/>
				</>
			)}
		</>
	);
}
