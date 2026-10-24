import {
	CaretCircleDown,
	CheckSquare,
	Code,
	ImageSquare,
	Info,
	Link as LinkIcon,
	ListBullets,
	ListNumbers,
	Minus,
	Paragraph,
	Plus,
	Quotes,
	Table,
	TextHOne,
	TextHThree,
	TextHTwo,
	type Icon,
} from "@phosphor-icons/react";
import type { Editor } from "@tiptap/core";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import {
	PopoverContent,
	PopoverRoot,
	PopoverTrigger,
} from "@/components/kumo/popover";
import { Text } from "@/components/kumo/text";
import { applyDocumentStyle } from "@/lib/document-formatting";

/** What a block needs from the editor beyond its own commands. */
export interface DocumentBlockActions {
	uploadImage(): void;
	imageFromUrl(): void;
}

export interface DocumentBlock {
	id: string;
	name: string;
	description: string;
	icon: Icon;
	/** Extra words the filter and the slash menu match. */
	keywords: string;
	/** The Markdown habit that makes the same block while typing, if any. */
	markdown?: string;
	insert(editor: Editor, actions: DocumentBlockActions): void;
}

export type DocumentBlockGroupName = "Text" | "Lists" | "Layout" | "Media";

const style =
	(value: Parameters<typeof applyDocumentStyle>[1]) => (editor: Editor) =>
		applyDocumentStyle(editor, value);

/** Every block a writer can add, grouped the way the library lists them. */
export const DOCUMENT_BLOCK_GROUPS: readonly {
	name: DocumentBlockGroupName;
	blocks: readonly DocumentBlock[];
}[] = [
	{
		name: "Text",
		blocks: [
			{
				id: "paragraph",
				name: "Text",
				description: "Plain paragraph",
				icon: Paragraph,
				keywords: "paragraph normal body",
				insert: style("paragraph"),
			},
			{
				id: "heading-1",
				name: "Heading 1",
				description: "Large section heading",
				icon: TextHOne,
				keywords: "h1 title section",
				markdown: "#",
				insert: style("1"),
			},
			{
				id: "heading-2",
				name: "Heading 2",
				description: "Medium section heading",
				icon: TextHTwo,
				keywords: "h2 subtitle subsection",
				markdown: "##",
				insert: style("2"),
			},
			{
				id: "heading-3",
				name: "Heading 3",
				description: "Small section heading",
				icon: TextHThree,
				keywords: "h3 subheading",
				markdown: "###",
				insert: style("3"),
			},
			{
				id: "quote",
				name: "Quote",
				description: "Set a passage apart",
				icon: Quotes,
				keywords: "blockquote citation",
				markdown: ">",
				insert: style("quote"),
			},
			{
				id: "code",
				name: "Code block",
				description: "Monospaced code",
				icon: Code,
				keywords: "pre snippet monospace",
				markdown: "```",
				insert: style("code"),
			},
		],
	},
	{
		name: "Lists",
		blocks: [
			{
				id: "bullet-list",
				name: "Bulleted list",
				description: "Points in no particular order",
				icon: ListBullets,
				keywords: "ul unordered bullets",
				markdown: "-",
				insert: (editor) => editor.chain().focus().toggleBulletList().run(),
			},
			{
				id: "numbered-list",
				name: "Numbered list",
				description: "Steps in order",
				icon: ListNumbers,
				keywords: "ol ordered steps",
				markdown: "1.",
				insert: (editor) => editor.chain().focus().toggleOrderedList().run(),
			},
			{
				id: "checklist",
				name: "Checklist",
				description: "Tasks you can tick off",
				icon: CheckSquare,
				keywords: "todo tasks checkbox",
				markdown: "[ ]",
				insert: (editor) => editor.chain().focus().toggleTaskList().run(),
			},
		],
	},
	{
		name: "Layout",
		blocks: [
			{
				id: "table",
				name: "Table",
				description: "Grid with a header row",
				icon: Table,
				keywords: "grid rows columns",
				insert: (editor) =>
					editor
						.chain()
						.focus()
						.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
						.run(),
			},
			{
				id: "callout",
				name: "Note",
				description: "Highlighted box for a key point",
				icon: Info,
				keywords: "callout aside tip warning",
				insert: (editor) =>
					editor
						.chain()
						.focus()
						.insertContent({
							type: "callout",
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "Note" }],
								},
							],
						})
						.run(),
			},
			{
				id: "toggle",
				name: "Toggle section",
				description: "Details a reader can open",
				icon: CaretCircleDown,
				keywords: "details collapse expand accordion",
				insert: (editor) => editor.chain().focus().setDetails().run(),
			},
			{
				id: "divider",
				name: "Divider",
				description: "Line between sections",
				icon: Minus,
				keywords: "horizontal rule hr separator",
				markdown: "---",
				insert: (editor) => editor.chain().focus().setHorizontalRule().run(),
			},
		],
	},
	{
		name: "Media",
		blocks: [
			{
				id: "image-upload",
				name: "Image",
				description: "Upload from this device",
				icon: ImageSquare,
				keywords: "picture photo upload file",
				insert: (_editor, actions) => actions.uploadImage(),
			},
			{
				id: "image-url",
				name: "Image from a link",
				description: "Picture already on the web",
				icon: LinkIcon,
				keywords: "picture photo url web",
				insert: (_editor, actions) => actions.imageFromUrl(),
			},
		],
	},
];

