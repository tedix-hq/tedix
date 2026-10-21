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
	DotsThree,
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
import { MAX_MESSAGE_BYTES } from "@/collab/protocol";
import { canonicalJsonText } from "@/lib/diff/canonical-json";
import { MAX_FILE_TEXT_LENGTH } from "@/collab/ot/code-change";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { Image } from "@tiptap/extension-image";
import { TextAlign } from "@tiptap/extension-text-align";
import { FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import { Extension, type JSONContent } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { OsOutputContentSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
 * from the rendered toolbar: every group needs ~1360px, without tier 3
 * ~1230px, and without tiers 2-3 ~760px.
 */
const TOOLBAR_COLLAPSE_WIDTHS = [1380, 1250, 790] as const;

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
	const editor = useEditor({
		immediatelyRender: false,
		extensions: [
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
				class:
					"document-prose min-h-[52rem] outline-none text-[16px] leading-[1.6] text-(--tedix-document-ink)",
				"aria-label": "Document body",
			},
		},
	});

	useEffect(() => {
		// Permission/connection changes are not document edits.
		editor?.setEditable(!disabled, false);
	}, [editor, disabled]);

	const richKey = JSON.stringify(normalized.richText);
	useEffect(() => {
		// Live remote changes arrive through `collab`, focused or not. This path
		// only catches an unfocused editor up with a value it was handed, such as
		// a newly opened saved version; while focused, the editor is the source.
		if (!editor || editor.isFocused) return;
		applyIncoming(editor, normalized.richText);
	}, [editor, richKey, normalized.richText]);

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
							label="Insert table"
							disabled={disabled}
							onClick={() =>
								editor
									.chain()
									.focus()
									.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
									.run()
							}
						>
							Table
						</EditorToolbarButton>
						{editor.isActive("table") && (
							<>
								<EditorToolbarButton
									label="Add row"
									disabled={disabled}
									onClick={() => editor.chain().focus().addRowAfter().run()}
								>
									+ Row
								</EditorToolbarButton>
								<EditorToolbarButton
									label="Add column"
									disabled={disabled}
									onClick={() => editor.chain().focus().addColumnAfter().run()}
								>
									+ Column
								</EditorToolbarButton>
								<EditorToolbarButton
									label="Delete row"
									disabled={disabled}
									onClick={() => editor.chain().focus().deleteRow().run()}
								>
									− Row
								</EditorToolbarButton>
								<EditorToolbarButton
									label="Delete column"
									disabled={disabled}
									onClick={() => editor.chain().focus().deleteColumn().run()}
								>
									− Column
								</EditorToolbarButton>
								<EditorToolbarButton
									label="Toggle header row"
									disabled={disabled}
									onClick={() => editor.chain().focus().toggleHeaderRow().run()}
								>
									Header
								</EditorToolbarButton>
								<EditorToolbarButton
									label="Delete table"
									disabled={disabled}
									onClick={() => editor.chain().focus().deleteTable().run()}
								>
									Delete table
								</EditorToolbarButton>
							</>
						)}
						<EditorToolbarButton
							label="Checklist"
							active={editor.isActive("taskList")}
							disabled={disabled}
							onClick={() => editor.chain().focus().toggleTaskList().run()}
						>
							☑
						</EditorToolbarButton>
						<EditorToolbarButton
							label="Callout"
							disabled={disabled}
							onClick={() =>
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
									.run()
							}
						>
							Note
						</EditorToolbarButton>
						<EditorToolbarButton
							label="Toggle section"
							disabled={disabled}
							onClick={() => editor.chain().focus().setDetails().run()}
						>
							Toggle
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
			<div className="document-editor-desk">
				<div
					className="document-editor-paper document-page mx-auto w-full max-w-[72rem] bg-(--tedix-document-paper) px-4 py-8 text-(--tedix-document-ink) sm:px-10 sm:py-10 [&_.ProseMirror_a]:text-(--tedix-document-link) [&_.ProseMirror_blockquote]:border-(--tedix-document-rule) [&_.ProseMirror_blockquote]:border-l-4 [&_.ProseMirror_blockquote]:pl-4 [&_.ProseMirror_h1]:text-[26px] [&_.ProseMirror_h1]:font-semibold [&_.ProseMirror_h2]:text-[21px] [&_.ProseMirror_h2]:font-semibold [&_.ProseMirror_h3]:text-[17px] [&_.ProseMirror_h3]:font-semibold [&_.ProseMirror_img]:max-w-full [&_.ProseMirror_mark]:text-(--tedix-document-ink) [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-6 [&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-6 [&_.ProseMirror_pre]:overflow-x-auto [&_.ProseMirror_pre]:rounded-lg [&_.ProseMirror_pre]:bg-(--tedix-document-code-bg) [&_.ProseMirror_pre]:p-4 [&_.ProseMirror_pre]:text-(--tedix-document-code-fg)"
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
			<div className="flex flex-wrap items-center justify-between gap-2">
				<Text as="span" role="label" tone="secondary">
					Paste text or drag images onto the page
				</Text>
				<Text as="span" role="label" tone="secondary">
					{editor.getText().length} characters
				</Text>
			</div>
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
