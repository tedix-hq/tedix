import type { Editor } from "@tiptap/core";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Text } from "@/components/kumo/text";
import {
	type DocumentBlock,
	DocumentBlockRow,
	filterDocumentBlocks,
} from "@/components/document-block-library";

/** A `/query` typed at the start of an otherwise empty paragraph. */
export interface SlashQuery {
	from: number;
	to: number;
	query: string;
}

const SLASH = /^\/([^\s/]{0,32}(?: [^\s/]{0,32})?)$/u;

/** The slash query under a collapsed caret, or null when there is none. */
export function slashQuery(editor: Editor): SlashQuery | null {
	const { selection } = editor.state;
	if (!selection.empty || !editor.isEditable) return null;
	const { $from } = selection;
	if ($from.parent.type.name !== "paragraph") return null;
	const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "￼");
	const match = SLASH.exec(before);
	if (!match) return null;
	return { from: $from.start(), to: $from.pos, query: match[1] ?? "" };
}

const MENU_WIDTH = 304;
const MENU_MAX_HEIGHT = 340;
const GAP = 6;

/**
 * The block menu a `/` opens at the caret. The caret never leaves the page:
 * arrow keys move the highlight, Enter or Tab inserts, Escape closes it and
 * leaves the typed text alone, and typing narrows the list.
 */
export function useDocumentSlashMenu(
	editor: Editor | null,
	onInsert: (block: DocumentBlock, range: SlashQuery) => void,
) {
	const [query, setQuery] = useState<SlashQuery | null>(null);
	const [index, setIndex] = useState(0);
	const dismissedAt = useRef<number | null>(null);
	const latest = useRef({ query, index, matches: [] as DocumentBlock[] });
	const onInsertRef = useRef(onInsert);
	onInsertRef.current = onInsert;

	const matches = query ? filterDocumentBlocks(query.query) : [];
	latest.current = { query, index, matches };

	useEffect(() => {
		if (!editor) return;
		const update = () => {
			const next = slashQuery(editor);
			if (!next) dismissedAt.current = null;
			const open = next && dismissedAt.current !== next.from ? next : null;
			setQuery((current) =>
				current?.from === open?.from &&
				current?.to === open?.to &&
				current?.query === open?.query
					? current
					: open,
			);
		};
		const close = () => setQuery(null);
		editor.on("transaction", update);
		editor.on("blur", close);
		return () => {
			editor.off("transaction", update);
			editor.off("blur", close);
		};
	}, [editor]);

	// A new query starts the highlight at the best match.
	const queryText = query?.query;
	useEffect(() => setIndex(0), [queryText]);

	/** Keyboard handling, called from the editor before ProseMirror sees a key. */
	const handleKeyDown = (event: KeyboardEvent): boolean => {
		const { query: open, index: active, matches: list } = latest.current;
		if (!open) return false;
		if (event.key === "Escape") {
			dismissedAt.current = open.from;
			setQuery(null);
			return true;
		}
		if (list.length === 0) return false;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			const step = event.key === "ArrowDown" ? 1 : -1;
			setIndex((active + step + list.length) % list.length);
			return true;
		}
		if (event.key === "Enter" || event.key === "Tab") {
			const block = list[Math.min(active, list.length - 1)];
			if (!block) return false;
			setQuery(null);
			onInsertRef.current(block, open);
			return true;
		}
		return false;
	};

	const choose = (block: DocumentBlock) => {
		const open = latest.current.query;
		if (!open) return;
		setQuery(null);
		onInsertRef.current(block, open);
	};

	return { query, matches, index, setIndex, handleKeyDown, choose };
}

export function DocumentSlashMenu({
	editor,
	query,
	matches,
	index,
	onHover,
	onChoose,
}: {
	editor: Editor;
	query: SlashQuery | null;
	matches: readonly DocumentBlock[];
	index: number;
	onHover: (index: number) => void;
	onChoose: (block: DocumentBlock) => void;
}) {
	const listId = useId();
	const [place, setPlace] = useState<{
		left: number;
		top?: number;
		bottom?: number;
	} | null>(null);
	const from = query?.from;

	useLayoutEffect(() => {
		if (from === undefined || editor.isDestroyed) {
			setPlace(null);
			return;
		}
		const measure = () => {
			if (editor.isDestroyed) return;
			const caret = editor.view.coordsAtPos(from);
			const left = Math.max(
				8,
				Math.min(caret.left - 4, window.innerWidth - MENU_WIDTH - 8),
			);
			const roomBelow = window.innerHeight - caret.bottom;
			setPlace(
				roomBelow >= Math.min(MENU_MAX_HEIGHT, 220) + GAP ||
					roomBelow >= caret.top
					? { left, top: caret.bottom + GAP }
					: { left, bottom: window.innerHeight - caret.top + GAP },
			);
		};
		measure();
		window.addEventListener("resize", measure);
		window.addEventListener("scroll", measure, true);
		return () => {
			window.removeEventListener("resize", measure);
			window.removeEventListener("scroll", measure, true);
		};
	}, [editor, from]);

	// The page keeps focus, so the highlighted option is announced through
	// aria-activedescendant on the editable surface.
	const activeId = matches.length && query ? `${listId}-${index}` : null;
	useEffect(() => {
		if (editor.isDestroyed) return;
		const dom = editor.view.dom;
		if (query) {
			dom.setAttribute("aria-controls", listId);
			if (activeId) dom.setAttribute("aria-activedescendant", activeId);
			else dom.removeAttribute("aria-activedescendant");
		}
		return () => {
			dom.removeAttribute("aria-controls");
			dom.removeAttribute("aria-activedescendant");
		};
	}, [editor, query, listId, activeId]);

	useEffect(() => {
		if (!activeId) return;
		document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
	}, [activeId]);

	if (!query || !place) return null;
	return createPortal(
		<div
			className="document-slash-menu"
			style={{ left: place.left, top: place.top, bottom: place.bottom }}
			data-document-slash-menu
		>
			<div
				id={listId}
				role="listbox"
				aria-label="Insert a block"
				className="grid gap-px"
			>
				{matches.length === 0 ? (
					<Text
						as="p"
						role="caption"
						tone="secondary"
						className="m-0 px-2 py-1.5"
					>
						No block matches “{query.query}”. Press Esc to keep the text.
					</Text>
				) : (
					matches.map((block, position) => (
						<DocumentBlockRow
							key={block.id}
							id={`${listId}-${position}`}
							role="option"
							block={block}
							active={position === index}
							onHover={() => onHover(position)}
							onInsert={onChoose}
						/>
					))
				)}
			</div>
			<Text
				as="p"
				role="caption"
				tone="secondary"
				className="document-slash-hint m-0"
				aria-hidden
			>
				↑↓ to choose · Enter to insert · Esc to close
			</Text>
		</div>,
		document.body,
	);
}
