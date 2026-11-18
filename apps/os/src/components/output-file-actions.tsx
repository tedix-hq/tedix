import {
	ArrowsLeftRight,
	ClockCounterClockwise,
	Copy,
	DotsThree,
} from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OsOutput } from "@tedix/api-contract/schemas/os-workspaces";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { toast } from "@/components/kumo/toast";
import { MoveOutputDialog } from "@/components/output-move-dialog";
import { OutputVersionHistoryDialog } from "@/components/output-version-history";
import { osApi } from "@/lib/api";
import { fileActionRefusal } from "@/lib/file-action-refusal";
import { osQueryKeys } from "@/lib/os-query-options";

export interface OutputFile {
	outputId: string;
	title: string;
	/** The workspace the file is in; null for a file outside any workspace. */
	workspaceId: string | null;
}

export interface OutputFileActionEntry {
	key: "history" | "duplicate" | "move";
	label: string;
	icon: ReactNode;
	onSelect: () => void;
}

/**
 * Housekeeping for one file: its version history, a copy next to it, and a
 * move to another workspace. Returns the menu entries and the dialogs they
 * open, so a row menu and a page menu offer exactly the same things.
 */
export function useOutputFileActions(
	file: OutputFile,
	events: {
		onDuplicated?: (copy: OsOutput) => void;
		onMoved?: (target: { id: string; name: string }) => void;
	} = {},
): { entries: OutputFileActionEntry[]; dialogs: ReactNode } {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState<"history" | "move" | null>(null);
	const duplicate = useMutation({
		mutationFn: () =>
			osApi.osWorkspaces.outputs.duplicate({ outputId: file.outputId }),
		onSuccess: async ({ output }) => {
			toast.success(`Created “${output.title}”`);
			events.onDuplicated?.(output);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: osQueryKeys.outputs() }),
				queryClient.invalidateQueries({ queryKey: osQueryKeys.gadgets() }),
			]);
		},
		onError: (error) =>
			toast.error(`“${file.title}” was not duplicated`, {
				description: fileActionRefusal(error, "duplicate this file"),
			}),
	});
	return {
		entries: [
			{
				key: "history",
				label: "Version history",
				icon: <ClockCounterClockwise size={14} />,
				onSelect: () => setOpen("history"),
			},
			{
				key: "duplicate",
				label: "Duplicate",
				icon: <Copy size={14} />,
				onSelect: () => !duplicate.isPending && duplicate.mutate(),
			},
			{
				key: "move",
				label: "Move to workspace…",
				icon: <ArrowsLeftRight size={14} />,
				onSelect: () => setOpen("move"),
			},
		],
		dialogs: (
			<>
				{open === "history" && (
					<OutputVersionHistoryDialog
						outputId={file.outputId}
						title={file.title}
						onClose={() => setOpen(null)}
					/>
				)}
				{open === "move" && (
					<MoveOutputDialog
						outputId={file.outputId}
						title={file.title}
						workspaceId={file.workspaceId}
						onClose={() => setOpen(null)}
						onMoved={(target) => {
							toast.success(`Moved “${file.title}” to ${target.name}`);
							events.onMoved?.(target);
						}}
					/>
				)}
			</>
		),
	};
}

/** The same file actions as a "…" button, for a page that shows one file. */
export function OutputFileMenuButton({
	title,
	entries,
	className,
}: {
	title: string;
	entries: OutputFileActionEntry[];
	className?: string;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label={`More actions for ${title}`}
						className={className}
						size="icon-sm"
						variant="outline"
					>
						<DotsThree size={16} weight="bold" />
					</Button>
				}
			/>
			<DropdownMenuContent align="end">
				{entries.map((entry) => (
					<DropdownMenuItem key={entry.key} onClick={entry.onSelect}>
						{entry.icon} {entry.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
