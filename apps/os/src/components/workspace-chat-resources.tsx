import { FileText, Plus, UploadSimple } from "@phosphor-icons/react";
import { useRef, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { canvasOutputsQueryOptions } from "@/lib/os-query-options";
import { LoadingArea } from "@/components/loading-area";
import { Text } from "@/components/kumo/text";
import { Button } from "@/components/kumo/button";
import {
	PopoverContent,
	PopoverDescription,
	PopoverRoot,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/kumo/popover";

/** Workspace resources remain subject to their existing access rules. */
export function WorkspaceChatResources({
	workspaceId,
	onBrowseResources,
	onSelect,
	onUploadFiles,
	selectedIds,
	messageBox,
}: {
	workspaceId: string;
	onBrowseResources: () => void;
	onSelect: (file: { outputId: string; title: string }) => void;
	/** Files picked from the computer; saved to the workspace and added like a drop. */
	onUploadFiles: (files: File[]) => void;
	selectedIds: string[];
	/** Typing continues here once a file is added or the panel closes. */
	messageBox?: RefObject<HTMLTextAreaElement | null>;
}) {
	const [open, setOpen] = useState(false);
	const picker = useRef<HTMLInputElement>(null);
	const outputs = useQuery({
		...canvasOutputsQueryOptions(workspaceId),
		enabled: open,
	});
	return (
		<PopoverRoot open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button
						aria-label="Add files"
						title="Add files"
						size="icon-sm"
						variant="ghost"
					/>
				}
			>
				<Plus aria-hidden />
			</PopoverTrigger>
			<PopoverContent
				align="start"
				side="top"
				className="grid w-72 gap-3 p-4"
				finalFocus={messageBox}
			>
				<PopoverTitle>Add to your message</PopoverTitle>
				<PopoverDescription>
					Add up to 5 files from this workspace or from your computer. Files
					from your computer are saved to this workspace. The assistant can read
					text, Markdown, code, PDF, spreadsheet, CSV, Word and PowerPoint
					files; for other files it sees only the name. You can also drop or
					paste files into the chat.
				</PopoverDescription>
				{outputs.isError ? (
					<Text role="caption" tone="error">
						Files could not be loaded.
					</Text>
				) : outputs.isPending ? (
					<LoadingArea className="h-16" size="base" label="Loading files" />
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
									className="justify-start"
									size="sm"
									variant="ghost"
									disabled={
										selectedIds.includes(file.id) || selectedIds.length >= 5
									}
									onClick={() => {
										onSelect({ outputId: file.id, title: file.title });
										setOpen(false);
									}}
								>
									<FileText aria-hidden size={14} />
									<span className="truncate">{file.title}</span>
								</Button>
							))}
						{outputs.data?.items.length === 0 ? (
							<Text role="caption">No files to select.</Text>
						) : null}
					</div>
				)}
				<input
					ref={picker}
					type="file"
					multiple
					className="hidden"
					aria-label="Choose files from your computer"
					onChange={(event) => {
						const files = Array.from(event.currentTarget.files ?? []);
						event.currentTarget.value = "";
						if (files.length === 0) return;
						onUploadFiles(files);
						setOpen(false);
					}}
				/>
				<Button
					onClick={() => picker.current?.click()}
					size="sm"
					variant="outline"
					disabled={selectedIds.length >= 5}
					icon={<UploadSimple size={14} aria-hidden />}
				>
					Choose from your computer
				</Button>
				<Button
					onClick={() => {
						setOpen(false);
						onBrowseResources();
					}}
					size="sm"
					variant="outline"
				>
					Browse all files
				</Button>
			</PopoverContent>
		</PopoverRoot>
	);
}
