import { DotsThree, DownloadSimple } from "@phosphor-icons/react";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { Text } from "@/components/kumo/text";

/** Saves `text` to the person's device under `name`. */
export function downloadTextFile(name: string, text: string) {
	const url = URL.createObjectURL(
		new Blob([text], { type: "text/plain;charset=utf-8" }),
	);
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The file column of an app's Edit view: one compact row per file, each with
 * a "…" menu for what can be done with that file.
 */
export function CanvasCodeFiles({
	files,
	current,
	onSelect,
	textFor,
}: {
	files: readonly { path: string; hint: string }[];
	current: string;
	onSelect: (path: string) => void;
	/** The file's text as the person sees it now, unsaved edits included. */
	textFor: (path: string) => string;
}) {
	return (
		<aside className="canvas-code-files" aria-label="Code files">
			<Text
				as="h3"
				role="label"
				tone="secondary"
				className="canvas-code-files-heading m-0"
			>
				Files
			</Text>
			{files.map((file) => (
				<div
					key={file.path}
					className="canvas-code-file-row"
					data-canvas-code-file-row={file.path}
				>
					<Button
						size="sm"
						variant="ghost"
						className="canvas-code-file-button"
						aria-current={current === file.path ? "page" : undefined}
						aria-label={file.path}
						title={file.hint}
						onClick={() => onSelect(file.path)}
					>
						{file.path}
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									aria-label={`More for ${file.path}`}
									className="canvas-code-file-more"
									size="icon-sm"
									variant="ghost"
								>
									<DotsThree size={16} weight="bold" />
								</Button>
							}
						/>
						<DropdownMenuContent align="end">
							<DropdownMenuItem
								onClick={() =>
									downloadTextFile(
										file.path.split("/").pop() || file.path,
										textFor(file.path),
									)
								}
							>
								<DownloadSimple size={14} /> Download
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			))}
		</aside>
	);
}
