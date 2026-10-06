import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";
import { Button } from "@/components/kumo/button";
import { PopoverRoot, PopoverContent } from "@/components/kumo/popover";

/** Links remain editable, with an explicit navigation action beside their destination. */
export function DocumentLinkPopover({
	editor,
	disabled,
	onEdit,
}: {
	editor: Editor;
	disabled: boolean;
	onEdit: () => void;
}) {
	const [anchor, setAnchor] = useState<HTMLAnchorElement | null>(null);
	const [dismissed, setDismissed] = useState(false);
	useEffect(() => {
		const update = () => {
			const position = editor.state.selection.from;
			const node = editor.view.domAtPos(position).node;
			const element = node instanceof Element ? node : node.parentElement;
			const link =
				element?.closest<HTMLAnchorElement>("a") ??
				(element?.childNodes[editor.view.domAtPos(position).offset] instanceof
				HTMLAnchorElement
					? (element.childNodes[
							editor.view.domAtPos(position).offset
						] as HTMLAnchorElement)
					: null);
			setAnchor(link && editor.view.dom.contains(link) ? link : null);
			setDismissed(false);
		};
		editor.on("selectionUpdate", update);
		editor.on("update", update);
		return () => {
			editor.off("selectionUpdate", update);
			editor.off("update", update);
		};
	}, [editor]);
	const href = anchor?.getAttribute("href") ?? "";
	const navigable = /^(https?:\/\/|mailto:|tel:)/i.test(href);
	return (
		<PopoverRoot
			open={Boolean(anchor) && !dismissed}
			onOpenChange={(open) => {
				if (!open) setDismissed(true);
			}}
		>
			<PopoverContent
				anchor={anchor}
				initialFocus={false}
				finalFocus={false}
				align="start"
				className="max-w-[min(24rem,calc(100vw-2rem))] gap-2 p-2"
				aria-label="Document link"
			>
				<span className="truncate text-xs text-kumo-subtle">{href}</span>
				<div className="flex items-center gap-1">
					{navigable && (
						<Button
							size="sm"
							variant="secondary"
							render={
								<a href={href} target="_blank" rel="noopener noreferrer" />
							}
						>
							Open link
						</Button>
					)}
					<Button
						size="sm"
						variant="ghost"
						disabled={disabled}
						onClick={() => {
							setDismissed(true);
							onEdit();
						}}
					>
						Edit link
					</Button>
					<Button
						size="sm"
						variant="ghost"
						disabled={disabled}
						onClick={() => {
							editor.chain().focus().extendMarkRange("link").unsetLink().run();
							setDismissed(true);
						}}
					>
						Remove link
					</Button>
				</div>
			</PopoverContent>
		</PopoverRoot>
	);
}
