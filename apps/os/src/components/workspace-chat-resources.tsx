import { Plus } from "@phosphor-icons/react";
import { useState } from "react";
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
}: {
	workspaceId: string;
	onBrowseResources: () => void;
}) {
	const [open, setOpen] = useState(false);
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
