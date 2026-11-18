import {
	Archive,
	ArrowSquareOut,
	DotsThree,
	PencilSimple,
} from "@phosphor-icons/react";
import { useId, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { Input } from "@/components/kumo/input";
import { useOutputFileActions } from "@/components/output-file-actions";
import {
	MAX_WORKSPACE_ITEM_NAME,
	useWorkspaceItemActions,
} from "@/components/workspace-item-menu";

/**
 * The "…" button on a workspace file card. It offers what the Files list row
 * menu offers: open, rename, version history, a copy, a move to another
 * workspace, and archive. A card has no room to rename in place, so the new
 * name is typed in a dialog. The server decides whether each action is
 * allowed; a refusal is shown and nothing changes.
 */
export function WorkspaceFileCardMenu({
	workspaceId,
	outputId,
	title,
	kindLabel,
	onOpen,
	onGone,
}: {
	workspaceId: string;
	outputId: string;
	title: string;
	kindLabel: string;
	onOpen: () => void;
	/** The file was archived or moved away; close whatever was showing it. */
	onGone?: () => void;
}) {
	const { rename, archive } = useWorkspaceItemActions(workspaceId, {
		title,
		kindLabel,
		outputId,
	});
	const file = useOutputFileActions(
		{ outputId, title, workspaceId },
		{ onMoved: onGone },
	);
	const [draft, setDraft] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);
	const formId = useId();
	const name = (draft ?? "").trim().slice(0, MAX_WORKSPACE_ITEM_NAME);
	const saveName = () => {
		if (!name || name === title) return setDraft(null);
		rename.mutate(name, { onSuccess: () => setDraft(null) });
	};
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label={`Actions for ${title}`}
							title="File actions"
							size="icon-sm"
							variant="ghost"
							className="relative z-10"
						/>
					}
				>
					<DotsThree size={16} weight="bold" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={onOpen}>
						<ArrowSquareOut size={14} /> Open
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => {
							rename.reset();
							setDraft(title);
						}}
					>
						<PencilSimple size={14} /> Rename
					</DropdownMenuItem>
					{file.entries.map((entry) => (
						<DropdownMenuItem key={entry.key} onClick={entry.onSelect}>
							{entry.icon} {entry.label}
						</DropdownMenuItem>
					))}
					<DropdownMenuSeparator />
					<DropdownMenuItem
						variant="danger"
						onClick={() => {
							archive.reset();
							setConfirming(true);
						}}
					>
						<Archive size={14} /> Archive
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{file.dialogs}
			<ConfirmDialog
				open={draft !== null}
				onOpenChange={(open) => !open && setDraft(null)}
				title={`Rename “${title}”`}
				description="The new name shows everywhere this file is listed."
				confirmLabel="Rename"
				pendingLabel="Renaming…"
				isPending={rename.isPending}
				confirmDisabled={!name}
				error={rename.error}
				form={formId}
				onConfirm={saveName}
			>
				<form
					id={formId}
					onSubmit={(event) => {
						event.preventDefault();
						saveName();
					}}
				>
					<Input
						aria-label="File name"
						autoFocus
						maxLength={MAX_WORKSPACE_ITEM_NAME}
						value={draft ?? ""}
						onChange={(event) => setDraft(event.target.value)}
					/>
				</form>
			</ConfirmDialog>
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title={`Archive “${title}”?`}
				description={`This ${kindLabel.toLowerCase()} leaves the workspace's Files. Nothing is deleted: its history is kept and it can be restored from the Files library.`}
				confirmLabel="Archive"
				pendingLabel="Archiving…"
				destructive
				isPending={archive.isPending}
				error={archive.error}
				onConfirm={() =>
					archive.mutate(undefined, {
						onSuccess: () => {
							setConfirming(false);
							onGone?.();
						},
					})
				}
			/>
		</>
	);
}
