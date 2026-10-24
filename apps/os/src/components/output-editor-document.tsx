import "./output-editor.css";
import { TableKit } from "@tiptap/extension-table";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import {
	Details,
	DetailsSummary,
	DetailsContent,
} from "@tiptap/extension-details";
import { Node, mergeAttributes } from "@tiptap/core";
import {
	ArrowCounterClockwise,
	CaretDown,
	DotsThree,
	Keyboard,
	SidebarSimple,
	SquaresFour,
	Table,
	TextIndent,
	TextOutdent,
	ArrowUDownLeft,
	ArrowUDownRight,
	Code,
	Highlighter,
	ImageSquare,
	Link as LinkIcon,
	ListBullets,
	ListNumbers,
	Minus,
	TextAa,
	TextAlignCenter,
	TextAlignJustify,
	TextAlignLeft,
	TextAlignRight,
	TextB,
	TextItalic,
	TextStrikethrough,
	TextUnderline,
} from "@phosphor-icons/react";
import {
	type DocumentBlock,
	DocumentBlockList,
	DocumentInsertMenu,
} from "@/components/document-block-library";
import {
	activeOutlineIndex,
	DocumentOutline,
	type DocumentOutlineItem,
	editorOutline,
} from "@/components/document-outline";
import { DocumentShortcutsDialog } from "@/components/document-shortcuts";
import {
	DocumentSlashMenu,
	useDocumentSlashMenu,
} from "@/components/document-slash-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { MAX_MESSAGE_BYTES } from "@/collab/protocol";
import { canonicalJsonText } from "@/lib/diff/canonical-json";
import { MAX_FILE_TEXT_LENGTH } from "@/collab/ot/code-change";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { Image } from "@tiptap/extension-image";
import { TextAlign } from "@tiptap/extension-text-align";
import { FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import { Extension, type JSONContent } from "@tiptap/core";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import { OsOutputContentSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
	useEffect,
	useLayoutEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import { DocumentLinkPopover } from "@/components/document-link-popover";
import { Button } from "@/components/kumo/button";
import {
	PopoverRoot,
	PopoverTrigger,
	PopoverContent,
} from "@/components/kumo/popover";
import { Toolbar } from "@/components/kumo/toolbar";
import { prepareDocumentImage } from "@/lib/document-images";
import { EditorTextDialog } from "@/components/editor-text-dialog";
import { Input } from "@/components/kumo/input";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import {
	EditorToolbar,
	EditorToolbarButton,
	EditorToolbarColorButton,
	EditorToolbarDivider,
} from "@/components/output-editor-toolbar";
import { type DocumentContent } from "@/lib/output-models";
import {
	blocksFromRichText,
	normalizeDocumentContent,
} from "@tedix/api-contract/utils/os-document";
import { incomingDocumentTransaction } from "@/lib/document-remote-merge";
import {
	REMOTE_CHANGE_META,
	type RemoteCursor,
	remoteCursorsPlugin,
	setRemoteCursors,
} from "@/lib/document-remote-cursors";

/** Live co-editing hooks; absent when the document is edited alone. */
export interface DocumentCollab {
	/**
	 * Subscribe to the shared document moving under a remote change. The
	 * listener must run synchronously with the move, so the editor is never
	 * behind the shared text when the next keystroke is published.
	 */
	subscribe(apply: (next: DocumentContent) => void): () => void;
	/** Publish this editor's selection, in editor positions. */
	publishSelection(selection: { anchor: number; head: number } | null): void;
}
import {
	applyDocumentStyle,
	canChangeIndent,
	changeIndent,
	currentDocumentStyle,
	DOCUMENT_FONT_SIZES_PT,
	DOCUMENT_FONTS,
	DOCUMENT_STYLES,
	DocumentFormatting,
	documentFontFamilies,
	documentFontLabel,
	type DocumentStyle,
	fontSizeToPoints,
	pointsToFontSize,
} from "@/lib/document-formatting";
import { ensureSlideFontLoaded } from "@/lib/slide-fonts";
import { useToolbarCollapse } from "@/components/use-toolbar-collapse";

/**
 * Toolbar widths (px) below which tiers 3, 2 and 1 fold into More, measured
 * from the rendered toolbar (content plus its 32px padding): every group needs
 * ~1467px, without tier 3 ~1242px, and without tiers 2-3 ~870px.
 */
const TOOLBAR_COLLAPSE_WIDTHS = [1470, 1250, 880] as const;

/** Editor widths (px) at which the outline rail, then both rails, fit. */
const ONE_RAIL_WIDTH = 880;
const TWO_RAIL_WIDTH = 1180;

/** Words per minute behind the reading-time estimate. */
const READING_WPM = 230;

function wordCount(text: string): number {
	return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
}

function useElementWidth(element: HTMLElement | null): number {
	const [width, setWidth] = useState(0);
	useEffect(() => {
		if (!element || typeof ResizeObserver === "undefined") return;
		const measure = () => setWidth(element.clientWidth);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [element]);
	return width;
}

const imageFiles = (files: FileList | null | undefined) =>
	[...(files ?? [])].filter((file) => file.type.startsWith("image/"));

interface DocumentEditorProps {
	value: DocumentContent;
	onChange: (next: DocumentContent) => void;
	disabled?: boolean;
	collab?: DocumentCollab;
	remoteCursors?: readonly RemoteCursor[];
}

// The local send margin must not prevent the editor from displaying an already
// accepted saved/shared document. Only controlled incoming replacements set this.
const INCOMING_DOCUMENT_META = "tedixIncomingDocument";

function documentEditError(
	richText: NonNullable<DocumentContent["richText"]>,
): string | null {
	const content = {
		kind: "document",
		richText,
		blocks: blocksFromRichText(richText),
	};
	if (!OsOutputContentSchema.safeParse(content).success)
		return "This change cannot be saved. Try smaller sections or fewer images. Your current document has not changed.";
	const serialized = canonicalJsonText(content);
	if (
		serialized.length > MAX_FILE_TEXT_LENGTH - 4_096 ||
		new TextEncoder().encode(JSON.stringify(serialized)).length >
			MAX_MESSAGE_BYTES - 16_384
	) {
		return "This document is full. Put this content in another document or link to it instead. Your current document has not changed.";
	}
	return null;
}

/**
 * Move the editor to `richText` as one remote transaction: minimal steps, so the
 * local selection and stored marks map across, outside local undo history, and
 * not published back.
 */
function applyIncoming(
	editor: NonNullable<ReturnType<typeof useEditor>>,
	richText: DocumentContent["richText"],
): void {
	// Compare through the editor schema so default attrs do not manufacture
	// a document replacement when an untouched saved version is opened.
	const incoming = editor.schema.nodeFromJSON(richText as JSONContent);
	const tr = incomingDocumentTransaction(editor.state, incoming);
	if (!tr) return;
	editor.view.dispatch(
		tr
			.setMeta("addToHistory", false)
			.setMeta("preventUpdate", true)
			.setMeta(INCOMING_DOCUMENT_META, true)
			.setMeta(REMOTE_CHANGE_META, true),
	);
}

const SELECTION_PUBLISH_MS = 60;
const NO_CURSORS: readonly RemoteCursor[] = [];

export function DocumentEditor({
	value,
	onChange,
	disabled = false,
	collab,
	remoteCursors = NO_CURSORS,
}: DocumentEditorProps) {
	const normalized = normalizeDocumentContent(value);
	const fileInput = useRef<HTMLInputElement>(null);
	const [imageError, setImageError] = useState<string | null>(null);
	const [textDialog, setTextDialog] = useState<"link" | "image" | null>(null);
	const [processingImages, setProcessingImages] = useState(0);
	const [root, setRoot] = useState<HTMLDivElement | null>(null);
	const collapse = useToolbarCollapse(root, TOOLBAR_COLLAPSE_WIDTHS);
	const width = useElementWidth(root);
	const [showOutline, setShowOutline] = useState(true);
	const [showBlocks, setShowBlocks] = useState(true);
	const [shortcutsOpen, setShortcutsOpen] = useState(false);
	// Keyboard commands registered once with the editor call through this ref,
	// so they always reach the current render's state setters.
	const keys = useRef<{
		openLink: () => void;
		slashKeyDown: (event: KeyboardEvent) => boolean;
	}>({ openLink: () => {}, slashKeyDown: () => false });
	const editor = useEditor({
		immediatelyRender: false,
		extensions: [
			Extension.create({
				name: "documentKeys",
				addKeyboardShortcuts: () => ({
					"Mod-k": () => {
						keys.current.openLink();
						return true;
					},
					"Mod-/": () => {
						setShortcutsOpen(true);
						return true;
					},
				}),
			}),
			Extension.create({
				name: "documentSaveLimits",
				addProseMirrorPlugins() {
					return [
						new Plugin({
							filterTransaction(transaction) {
								if (
									!transaction.docChanged ||
									transaction.getMeta(INCOMING_DOCUMENT_META)
								)
									return true;
								const error = documentEditError(transaction.doc.toJSON());
								if (error) queueMicrotask(() => setImageError(error));
								return !error;
							},
						}),
					];
				},
			}),
			Extension.create({
				name: "remoteCursors",
				addProseMirrorPlugins: () => [remoteCursorsPlugin()],
			}),
			TableKit.configure({ table: { resizable: true } }),
			TaskList,
			TaskItem.configure({ nested: true }),
			Details.configure({ persist: true }),
			DetailsSummary,
			DetailsContent,
			Node.create({
				name: "callout",
				group: "block",
				content: "block+",
				defining: true,
				parseHTML: () => [{ tag: 'aside[data-type="callout"]' }],
				renderHTML: ({ HTMLAttributes }) => [
					"aside",
					mergeAttributes(HTMLAttributes, { "data-type": "callout" }),
					0,
				],
			}),
			StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
			DocumentFormatting,
			TextStyle,
			FontFamily,
			FontSize,
			Color,
			Highlight.configure({ multicolor: true }),
			Image.configure({
				allowBase64: true,
				inline: false,
				resize: {
					enabled: true,
					directions: ["bottom-right"],
					minWidth: 80,
					minHeight: 40,
					alwaysPreserveAspectRatio: true,
				},
			}),
			TextAlign.configure({
				types: ["heading", "paragraph"],
				alignments: ["left", "center", "right", "justify"],
			}),
		],
		content: normalized.richText as JSONContent,
		editable: !disabled,
		onUpdate: ({ editor: current }) => {
			const richText = current.getJSON() as NonNullable<
				typeof normalized.richText
			>;
			onChange({
				kind: "document",
				richText,
				blocks: blocksFromRichText(richText),
			});
		},
		editorProps: {
			attributes: {
				class: "document-prose outline-none text-(--tedix-document-ink)",
				"aria-label": "Document body",
			},
			handleKeyDown: (_view, event) => keys.current.slashKeyDown(event),
			// Keep the caret clear of the sticky toolbar above and the status
			// pill below when typing scrolls the page.
			scrollThreshold: { top: 72, bottom: 88, left: 0, right: 0 },
			scrollMargin: { top: 72, bottom: 88, left: 0, right: 0 },
		},
	});

	// The toolbar mirrors the caret (bold under the cursor, the current style),
	// so it re-renders when the selection moves, not only when text changes.
	const [, refreshToolbar] = useReducer((tick: number) => tick + 1, 0);
	useEffect(() => {
		if (!editor) return;
		// Only caret, content and pending-mark moves change what the toolbar
		// shows; meta-only transactions such as presence updates are skipped.
		const refresh = ({ transaction }: { transaction: Transaction }) => {
			if (
				transaction.docChanged ||
				transaction.selectionSet ||
				transaction.storedMarksSet
			)
				refreshToolbar();
		};
		editor.on("transaction", refresh);
		return () => {
			editor.off("transaction", refresh);
		};
	}, [editor]);

	const blockActions = {
		uploadImage: () => fileInput.current?.click(),
		imageFromUrl: () => setTextDialog("image"),
	};
	const insertBlock = (block: DocumentBlock) => {
		if (!editor || disabled) return;
		block.insert(editor, blockActions);
	};
	const slash = useDocumentSlashMenu(editor, (block, range) => {
		if (!editor || disabled) return;
		editor.chain().focus().deleteRange(range).run();
		block.insert(editor, blockActions);
	});
	keys.current.slashKeyDown = slash.handleKeyDown;
	keys.current.openLink = () => {
		if (!disabled) setTextDialog("link");
	};

	const doc = editor?.state.doc;
	// The document node is immutable: a new node means new content.
	const outline = useMemo(
		() => (editor && doc ? editorOutline(editor) : []),
		[editor, doc],
	);
	const words = useMemo(
		() =>
			doc ? wordCount(doc.textBetween(0, doc.content.size, "\n", " ")) : 0,
		[doc],
	);

	useEffect(() => {
		// Permission/connection changes are not document edits.
		editor?.setEditable(!disabled, false);
	}, [editor, disabled]);

	const richKey = JSON.stringify(normalized.richText);
	const handedValue = useRef(normalized.richText);
	handedValue.current = normalized.richText;
	useEffect(() => {
		// Live remote changes arrive through `collab`, focused or not. This path
		// only catches an unfocused editor up with a value it was handed, such as
		// a newly opened saved version; while focused, the editor is the source.
		// Keyed on the serialized value: normalizing builds a new object every
		// render, and an editor that re-renders on its own transactions would
		// otherwise re-apply the same value forever.
		if (!editor || editor.isFocused) return;
		applyIncoming(editor, handedValue.current);
	}, [editor, richKey]);

	useEffect(() => {
		if (!editor || !collab) return;
		return collab.subscribe((next) => {
			if (!editor.isDestroyed)
				applyIncoming(editor, normalizeDocumentContent(next).richText);
		});
	}, [editor, collab]);

	useEffect(() => {
		if (!editor || !collab) return;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const publish = () => {
			timer = null;
			if (editor.isDestroyed) return;
			const { anchor, head } = editor.state.selection;
			collab.publishSelection({ anchor, head });
		};
		// Trailing, so a burst of typing sends one position, after the edit.
		const schedule = () => {
			if (timer === null) timer = setTimeout(publish, SELECTION_PUBLISH_MS);
		};
		editor.on("selectionUpdate", schedule);
		editor.on("focus", schedule);
		return () => {
			editor.off("selectionUpdate", schedule);
			editor.off("focus", schedule);
			if (timer !== null) clearTimeout(timer);
			collab.publishSelection(null);
		};
	}, [editor, collab]);

	useLayoutEffect(() => {
		if (!editor || editor.isDestroyed) return;
		editor.view.dispatch(setRemoteCursors(editor.state.tr, remoteCursors));
	}, [editor, remoteCursors]);

	// Fetch the web fonts the document names (Inter and any family an agent
	// wrote); system faces and generic families are skipped by the loader.
	const fontKey = documentFontFamilies(normalized.richText?.content).join("\n");
	useEffect(() => {
		for (const family of fontKey.split("\n"))
			if (family) ensureSlideFontLoaded(family);
	}, [fontKey]);

	const insertImageFile = async (file: File): Promise<boolean> => {
		if (disabled || !editor) return false;
		// The selection's end: after an inserted image the editor selects that
		// image, so the next image of a batch lands after it, not before.
		const selection = editor.state.selection.to;
		try {
			const image = await prepareDocumentImage(file);
			if (editor.isDestroyed || !editor.isEditable) return false;
			const width = Math.min(image.width, editor.view.dom.clientWidth || 768);
			editor
				.chain()
				.focus()
				.insertContentAt(Math.min(selection, editor.state.doc.content.size), {
					type: "image",
					attrs: {
						...image,
						width,
						height: Math.round((image.height * width) / image.width),
					},
				})
				.command(({ tr }) => {
					const richText = tr.doc.toJSON() as NonNullable<
						DocumentContent["richText"]
					>;
					const error = documentEditError(richText);
					if (error) throw new Error(error);
					return true;
				})
				.run();
			return true;
		} catch (error) {
			setImageError(
				error instanceof Error
					? error.message
					: "The image could not be added.",
			);
			return false;
		}
	};

	/** Insert images one after another, in order, stopping at the first failure. */
	const insertImageFiles = async (files: File[]) => {
		if (disabled || !editor || files.length === 0) return;
		setImageError(null);
		setProcessingImages((count) => count + 1);
		try {
			for (const file of files) {
				if (!(await insertImageFile(file))) break;
			}
		} finally {
			setProcessingImages((count) => count - 1);
		}
	};

	if (!editor) {
		return <Skeleton className="h-96 rounded-xl" />;
	}

	const applyLink = (href: string) => {
		if (!href.trim()) {
			editor.chain().focus().extendMarkRange("link").unsetLink().run();
			return;
		}
		editor
			.chain()
			.focus()
			.extendMarkRange("link")
			.setLink({ href: href.trim() })
			.run();
	};

	const insertImageUrl = (src: string) => {
		editor.chain().focus().setImage({ src: src.trim() }).run();
	};

	const toggleMark = (mark: string) =>
		editor.chain().focus().toggleMark(mark).run();

	const fontFamily = editor.getAttributes("textStyle").fontFamily as
		| string
		| undefined;
	const fontPoints = fontSizeToPoints(
		editor.getAttributes("textStyle").fontSize as string | undefined,
	);

	// Lower-priority groups fold into More only as the toolbar narrows:
	// tier 3 first, then tier 2, then tier 1 (see useToolbarCollapse).
	const groups = (inMore: boolean) => {
		const visible = (tier: 1 | 2 | 3) => tier <= 3 - collapse !== inMore;
		return (
			<>
				{visible(2) && (
					<>
						<Select
							disabled={disabled}
							value={fontFamily || ""}
							onValueChange={(value) => {
								if (value) {
									ensureSlideFontLoaded(value);
									editor.chain().focus().setFontFamily(value).run();
								} else editor.chain().focus().unsetFontFamily().run();
							}}
						>
							<SelectTrigger
								aria-label="Font family"
								className="w-[118px]"
								size="sm"
							>
								<SelectValue>
									{(value) => documentFontLabel(String(value ?? ""))}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{DOCUMENT_FONTS.map((font) => (
									<SelectItem key={font.label} value={font.value}>
										<span style={{ fontFamily: font.value || undefined }}>
											{font.label}
										</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Select
							disabled={disabled}
							value={fontPoints === null ? "default" : String(fontPoints)}
							onValueChange={(value) => {
								if (value && value !== "default")
									editor
										.chain()
										.focus()
										.setFontSize(pointsToFontSize(Number(value)))
										.run();
								else editor.chain().focus().unsetFontSize().run();
							}}
						>
							<SelectTrigger aria-label="Font size" size="sm" className="w-20">
								<SelectValue>
									{(value) =>
										value === "default" ? "12 pt" : `${String(value)} pt`
									}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="default">Default (12 pt)</SelectItem>
								{DOCUMENT_FONT_SIZES_PT.map((size) => (
									<SelectItem key={size} value={String(size)}>
										{size} pt
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<EditorToolbarDivider />
					</>
				)}
				{visible(3) && (
					<>
						<EditorToolbarColorButton
							label="Text color"
							swatchRingClassName="ring-(--tedix-document-paper)"
							disabled={disabled}
							color={
								(editor.getAttributes("textStyle").color as string) ?? "#222222"
							}
							onChange={(color) => editor.chain().focus().setColor(color).run()}
						>
							<TextAa size={14} />
						</EditorToolbarColorButton>
						<EditorToolbarColorButton
							label="Highlight color"
							swatchRingClassName="ring-(--tedix-document-paper)"
							disabled={disabled}
							color={
								(editor.getAttributes("highlight").color as string) ?? "#fff3a3"
							}
							onChange={(color) =>
								editor.chain().focus().setHighlight({ color }).run()
							}
						>
							<Highlighter size={14} />
						</EditorToolbarColorButton>
						<EditorToolbarDivider />
					</>
				)}
				{visible(1) && (
					<>
						{(
							[
								["Align left", "left", TextAlignLeft],
								["Align center", "center", TextAlignCenter],
								["Align right", "right", TextAlignRight],
								["Justify", "justify", TextAlignJustify],
							] as const
						).map(([label, align, Icon]) => (
							<EditorToolbarButton
								key={align}
								label={label}
								active={editor.isActive({ textAlign: align })}
								disabled={disabled}
								onClick={() => editor.chain().focus().setTextAlign(align).run()}
							>
								<Icon size={15} />
							</EditorToolbarButton>
						))}
						<EditorToolbarDivider />
						<EditorToolbarButton
							label="Bulleted list"
							active={editor.isActive("bulletList")}
							disabled={disabled}
							onClick={() => editor.chain().focus().toggleBulletList().run()}
						>
							<ListBullets size={15} />
						</EditorToolbarButton>
						<EditorToolbarButton
							label="Numbered list"
							active={editor.isActive("orderedList")}
							disabled={disabled}
							onClick={() => editor.chain().focus().toggleOrderedList().run()}
						>
							<ListNumbers size={15} />
						</EditorToolbarButton>
						<EditorToolbarDivider />
					</>
				)}
				{visible(3) && (
					<>
						<EditorToolbarButton
							label="Decrease indent"
							disabled={disabled || !canChangeIndent(editor, -1)}
							onClick={() => changeIndent(editor, -1)}
						>
							<TextOutdent size={15} />
						</EditorToolbarButton>
						<EditorToolbarButton
							label="Increase indent"
							disabled={disabled || !canChangeIndent(editor, 1)}
							onClick={() => changeIndent(editor, 1)}
						>
							<TextIndent size={15} />
						</EditorToolbarButton>
						<EditorToolbarDivider />
					</>
				)}
				{visible(2) && (
					<>
						<EditorToolbarButton
							label="Link"
							active={editor.isActive("link")}
							disabled={disabled}
							onClick={() => setTextDialog("link")}
						>
							<LinkIcon size={15} />
						</EditorToolbarButton>
						<EditorToolbarButton
							label="Upload image"
							disabled={disabled}
							onClick={() => fileInput.current?.click()}
						>
							<ImageSquare size={15} weight="fill" />
						</EditorToolbarButton>
						<EditorToolbarButton
							label="Image URL"
							disabled={disabled}
							onClick={() => setTextDialog("image")}
						>
							<ImageSquare size={15} />
						</EditorToolbarButton>
						<EditorToolbarDivider />
					</>
				)}
				{visible(3) && (
					<>
						<EditorToolbarButton
							label="Inline code"
							active={editor.isActive("code")}
							disabled={disabled}
							onClick={() => toggleMark("code")}
						>
							<Code size={15} />
						</EditorToolbarButton>
						<EditorToolbarButton
							label="Horizontal rule"
							disabled={disabled}
							onClick={() => editor.chain().focus().setHorizontalRule().run()}
						>
							<Minus size={15} />
						</EditorToolbarButton>
						<EditorToolbarButton
							label="Clear formatting"
							disabled={disabled}
							onClick={() =>
								editor.chain().focus().clearNodes().unsetAllMarks().run()
							}
						>
							<ArrowCounterClockwise size={15} />
						</EditorToolbarButton>
					</>
				)}
			</>
		);
	};

	const outlineFits = width === 0 || width >= ONE_RAIL_WIDTH;
	const outlineVisible = showOutline && outlineFits;
	const blocksVisible =
		showBlocks &&
		(outlineVisible ? width === 0 || width >= TWO_RAIL_WIDTH : outlineFits);
	const caret = editor.state.selection.from;
	const activeHeading = activeOutlineIndex(outline, caret);
	const minutes = Math.max(1, Math.round(words / READING_WPM));

	const jumpTo = (item: DocumentOutlineItem) => {
		const target = editor.view.nodeDOM(item.position);
		if (target instanceof HTMLElement) {
			const reduce = window.matchMedia?.(
				"(prefers-reduced-motion: reduce)",
			).matches;
			target.scrollIntoView({
				block: "start",
				behavior: reduce ? "auto" : "smooth",
			});
		}
		editor
			.chain()
			.setTextSelection(item.position + 1)
			.focus(undefined, { scrollIntoView: false })
			.run();
	};

	const inTable = editor.isActive("table");

	return (
		<div
			ref={setRoot}
			className="document-editor grid min-w-0 gap-0"
			data-editor="document-rich-text"
			data-toolbar-collapse={collapse}
		>
			<EditorToolbar className="sticky top-0 z-10">
				<EditorToolbarButton
					label="Undo"
					disabled={disabled || !editor.can().undo()}
					onClick={() => editor.chain().focus().undo().run()}
				>
					<ArrowUDownLeft size={15} />
				</EditorToolbarButton>
				<EditorToolbarButton
					label="Redo"
					disabled={disabled || !editor.can().redo()}
					onClick={() => editor.chain().focus().redo().run()}
				>
					<ArrowUDownRight size={15} />
				</EditorToolbarButton>
				<EditorToolbarDivider />
				<Select
					disabled={disabled}
					value={currentDocumentStyle(editor)}
					onValueChange={(value) =>
						applyDocumentStyle(editor, (value ?? "paragraph") as DocumentStyle)
					}
				>
					<SelectTrigger
						aria-label="Paragraph style"
						className="w-[124px]"
						size="sm"
					>
						<SelectValue>
							{(value) =>
								DOCUMENT_STYLES.find(([style]) => style === value)?.[1] ??
								"Normal text"
							}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{DOCUMENT_STYLES.map(([style, label]) => (
							<SelectItem key={style} value={style}>
								{label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<DocumentInsertMenu disabled={disabled} onInsert={insertBlock} />
				{inTable && (
					<DropdownMenu>
						<DropdownMenuTrigger
							disabled={disabled}
							render={
								<Button size="sm" variant="ghost" aria-label="Table options" />
							}
						>
							<Table size={15} /> Table <CaretDown size={12} />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							<DropdownMenuItem
								onClick={() => editor.chain().focus().addRowAfter().run()}
							>
								Add row below
							</DropdownMenuItem>
							<DropdownMenuItem
								onClick={() => editor.chain().focus().addColumnAfter().run()}
							>
								Add column to the right
							</DropdownMenuItem>
							<DropdownMenuItem
								onClick={() => editor.chain().focus().toggleHeaderRow().run()}
							>
								Turn header row on or off
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								onClick={() => editor.chain().focus().deleteRow().run()}
							>
								Delete row
							</DropdownMenuItem>
							<DropdownMenuItem
								onClick={() => editor.chain().focus().deleteColumn().run()}
							>
								Delete column
							</DropdownMenuItem>
							<DropdownMenuItem
								variant="danger"
								onClick={() => editor.chain().focus().deleteTable().run()}
							>
								Delete table
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
				<EditorToolbarDivider />
				<EditorToolbarButton
					label="Bold"
					active={editor.isActive("bold")}
					disabled={disabled}
					onClick={() => toggleMark("bold")}
				>
					<TextB size={15} />
				</EditorToolbarButton>
				<EditorToolbarButton
					label="Italic"
					active={editor.isActive("italic")}
					disabled={disabled}
					onClick={() => toggleMark("italic")}
				>
					<TextItalic size={15} />
				</EditorToolbarButton>
				<EditorToolbarButton
					label="Underline"
					active={editor.isActive("underline")}
					disabled={disabled}
					onClick={() => toggleMark("underline")}
				>
					<TextUnderline size={15} />
				</EditorToolbarButton>
				<EditorToolbarButton
					label="Strikethrough"
					active={editor.isActive("strike")}
					disabled={disabled}
					onClick={() => toggleMark("strike")}
				>
					<TextStrikethrough size={15} />
				</EditorToolbarButton>
				<EditorToolbarDivider />
				{groups(false)}
				{collapse > 0 && (
					<PopoverRoot>
						<PopoverTrigger
							render={
								<Button
									size="sm"
									variant="ghost"
									disabled={disabled}
									aria-label="More formatting"
								/>
							}
						>
							<DotsThree size={18} />
							More
						</PopoverTrigger>
						<PopoverContent
							align="end"
							className="w-[min(22rem,calc(100vw-2rem))] p-3"
							aria-label="More document formatting"
						>
							<Toolbar
								size="sm"
								className="flex flex-wrap gap-1 bg-transparent shadow-none ring-0"
							>
								{groups(true)}
							</Toolbar>
						</PopoverContent>
					</PopoverRoot>
				)}

				<Input
					ref={fileInput}
					type="file"
					multiple
					aria-label="Upload document image"
					disabled={disabled}
					accept="image/png,image/jpeg,image/webp,image/gif"
					className="sr-only"
					tabIndex={-1}
					onChange={(event) => {
						const files = [...(event.target.files ?? [])];
						event.target.value = "";
						void insertImageFiles(files);
					}}
				/>
			</EditorToolbar>
			{processingImages > 0 && (
				<p
					role="status"
					className="m-0 px-2 py-1 text-kumo-subtle text-xs"
					data-document-image-status
				>
					Processing image…
				</p>
			)}
			{imageError && (
				<p role="alert" className="m-0 px-2 py-1 text-kumo-danger text-xs">
					{imageError}
				</p>
			)}
			<div
				className="document-editor-layout"
				data-show-outline={outlineVisible || undefined}
				data-show-blocks={blocksVisible || undefined}
			>
				{outlineVisible && (
					<aside className="document-editor-rail document-editor-rail-start">
						<DocumentOutline
							items={outline}
							activeIndex={activeHeading}
							disabled={disabled}
							onSelect={jumpTo}
						/>
					</aside>
				)}
				<div className="document-editor-desk">
					<div
						className="document-editor-paper document-page mx-auto w-full bg-(--tedix-document-paper) text-(--tedix-document-ink)"
						data-kumo-part="document-paper"
						onDrop={(event) => {
							const files = imageFiles(event.dataTransfer.files);
							if (files.length) {
								event.preventDefault();
								void insertImageFiles(files);
							}
						}}
						onPaste={(event) => {
							const files = imageFiles(event.clipboardData.files);
							if (files.length) {
								event.preventDefault();
								void insertImageFiles(files);
							}
						}}
					>
						<EditorContent editor={editor} />
					</div>
				</div>
				{blocksVisible && (
					<aside
						className="document-editor-rail document-editor-rail-end"
						aria-label="Add a block"
					>
						<Text
							as="h2"
							role="caption"
							tone="secondary"
							weight="semibold"
							className="m-0 flex items-center gap-1.5 px-2"
						>
							<SquaresFour size={14} aria-hidden />
							Add a block
						</Text>
						<DocumentBlockList disabled={disabled} onInsert={insertBlock} />
					</aside>
				)}
			</div>
			<div className="document-editor-pill" data-document-pill>
				<Text as="span" role="caption" tone="secondary">
					{words === 1 ? "1 word" : `${words.toLocaleString()} words`}
					{words > 0 ? ` · ${minutes} min read` : ""}
				</Text>
				<span className="document-editor-pill-hint" aria-hidden>
					<Text as="span" role="caption" tone="secondary">
						Type / for blocks
					</Text>
				</span>
				<span className="document-editor-pill-actions">
					{outlineFits && (
						<>
							<Button
								size="sm"
								variant="ghost"
								disabled={disabled}
								aria-label="Outline"
								aria-pressed={outlineVisible}
								title={outlineVisible ? "Hide outline" : "Show outline"}
								onClick={() => setShowOutline((visible) => !visible)}
							>
								<SidebarSimple size={15} />
							</Button>
							<Button
								size="sm"
								variant="ghost"
								disabled={disabled}
								aria-label="Blocks panel"
								aria-pressed={blocksVisible}
								title={
									blocksVisible ? "Hide blocks panel" : "Show blocks panel"
								}
								onClick={() => setShowBlocks((visible) => !visible)}
							>
								<SquaresFour size={15} />
							</Button>
						</>
					)}
					<Button
						size="sm"
						variant="ghost"
						disabled={disabled}
						aria-label="Keyboard shortcuts"
						title="Keyboard shortcuts"
						onClick={() => setShortcutsOpen(true)}
					>
						<Keyboard size={15} />
					</Button>
				</span>
			</div>
			<DocumentSlashMenu
				editor={editor}
				query={slash.query}
				matches={slash.matches}
				index={slash.index}
				onHover={slash.setIndex}
				onChoose={slash.choose}
			/>
			<DocumentShortcutsDialog
				open={shortcutsOpen}
				onOpenChange={setShortcutsOpen}
			/>
			<DocumentLinkPopover
				editor={editor}
				disabled={disabled}
				onEdit={() => setTextDialog("link")}
			/>
			<EditorTextDialog
				open={textDialog === "link"}
				title="Edit link"
				description="Enter a destination. Leave the field empty to remove the current link."
				fieldLabel="Link URL"
				initialValue={
					(editor.getAttributes("link").href as string | undefined) ??
					"https://"
				}
				submitLabel="Apply link"
				allowEmpty
				maxLength={2_048}
				placeholder="https://example.com"
				onOpenChange={(open) => setTextDialog(open ? "link" : null)}
				onSubmit={applyLink}
			/>
			<EditorTextDialog
				open={textDialog === "image"}
				title="Insert image"
				description="Add an image to the document from a URL."
				fieldLabel="Image URL"
				initialValue="https://"
				submitLabel="Insert image"
				maxLength={2_048}
				placeholder="https://example.com/image.png"
				onOpenChange={(open) => setTextDialog(open ? "image" : null)}
				onSubmit={insertImageUrl}
			/>
		</div>
	);
}