const ALL_BLOCKS = DOCUMENT_BLOCK_GROUPS.flatMap((group) => group.blocks);

/** Blocks whose name, description or keywords contain every typed word. */
export function filterDocumentBlocks(query: string): DocumentBlock[] {
	const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return ALL_BLOCKS;
	return ALL_BLOCKS.filter((block) => {
		const haystack =
			`${block.name} ${block.description} ${block.keywords}`.toLocaleLowerCase();
		return words.every((word) => haystack.includes(word));
	});
}

/** One library row: icon, name and a one-line description. */
export function DocumentBlockRow({
	block,
	disabled,
	active,
	id,
	role,
	onInsert,
	onHover,
}: {
	block: DocumentBlock;
	disabled?: boolean;
	/** Highlighted by the keyboard in the slash menu. */
	active?: boolean;
	id?: string;
	role?: "option";
	onInsert: (block: DocumentBlock) => void;
	onHover?: () => void;
}) {
	const RowIcon = block.icon;
	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			multiline
			id={id}
			role={role}
			aria-selected={role === "option" ? Boolean(active) : undefined}
			tabIndex={role === "option" ? -1 : undefined}
			className="document-block-row h-auto w-full justify-start gap-2.5 px-2 py-1.5 text-left"
			data-document-block={block.id}
			data-active={active || undefined}
			aria-label={`${block.name}: ${block.description}`}
			disabled={disabled}
			// The slash menu keeps the caret in the page; a press must not blur it.
			onMouseDown={
				role === "option" ? (event) => event.preventDefault() : undefined
			}
			onMouseEnter={onHover}
			onClick={() => onInsert(block)}
		>
			<span className="document-block-icon" aria-hidden>
				<RowIcon size={16} />
			</span>
			<span className="grid min-w-0 flex-1">
				<Text as="span" role="label" weight="medium" truncate>
					{block.name}
				</Text>
				<Text as="span" role="caption" tone="secondary" truncate>
					{block.description}
				</Text>
			</span>
			{block.markdown ? (
				<code className="document-block-markdown" aria-hidden>
					{block.markdown}
				</code>
			) : null}
		</Button>
	);
}

/**
 * The grouped, filterable block list. The side panel and the toolbar's Insert
 * popover show the same list, so a block is found in the same place either way.
 */
export function DocumentBlockList({
	disabled,
	onInsert,
	autoFocusFilter,
	filterRef,
}: {
	disabled?: boolean;
	onInsert: (block: DocumentBlock) => void;
	autoFocusFilter?: boolean;
	filterRef?: React.Ref<HTMLInputElement>;
}) {
	const [query, setQuery] = useState("");
	const listId = useId();
	const matches = filterDocumentBlocks(query);
	const insert = (block: DocumentBlock) => {
		setQuery("");
		onInsert(block);
	};
	const rows = (blocks: readonly DocumentBlock[]) => (
		<ul className="m-0 grid list-none gap-px p-0">
			{blocks.map((block) => (
				<li key={block.id}>
					<DocumentBlockRow
						block={block}
						disabled={disabled}
						onInsert={insert}
					/>
				</li>
			))}
		</ul>
	);
	return (
		<div className="grid min-h-0 content-start gap-3">
			<Input
				ref={filterRef}
				size="sm"
				aria-label="Find a block"
				aria-controls={listId}
				placeholder="Find a block"
				disabled={disabled}
				autoFocus={autoFocusFilter}
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						const first = matches[0];
						if (first) insert(first);
					}
					if (event.key === "Escape" && query) {
						event.stopPropagation();
						setQuery("");
					}
				}}
			/>
			<div id={listId} className="grid gap-3">
				{matches.length === 0 ? (
					<Text as="p" role="label" tone="secondary" className="m-0 px-2">
						No block matches “{query.trim()}”.
					</Text>
				) : query.trim() ? (
					rows(matches)
				) : (
					DOCUMENT_BLOCK_GROUPS.map((group) => (
						<section
							key={group.name}
							aria-label={group.name}
							className="grid gap-1"
						>
							<Text
								as="h3"
								role="caption"
								tone="secondary"
								weight="semibold"
								className="m-0 px-2"
							>
								{group.name}
							</Text>
							{rows(group.blocks)}
						</section>
					))
				)}
			</div>
		</div>
	);
}

/** The toolbar's Insert control: the block list in a popover. */
export function DocumentInsertMenu({
	disabled,
	onInsert,
}: {
	disabled?: boolean;
	onInsert: (block: DocumentBlock) => void;
}) {
	const [open, setOpen] = useState(false);
	const filter = useRef<HTMLInputElement>(null);
	return (
		<PopoverRoot open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button
						size="sm"
						variant="ghost"
						disabled={disabled}
						aria-label="Insert block"
						title="Insert block (type / on an empty line)"
					/>
				}
			>
				<Plus size={14} /> Insert
			</PopoverTrigger>
			<PopoverContent
				align="start"
				aria-label="Blocks"
				className="max-h-[min(32rem,calc(100dvh-8rem))] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto p-3"
				initialFocus={filter}
			>
				<DocumentBlockList
					disabled={disabled}
					filterRef={filter}
					onInsert={(block) => {
						setOpen(false);
						onInsert(block);
					}}
				/>
			</PopoverContent>
		</PopoverRoot>
	);
}
