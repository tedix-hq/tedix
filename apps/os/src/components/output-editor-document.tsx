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
	Quotes,
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
import { useEffect, useRef, useState } from "react";
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
import {
	blocksFromRichText,
	normalizeDocumentContent,
	type DocumentContent,
} from "@/lib/output-models";

export interface DocumentEditorProps {
	value: DocumentContent;
	onChange: (next: DocumentContent) => void;
	disabled?: boolean;
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

export function DocumentEditor({
	value,
	onChange,
	disabled = false,
}: DocumentEditorProps) {
	const normalized = normalizeDocumentContent(value);
	const fileInput = useRef<HTMLInputElement>(null);
	const [imageError, setImageError] = useState<string | null>(null);
	const [textDialog, setTextDialog] = useState<"link" | "image" | null>(null);
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
			StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
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
		if (!editor || editor.isFocused) return;
		// Compare through the editor schema so default attrs do not manufacture
		// a document replacement when an untouched saved version is opened.
		const incoming = editor.schema.nodeFromJSON(normalized.richText);
		if (!editor.state.doc.eq(incoming)) {
			editor
				.chain()
				.setMeta("addToHistory", false)
				.setMeta(INCOMING_DOCUMENT_META, true)
				.setContent(normalized.richText as JSONContent, { emitUpdate: false })
				.run();
		}
	}, [editor, richKey, normalized.richText]);

	const insertImageFile = async (file: File) => {
		if (disabled || !editor) return;
		setImageError(null);
		const selection = editor.state.selection.from;
		try {
			const image = await prepareDocumentImage(file);
			if (editor.isDestroyed || !editor.isEditable) return;
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
		} catch (error) {
			setImageError(
				error instanceof Error
					? error.message
					: "The image could not be added.",
			);
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

	return (
		<div
			className="document-editor grid min-w-0 gap-0"
			data-editor="document-rich-text"
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
					value={
						editor.isActive("heading", { level: 1 })
							? "1"
							: editor.isActive("heading", { level: 2 })
								? "2"
								: editor.isActive("heading", { level: 3 })
									? "3"
									: "paragraph"
					}
					onValueChange={(value) => {
						const level = Number(value);
						if (level >= 1 && level <= 3) {
							editor
								.chain()
								.focus()
								.setHeading({ level: level as 1 | 2 | 3 })
								.run();
						} else editor.chain().focus().setParagraph().run();
					}}
				>
					<SelectTrigger
						aria-label="Paragraph style"
						className="w-[116px]"
						size="sm"
					>
						<SelectValue>
							{(value) =>
								value === "paragraph" ? "Paragraph" : `Heading ${String(value)}`
							}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="paragraph">Paragraph</SelectItem>
						<SelectItem value="1">Heading 1</SelectItem>
						<SelectItem value="2">Heading 2</SelectItem>
						<SelectItem value="3">Heading 3</SelectItem>
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
				<EditorToolbarButton
					label="Link"
					active={editor.isActive("link")}
					disabled={disabled}
					onClick={() => setTextDialog("link")}
				>
					<LinkIcon size={15} />
				</EditorToolbarButton>
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
							<Select
								disabled={disabled}
								value={
									(editor.getAttributes("textStyle").fontFamily as string) ||
									"default"
								}
								onValueChange={(value) => {
									if (value && value !== "default")
										editor.chain().focus().setFontFamily(value).run();
									else editor.chain().focus().unsetFontFamily().run();
								}}
							>
								<SelectTrigger
									aria-label="Font family"
									className="w-[132px]"
									size="sm"
								>
									<SelectValue>
										{(value) =>
											value === "default"
												? "Default font"
												: String(value).startsWith("Inter")
													? "Inter"
													: String(value).startsWith("Georgia")
														? "Georgia"
														: "Monospace"
										}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="default">Default font</SelectItem>
									<SelectItem value="Inter, sans-serif">Inter</SelectItem>
									<SelectItem value="Georgia, serif">Georgia</SelectItem>
									<SelectItem value="ui-monospace, monospace">
										Monospace
									</SelectItem>
								</SelectContent>
							</Select>
							<Select
								disabled={disabled}
								value={
									(editor.getAttributes("textStyle").fontSize as string) ||
									"default"
								}
								onValueChange={(size) => {
									if (size && size !== "default")
										editor.chain().focus().setFontSize(size).run();
									else editor.chain().focus().unsetFontSize().run();
								}}
							>
								<SelectTrigger
									aria-label="Font size"
									size="sm"
									className="w-24"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="default">Auto size</SelectItem>
									{[12, 14, 16, 18, 20, 24, 28, 32, 40, 48].map((size) => (
										<SelectItem key={size} value={`${size}px`}>
											{size} px
										</SelectItem>
									))}
								</SelectContent>
							</Select>

							<EditorToolbarButton
								label="Strikethrough"
								active={editor.isActive("strike")}
								disabled={disabled}
								onClick={() => toggleMark("strike")}
							>
								<TextStrikethrough size={15} />
							</EditorToolbarButton>
							<EditorToolbarButton
								label="Inline code"
								active={editor.isActive("code")}
								disabled={disabled}
								onClick={() => toggleMark("code")}
							>
								<Code size={15} />
							</EditorToolbarButton>
							<EditorToolbarDivider />
							<EditorToolbarColorButton
								label="Text color"
								swatchRingClassName="ring-(--tedix-document-paper)"
								disabled={disabled}
								color={
									(editor.getAttributes("textStyle").color as string) ??
									"#222222"
								}
								onChange={(color) =>
									editor.chain().focus().setColor(color).run()
								}
							>
								<TextAa size={14} />
							</EditorToolbarColorButton>
							<EditorToolbarColorButton
								label="Highlight color"
								swatchRingClassName="ring-(--tedix-document-paper)"
								disabled={disabled}
								color={
									(editor.getAttributes("highlight").color as string) ??
									"#fff3a3"
								}
								onChange={(color) =>
									editor.chain().focus().setHighlight({ color }).run()
								}
							>
								<Highlighter size={14} />
							</EditorToolbarColorButton>
							<EditorToolbarDivider />
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
									onClick={() =>
										editor.chain().focus().setTextAlign(align).run()
									}
								>
									<Icon size={15} />
								</EditorToolbarButton>
							))}
							<EditorToolbarDivider />
							<EditorToolbarButton
								label="Block quote"
								active={editor.isActive("blockquote")}
								disabled={disabled}
								onClick={() => editor.chain().focus().toggleBlockquote().run()}
							>
								<Quotes size={15} />
							</EditorToolbarButton>
							<EditorToolbarButton
								label="Increase indent"
								disabled={disabled || !editor.can().sinkListItem("listItem")}
								onClick={() =>
									editor.chain().focus().sinkListItem("listItem").run()
								}
							>
								<TextIndent size={15} />
							</EditorToolbarButton>
							<EditorToolbarButton
								label="Decrease indent"
								disabled={disabled || !editor.can().liftListItem("listItem")}
								onClick={() =>
									editor.chain().focus().liftListItem("listItem").run()
								}
							>
								<TextOutdent size={15} />
							</EditorToolbarButton>

							<EditorToolbarButton
								label="Image URL"
								disabled={disabled}
								onClick={() => setTextDialog("image")}
							>
								<ImageSquare size={15} />
							</EditorToolbarButton>
							<EditorToolbarButton
								label="Upload image"
								disabled={disabled}
								onClick={() => fileInput.current?.click()}
							>
								<ImageSquare size={15} weight="fill" />
							</EditorToolbarButton>
							<EditorToolbarDivider />
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
						</Toolbar>
					</PopoverContent>
				</PopoverRoot>

				<Input
					ref={fileInput}
					type="file"
					aria-label="Upload document image"
					disabled={disabled}
					accept="image/png,image/jpeg,image/webp,image/gif"
					className="sr-only"
					tabIndex={-1}
					onChange={(event) => {
						const file = event.target.files?.[0];
						if (file) insertImageFile(file);
						event.target.value = "";
					}}
				/>
			</EditorToolbar>
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
						const file = event.dataTransfer.files?.[0];
						if (file?.type.startsWith("image/")) {
							event.preventDefault();
							insertImageFile(file);
						}
					}}
					onPaste={(event) => {
						const file = [...event.clipboardData.files].find((item) =>
							item.type.startsWith("image/"),
						);
						if (file) {
							event.preventDefault();
							insertImageFile(file);
						}
					}}
				>
					<EditorContent editor={editor} />
				</div>
			</div>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<Text as="span" role="label" tone="secondary">
					Rich document · paste from Docs or Word · drag images onto the page
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
