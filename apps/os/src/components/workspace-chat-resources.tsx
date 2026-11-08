import { Plus } from "@phosphor-icons/react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { canvasOutputsQueryOptions } from "@/lib/os-query-options";
import { Text } from "@/components/kumo/text";
import { Button } from "@/components/kumo/button";
import {
	PopoverContent,
	PopoverDescription,
	PopoverRoot,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/kumo/popover";
import { WorkspaceFileUpload } from "@/components/workspace-file-upload";

/** Workspace resources remain subject to their existing access rules. */
export function WorkspaceChatResources({
	workspaceId,
	onBrowseResources,
	onSelect,
	selectedIds,
}: {
	workspaceId: string;
	onBrowseResources: () => void;
	onSelect: (file: { outputId: string; title: string }) => void;
	selectedIds: string[];
}) {
	const [open, setOpen] = useState(false);
	const outputs = useQuery({
		...canvasOutputsQueryOptions(workspaceId),
		enabled: open,
	});
	return (
		<PopoverRoot open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button
						aria-label="Workspace resources"
						size="icon-sm"
						variant="ghost"
					/>
				}
			>
				<Plus aria-hidden />
			</PopoverTrigger>
			<PopoverContent align="start" side="top" className="grid w-72 gap-3 p-4">
				<PopoverTitle>Workspace resources</PopoverTitle>
				<PopoverDescription>
					Upload a file to this workspace, or browse its files, sources and
					skills. Uploads are not automatically added to your message.
				</PopoverDescription>
				<Text role="caption" tone="secondary">
					Select up to 5 native documents, sheets or slides (64 KB total) for
					your next message. Uploaded file bytes, connected sources and videos
					cannot be read here yet.
				</Text>
				{outputs.isError ? (
					<Text role="caption" tone="error">
						Files could not be loaded.
					</Text>
				) : outputs.isPending ? (
					<Text role="caption">Loading files…</Text>
				) : (
					<div
						className="grid max-h-48 gap-1 overflow-y-auto"
						data-focus-ring="inset"
						aria-label="Select message files"
					>
						{(outputs.data?.items ?? [])
							.filter((file) => file.status === "active")
							.map((file) => (
								<Button
									key={file.id}
									size="sm"
									variant="outline"
									disabled={
										selectedIds.includes(file.id) || selectedIds.length >= 5
									}
									onClick={() => {
										onSelect({ outputId: file.id, title: file.title });
										setOpen(false);
									}}
								>
									<span className="truncate">{file.title}</span>
								</Button>
							))}
						{outputs.data?.items.length === 0 ? (
							<Text role="caption">No files to select.</Text>
						) : null}
					</div>
				)}
				<WorkspaceFileUpload workspaceId={workspaceId} />
				<Button
					onClick={() => {
						setOpen(false);
						onBrowseResources();
					}}
					size="sm"
					variant="outline"
				>
					Browse files, sources and skills
				</Button>
			</PopoverContent>
		</PopoverRoot>
	);
}
