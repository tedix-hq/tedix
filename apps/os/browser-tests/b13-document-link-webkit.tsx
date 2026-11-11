import { Editor, type JSONContent } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
	blocksFromRichText,
	normalizeDocumentContent,
} from "@tedix/api-contract/utils/os-document";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DocumentLinkPopover } from "../src/components/document-link-popover";
import { Button } from "../src/components/kumo/button";
import "../src/styles.css";
import "../src/components/output-editor.css";

const parameters = new URLSearchParams(location.search);
const dark = parameters.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.dataset.mode = dark ? "dark" : "light";
document.documentElement.style.colorScheme = dark ? "dark" : "light";

function makeEditor(href = "https://example.invalid/alpha") {
	const document = normalizeDocumentContent({
		kind: "document",
		blocks: [],
		richText: {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "Before " },
						{
							type: "text",
							text: "Alpha guide",
							marks: [{ type: "link", attrs: { href } }],
						},
						{ type: "text", text: " between " },
						{
							type: "text",
							text: "Beta guide",
							marks: [
								{
									type: "link",
									attrs: { href: "https://example.invalid/beta" },
								},
							],
						},
						{ type: "text", text: " after." },
					],
				},
				{
					type: "paragraph",
					content: [{ type: "text", text: "Outside both links." }],
				},
			],
		},
	});
	document.blocks = blocksFromRichText(document.richText!);
	return new Editor({
		extensions: [
			StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
		],
		content: document.richText as JSONContent,
		editorProps: {
			attributes: {
				"aria-label": "Fixture document",
				class:
					"min-h-32 rounded-lg border border-kumo-line p-4 outline-offset-4",
			},
		},
	});
}

/** Drive real ProseMirror transactions by text, without reproducing popover selection logic. */
function position(editor: Editor, text: string) {
	let found: number | undefined;
	editor.state.doc.descendants((node, offset) => {
		if (node.isText && node.text?.includes(text))
			found = offset + node.text.indexOf(text);
	});
	if (found === undefined) throw new Error(`Missing fixture text: ${text}`);
	return found;
}

function Harness() {
	const [editor, setEditor] = useState(() =>
		makeEditor(parameters.get("href") ?? undefined),
	);
	const [disabled, setDisabled] = useState(false);
	const [mounted, setMounted] = useState(true);
	const [edits, setEdits] = useState(0);
	const editors = useRef<Editor[]>([]);
	useEffect(
		() => () => {
			for (const owned of editors.current) owned.destroy();
		},
		[],
	);
	useEffect(() => {
		editor.setEditable(!disabled);
	}, [editor, disabled]);
	useEffect(() => {
		editors.current.push(editor);
		const select = (text: string) =>
			editor
				.chain()
				.focus()
				.setTextSelection(position(editor, text) + 2)
				.run();
		const driver = {
			select,
			updateHref(href: string) {
				const from = position(editor, "Alpha guide");
				editor.view.dispatch(
					editor.state.tr.addMark(
						from,
						from + "Alpha guide".length,
						editor.schema.marks.link!.create({ href }),
					),
				);
			},
			disabled: setDisabled,
			mount: setMounted,
			replace() {
				setEditor(makeEditor("https://example.invalid/replacement"));
			},
			state: () => ({
				json: editor.getJSON(),
				selection: editor.state.selection.from,
				destroyed: editor.isDestroyed,
			}),
			// Retained editor events must have no effect after the owning effect cleans up.
			emit() {
				editor.emit("selectionUpdate", {
					editor,
					transaction: editor.state.tr,
				});
				editor.emit("update", {
					editor,
					transaction: editor.state.tr,
					appendedTransactions: [],
				});
			},
			destroy: () => editor.destroy(),
		};
		Object.assign(window, { documentLinkFixture: driver });
	}, [editor]);
	return (
		<main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 text-kumo-default">
			<h1 className="text-lg font-semibold">Document link regression</h1>
			<p className="text-sm text-kumo-subtle">
				Fictional destinations. Local editor transactions only.
			</p>
			<div className="flex flex-wrap gap-2">
				<Button
					className="min-h-11"
					variant="secondary"
					onClick={() => setDisabled((value) => !value)}
				>
					Toggle disabled
				</Button>
				<Button
					className="min-h-11"
					variant="secondary"
					onClick={() =>
						setEditor(makeEditor("https://example.invalid/replacement"))
					}
				>
					Replace editor
				</Button>
			</div>
			<div className="output-editor rounded-lg bg-kumo-base">
				<EditorContent editor={editor} />
			</div>
			<output aria-label="Edit callback count">{edits}</output>
			{mounted && (
				<DocumentLinkPopover
					editor={editor}
					disabled={disabled}
					onEdit={() => setEdits((value) => value + 1)}
				/>
			)}
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<Harness />);
