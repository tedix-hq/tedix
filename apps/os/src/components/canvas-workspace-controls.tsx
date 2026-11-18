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
	WorkspaceMuteDialog,
	WorkspaceFormDialog,
} from "@/components/workspace-actions";
import { WorkspaceBlueprintDialog } from "@/components/workspace-blueprint-dialog";
import {
	BlueprintUpdateButton,
	BlueprintUpdateDialog,
	useBlueprintUpdate,
} from "@/components/workspace-blueprint-update";
import { ShareButton } from "@/components/share-controls";
import { useWorkspaceLeave } from "@/components/workspace-leave";
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
	const leave = useWorkspaceLeave(workspace, onArchived);

	const [muteOpen, setMuteOpen] = useState(false);
	const mute = useWorkspaceMute(workspace?.id);

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
									disabled={mute.disabled}
									size="sm"
									title={
										mute.muted
											? `${mute.label}. Approval requests still reach you.`
											: "Mute notifications"
									}
									variant="ghost"
									onClick={mute.muted ? mute.unmute : () => setMuteOpen(true)}
								>
									{mute.muted ? <BellSlash size={14} /> : <Bell size={14} />}
									{mute.muted ? "Unmute" : "Mute"}
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
								{mute.muted ? (
									<>
										<DropdownMenuItem disabled>
											<BellSlash size={14} /> {mute.label}
										</DropdownMenuItem>
										<DropdownMenuItem
											disabled={mute.disabled}
											onClick={mute.unmute}
										>
											<Bell size={14} /> Unmute
										</DropdownMenuItem>
									</>
								) : (
									<DropdownMenuItem
										disabled={mute.disabled}
										onClick={() => setMuteOpen(true)}
									>
										<BellSlash size={14} /> Mute notifications…
									</DropdownMenuItem>
								)}
								<DropdownMenuSeparator />
								<DropdownMenuItem
									variant="destructive"
									onClick={() => setArchiveOpen(true)}
								>
									<Archive size={14} /> Archive workspace
								</DropdownMenuItem>
								{leave.menuItem}
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
					{muteOpen ? (
						<WorkspaceMuteDialog
							workspaceName={workspace.name}
							open
							onOpenChange={setMuteOpen}
							onChoose={mute.mute}
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
					{leave.dialog}
				</>
			)}
		</>
	);
}
