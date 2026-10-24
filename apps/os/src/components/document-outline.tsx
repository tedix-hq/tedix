import { ListDashes } from "@phosphor-icons/react";
import type { Editor } from "@tiptap/core";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";

export interface DocumentOutlineItem {
	/** Heading level, 1-3; a Title-styled heading reports 1. */
	level: number;
	text: string;
	/** Editor position of the heading, or its index among top-level blocks. */
	position: number;
}

/** Top-level headings of an editor document, in order. */
export function editorOutline(editor: Editor): DocumentOutlineItem[] {
	const items: DocumentOutlineItem[] = [];
	editor.state.doc.forEach((node, offset) => {
		if (node.type.name !== "heading") return;
		const text = node.textContent.trim();
		if (!text) return;
		items.push({
			level: Number(node.attrs.level) || 1,
			text,
			position: offset,
		});
	});
	return items;
}

interface RichNodeLike {
	type: string;
	text?: string;
	attrs?: Record<string, unknown> | null;
	content?: readonly RichNodeLike[] | null;
}

const plainText = (node: RichNodeLike): string =>
	node.type === "text"
		? (node.text ?? "")
		: (node.content ?? []).map(plainText).join("");

/** Top-level headings of a saved rich-text document, by block index. */
export function richTextOutline(
	content: readonly RichNodeLike[],
): DocumentOutlineItem[] {
	const items: DocumentOutlineItem[] = [];
	content.forEach((node, index) => {
		if (node.type !== "heading") return;
		const text = plainText(node).trim();
		if (!text) return;
		items.push({
			level: Number(node.attrs?.level) || 1,
			text,
			position: index,
		});
	});
	return items;
}

/** Index of the last heading at or before `position`, or -1. */
export function activeOutlineIndex(
	items: readonly DocumentOutlineItem[],
	position: number,
): number {
	let active = -1;
	for (const [index, item] of items.entries()) {
		if (item.position <= position) active = index;
		else break;
	}
	return active;
}

/**
 * The document's headings as a jump list. Indentation follows the heading
 * level so the shape of the document reads at a glance; the current section is
 * marked for sighted readers and announced with `aria-current`.
 */
export function DocumentOutline({
	items,
	activeIndex,
	onSelect,
	disabled,
	label = "Outline",
	emptyHint = "Headings you add appear here.",
}: {
	items: readonly DocumentOutlineItem[];
	activeIndex: number;
	onSelect: (item: DocumentOutlineItem) => void;
	disabled?: boolean;
	label?: string;
	emptyHint?: string;
}) {
	const minLevel = Math.min(3, ...items.map((item) => item.level));
	return (
		<nav
			aria-label={label}
			className="document-outline grid content-start gap-2"
		>
			<Text
				as="h2"
				role="caption"
				tone="secondary"
				weight="semibold"
				className="m-0 flex items-center gap-1.5 px-2"
			>
				<ListDashes size={14} aria-hidden />
				{label}
			</Text>
			{items.length === 0 ? (
				<Text as="p" role="caption" tone="secondary" className="m-0 px-2">
					{emptyHint}
				</Text>
			) : (
				<ol className="m-0 grid list-none gap-px p-0">
					{items.map((item, index) => (
						<li key={`${item.position}-${index}`}>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="document-outline-link"
								data-level={Math.min(3, item.level - minLevel + 1)}
								aria-current={index === activeIndex ? "location" : undefined}
								disabled={disabled}
								title={item.text}
								onClick={() => onSelect(item)}
							>
								<span className="truncate">{item.text}</span>
							</Button>
						</li>
					))}
				</ol>
			)}
		</nav>
	);
}
