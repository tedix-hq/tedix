import {
	createDocEngine,
	blocksFromRichText,
	moveDocumentBlock,
	canMoveDocumentBlock,
	applyDocumentStyle,
	currentDocumentStyle,
	type Editor,
} from "./doc-engine";
import type {
	OsOutputContent,
	OsRichTextDocument,
	OsRichTextNode,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	mergeOutputContent,
	type OutputMergePreference,
} from "@tedix/api-contract/utils/output-merge";
import { showMergeChoice } from "./merge-choice";

type DocumentContent = Extract<OsOutputContent, { kind: "document" }>;
type Context = {
	workspaceId: string;
	role: string;
	gadget: { revision: number };
	settings: { slot: string };
	grants: { slot: string; operations: string[] }[];
};
type Saved = {
	output: { id: string; title: string; workspaceId: string; kind: string };
	revision: { revision: number; content: DocumentContent };
};
type Draft = { revision: number; content: DocumentContent };
export interface DocClientBridge {
	call<T = unknown>(method: string, args?: unknown): Promise<T>;
}

const css = `:root{font:14px var(--tedix-font,system-ui,sans-serif);color:var(--tedix-fg,CanvasText)}*{box-sizing:border-box}body{margin:0;padding:0!important}button,input,select{font:inherit;color:inherit}button,select,input[type=text]{background:var(--tedix-bg,Canvas);border:1px solid color-mix(in srgb,var(--tedix-fg,CanvasText) 22%,transparent);border-radius:5px;padding:6px 9px}button{cursor:pointer}button:disabled,select:disabled{opacity:.45;cursor:default}button[aria-pressed=true]{background:color-mix(in srgb,var(--tedix-primary,Highlight) 20%,var(--tedix-bg,Canvas))}.doc-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 16px}.doc-title{flex:1;min-width:160px}.doc-title h1{font-size:20px;margin:0}.doc-meta,.doc-status,.doc-note{font-size:12px;line-height:1.5}.doc-meta{opacity:.7;margin-top:4px}.doc-status,.doc-note{padding:8px 16px}.doc-status[data-error=true]{color:var(--tedix-fg,CanvasText);background:color-mix(in srgb,var(--tedix-warning,Mark) 30%,var(--tedix-bg,Canvas))}.doc-toolbar{display:flex;gap:5px;align-items:center;overflow-x:auto;padding:8px;border-block:1px solid color-mix(in srgb,var(--tedix-fg,CanvasText) 15%,transparent);position:sticky;top:0;background:var(--tedix-bg,Canvas);z-index:3}.doc-toolbar>*{flex-shrink:0}.doc-toolbar button{min-width:30px}.doc-toolbar input[type=color]{width:30px;height:30px;border:0;padding:3px;background:var(--tedix-bg,Canvas)}.doc-divider{height:22px;width:1px;margin:0 4px;background:color-mix(in srgb,var(--tedix-fg,CanvasText) 20%,transparent)}.doc-workbench{display:flex;gap:16px;padding:20px 16px;background:color-mix(in srgb,var(--tedix-fg,CanvasText) 4%,var(--tedix-bg,Canvas))}.doc-outline{width:150px;flex-shrink:0;padding-top:16px}.doc-outline button{display:block;text-align:left;border:0;font-size:12px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-block:4px}.doc-page{flex:1;min-width:0;max-width:860px;margin-inline:auto;background:var(--tedix-bg,Canvas);box-shadow:0 1px 8px #0001;padding:48px 56px;min-height:500px}.tiptap{outline:none;line-height:1.7;min-height:360px;overflow-wrap:anywhere}.tiptap>p:first-child{margin-top:0}.tiptap h1{font-size:2em}.tiptap h2{font-size:1.5em}.tiptap h3{font-size:1.25em}.tiptap .doc-title{font-size:2.2em;font-weight:650}.tiptap blockquote{margin-inline:0;border-left:3px solid var(--tedix-muted-fg,GrayText);padding-left:16px}.tiptap pre{font:13px ui-monospace,monospace;background:color-mix(in srgb,var(--tedix-fg,CanvasText) 6%,var(--tedix-bg,Canvas));padding:12px;white-space:pre-wrap}.tiptap code{font-family:ui-monospace,monospace}.tiptap ul[data-type=taskList]{list-style:none;padding-left:0}.tiptap li[data-type=taskItem]{display:flex;gap:8px;align-items:baseline}.tiptap li[data-type=taskItem]>div{flex:1}.tiptap li[data-type=taskItem] p{margin:4px 0}.tiptap table{border-collapse:collapse;table-layout:fixed;width:100%;margin:12px 0}.tiptap th,.tiptap td{border:1px solid var(--tedix-muted-fg,GrayText);min-width:60px;padding:7px;position:relative;vertical-align:top}.tiptap th{background:color-mix(in srgb,var(--tedix-fg,CanvasText) 6%,var(--tedix-bg,Canvas))}.tiptap .selectedCell:after{content:"";position:absolute;inset:0;background:color-mix(in srgb,var(--tedix-primary,Highlight) 12%,transparent);pointer-events:none}.tiptap .column-resize-handle{position:absolute;right:-2px;top:0;bottom:0;width:4px;background:var(--tedix-primary,Highlight)}.tiptap img{max-width:100%;height:auto}.tiptap aside{background:color-mix(in srgb,var(--tedix-warning,Mark) 15%,var(--tedix-bg,Canvas));padding:12px}.tiptap details{border:1px solid var(--tedix-muted-fg,GrayText);padding:10px}.tiptap a{color:var(--tedix-primary,LinkText);text-decoration:underline}.doc-link-form{display:flex;gap:6px;align-items:center;padding:8px 16px}.doc-link-form[hidden]{display:none}.doc-link-form input{flex:1;min-width:100px}@media(max-width:650px){.doc-outline{display:none}.doc-page{padding:24px 18px}.doc-workbench{padding:8px}.doc-header{padding:10px}.doc-title{flex-basis:100%}.doc-toolbar button{min-height:36px}}`;

export async function mountDocClient(
	root: HTMLElement,
	bridge: DocClientBridge,
) {
	const style = document.createElement("style");
	style.textContent =
		css +
		`.doc-meta{display:none}.doc-header{padding:8px 12px;gap:6px}.doc-title h1{font-size:15px;font-weight:600}.doc-header>button:not(.primary),.doc-header>select{border-color:transparent;background:transparent}.doc-header>button:not(.primary):hover:not(:disabled){background:color-mix(in srgb,var(--tedix-fg,CanvasText) 8%,transparent)}button.primary{background:var(--tedix-primary,Highlight);border-color:transparent;color:var(--tedix-on-primary,HighlightText)}.doc-status{padding:2px 16px;opacity:.75}.doc-status[data-error=true]{opacity:1}.doc-toolbar{flex-wrap:wrap;overflow:visible;position:relative}.doc-more{flex-basis:100%;min-width:0}.doc-more summary{cursor:pointer;padding:6px;width:fit-content;min-height:32px}.doc-extra{display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding:8px 0}.doc-extra>*{flex-shrink:0}.doc-toolbar select{max-width:100%}.doc-header>button{min-height:36px}@media(max-width:650px){.doc-toolbar{gap:4px}.doc-toolbar select{max-width:145px}.doc-toolbar button{padding:6px}.doc-header>button{flex:1}.doc-workbench{min-width:0}}`;
	document.head.append(style);
	root.innerHTML =
		'<main aria-label="Doc gadget"><header class="doc-header"><div class="doc-title"><h1>Doc</h1><div class="doc-meta"></div></div><button id="doc-reload" aria-label="Reload saved document">Reload</button><button id="doc-save" class="primary" aria-label="Save document">Save</button><button id="doc-export">Export Markdown</button></header><div class="doc-status" role="status" aria-live="polite"></div><div class="doc-note" id="doc-updates" role="status"></div><div class="doc-note" id="doc-file"></div><div class="doc-toolbar" role="toolbar" aria-label="Document formatting"></div><form class="doc-link-form" hidden><label>Link <input type="text" aria-label="Link URL" placeholder="https://example.test"></label><button type="submit">Apply link</button><button type="button" id="doc-unlink">Remove link</button><button type="button" id="doc-link-close">Close</button></form><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" id="doc-image" hidden><div class="doc-workbench"><nav class="doc-outline" aria-label="Document outline"></nav><section class="doc-page" aria-label="Document page"></section></div></main>';
	const get = <T extends HTMLElement>(selector: string) =>
		root.querySelector<T>(selector)!;
	const status = get(".doc-status"),
		updates = get("#doc-updates"),
		page = get(".doc-page"),
		toolbar = get(".doc-toolbar");
	let toolbarTarget = toolbar;
	const saveButton = get<HTMLButtonElement>("#doc-save"),
		reloadButton = get<HTMLButtonElement>("#doc-reload"),
		exportButton = get<HTMLButtonElement>("#doc-export");
	const exportFormat = document.createElement("select");
	exportFormat.setAttribute("aria-label", "Export format");
	for (const [value, label] of [
		["md", "Markdown"],
		["docx", "Word"],
		["pdf", "PDF"],
		["html", "HTML"],
		["png", "PNG"],
	] as const) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = label;
		exportFormat.append(option);
	}
	exportButton.before(exportFormat);
	exportFormat.onchange = () => {
		exportButton.textContent = `Export ${exportFormat.selectedOptions[0]!.textContent}`;
	};
	const linkForm = get<HTMLFormElement>(".doc-link-form"),
		linkInput = get<HTMLInputElement>('[aria-label="Link URL"]'),
		imageInput = get<HTMLInputElement>("#doc-image");
	const context = await bridge.call<Context>("context");
	const slot = context.settings?.slot;
	if (!slot || !context.workspaceId)
		throw new Error("Document slot is not configured");
	const editable =
		(context.role === "owner" || context.role === "build") &&
		context.grants?.some(
			(grant) =>
				grant.slot === slot && grant.operations.includes("outputs.write"),
		);
	let loaded: Saved | undefined,
		draft: DocumentContent | undefined,
		editor: Editor | undefined;
	let basis = 0,
		dirty = false,
		busy = false,
		available = false,
		discardPending = false,
		pendingRevision = 0,
		destroyed = false,
		// A newer saved revision that overlaps the draft, waiting for a choice.
		choice = 0;
	const buttons: {
		button: HTMLButtonElement;
		active?: () => boolean;
		available?: () => boolean;
	}[] = [];
	const message = (text: string, error = false) => {
		status.textContent = text;
		status.dataset.error = String(error);
	};
	const call = <T>(method: string, input: unknown = {}) =>
		bridge.call<T>("app.call", { method, args: [input] });
	// The host reads the bound Output directly; the app server is the fallback
	// for hosts that cannot (share links, older hosts).
	const read = () =>
		bridge
			.call<Saved>("outputs.readRevision", { slot })
			.catch(() => call<Saved>("readDocument"));
	const draftArgs = () => ({ slot, outputId: loaded!.output.id });
	function parse(value: Saved): Saved {
		if (
			value?.output?.workspaceId !== context.workspaceId ||
			value.output.kind !== "document" ||
			!value.output.id ||
			!Number.isInteger(value.revision?.revision) ||
			value.revision.content?.kind !== "document" ||
			!Array.isArray(value.revision.content.blocks) ||
			(loaded && loaded.output.id !== value.output.id)
		)
			throw new Error("The app returned an invalid document");
		return value;
	}
	function controls() {
		saveButton.disabled = busy || !editable || !dirty || !editor || !available;
		reloadButton.disabled = busy;
		exportButton.disabled = busy || !loaded || !available;
		exportFormat.disabled = busy || !loaded || !available;
		toolbar
			.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select")
			.forEach(
				(node) => (node.disabled = busy || !editable || !editor || !available),
			);
		linkForm
			.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")
			.forEach((node) => (node.disabled = busy || !editable || !available));
		for (const { button, active, available: commandAvailable } of buttons) {
			button.disabled =
				busy ||
				!editable ||
				!editor ||
				!available ||
				(commandAvailable ? !commandAvailable() : false);
			if (active)
				button.setAttribute("aria-pressed", String(!!editor && active()));
		}
		editor?.setEditable(!!editable && !busy && available, false);
	}
	function outline() {
		const nav = get(".doc-outline");
		nav.replaceChildren();
		editor?.state.doc.descendants((node, position) => {
			if (node.type.name !== "heading") return;
			const button = document.createElement("button");
			button.textContent = node.textContent || "Untitled heading";
			button.style.paddingLeft = `${Math.max(0, Number(node.attrs.level) - 1) * 10}px`;
			button.onclick = () =>
				editor
					?.chain()
					.focus()
					.setTextSelection(position + 1)
					.scrollIntoView()
					.run();
			nav.append(button);
		});
	}
	function updateNotice() {
		const revision = Math.max(pendingRevision, loaded?.revision.revision ?? 0);
		if (dirty && choice > basis)
			return showMergeChoice(
				updates,
				choice,
				(prefer) => void mergeLatest(prefer),
			);
		updates.textContent =
			dirty && revision > basis
				? `Document revision ${revision} is available. Your draft stays based on revision ${basis}; save still checks that revision.`
				: "";
	}
	/**
	 * Bring someone else's newer save into the unsaved draft. Only a draft
	 * started from the revision this editor loaded can merge here; an older
	 * retained draft merges on the server when it is saved.
	 */
	async function mergeLatest(prefer?: OutputMergePreference) {
		if (
			!loaded ||
			!draft ||
			!editor ||
			!dirty ||
			busy ||
			destroyed ||
			basis !== loaded.revision.revision
		)
			return;
		busy = true;
		controls();
		try {
			const latest = parse(await read());
			if (destroyed || latest.revision.revision <= basis) return;
			// Compare documents the way this editor writes them.
			const normal = (content: DocumentContent): DocumentContent =>
				content.richText
					? {
							...content,
							richText: editor!.schema
								.nodeFromJSON(content.richText)
								.toJSON() as OsRichTextDocument,
						}
					: content;
			const result = mergeOutputContent(
				normal(loaded.revision.content),
				normal(draft),
				normal(latest.revision.content),
				{ prefer, documentBlocks: blocksFromRichText },
			);
			if (!result.ok) {
				choice = latest.revision.revision;
				return;
			}
			choice = 0;
			const { from, to } = editor.state.selection;
			loaded = latest;
			basis = latest.revision.revision;
			draft = result.content as DocumentContent;
			renderContent();
			const end = editor.state.doc.content.size;
			editor.commands.setTextSelection({
				from: Math.min(from, end),
				to: Math.min(to, end),
			});
			get(".doc-meta").textContent =
				`Document revision ${basis} · Doc app version ${context.gadget.revision}`;
			message(
				`Unsaved changes · merged with document revision ${basis}${prefer ? `; kept ${prefer === "mine" ? "your" : "their"} version where you both edited` : ""}`,
			);
			void retainDraft();
		} catch (error) {
			message(
				`${error instanceof Error ? error.message : "Merging the newer revision failed"}. Your draft is preserved.`,
				true,
			);
		} finally {
			busy = false;
			controls();
			updateNotice();
		}
	}
	async function retainDraft() {
		if (!loaded || !draft || !editable) return;
		try {
			await bridge.call("app.draft.write", {
				...draftArgs(),
				revision: basis,
				content: draft,
			});
		} catch (error) {
			if (!destroyed)
				message(
					`${error instanceof Error ? error.message : "Draft retention failed"}. Save before leaving this tab.`,
					true,
				);
		}
	}
	function changed() {
		if (!editor || !loaded || busy || !editable || !available) return;
		const richText = editor.getJSON() as OsRichTextDocument;
		draft = { ...draft!, richText, blocks: blocksFromRichText(richText) };
		dirty = true;
		discardPending = false;
		reloadButton.textContent = "Reload";
		message("Unsaved changes");
		updateNotice();
		controls();
		outline();
		void retainDraft();
	}
	function renderContent() {
		const content = draft!;
		const source =
			content.richText ??
			(content.blocks.length === 0 && !content.file
				? { type: "doc" as const, content: [] }
				: undefined);
		if (!source)
			throw new Error(
				"This legacy document needs its rich editor state initialized. Open the native editor once; the saved content has not changed.",
			);
		if (!editor) {
			editor = createDocEngine({
				element: page,
				editable: !!editable,
				onUpdate: changed,
			});
			editor.on("selectionUpdate", controls);
			editor.on("transaction", controls);
		}
		const validateNodes = (nodes: OsRichTextNode[]) => {
			for (const node of nodes) {
				const type = editor!.schema.nodes[node.type];
				if (
					!type ||
					Object.keys(node.attrs ?? {}).some(
						(key) => !(key in (type.spec.attrs ?? {})),
					)
				)
					throw new Error(
						"This document uses formatting this editor cannot preserve. Its saved content has not changed.",
					);
				for (const mark of node.marks ?? []) {
					const type = editor!.schema.marks[mark.type];
					if (
						!type ||
						Object.keys(mark.attrs ?? {}).some(
							(key) => !(key in (type.spec.attrs ?? {})),
						)
					)
						throw new Error(
							"This document uses unsupported inline formatting. Its saved content has not changed.",
						);
				}
				if (node.content) validateNodes(node.content);
			}
		};
		validateNodes(source.content);
		const richText = source.content.length
			? source
			: { type: "doc" as const, content: [{ type: "paragraph" }] };
		editor.schema.nodeFromJSON(richText).check();
		editor
			.chain()
			.setContent(richText, { emitUpdate: false })
			.setMeta("addToHistory", false)
			.run();
		page.hidden = false;
		outline();
		controls();
	}
	async function load(discard = false) {
		busy = true;
		controls();
		message("Loading document…");
		try {
			const value = parse(await read());
			if (destroyed) return;
			loaded = value;
			choice = 0;
			let retained: Draft | null = null;
			if (editable) {
				if (discard) await bridge.call("app.draft.clear", draftArgs());
				else
					retained = await bridge.call<Draft | null>(
						"app.draft.read",
						draftArgs(),
					);
			}
			if (destroyed) return;
			if (
				retained &&
				(retained.content.kind !== "document" ||
					!Number.isInteger(retained.revision) ||
					retained.revision < 1)
			)
				throw new Error("The retained draft is invalid");
			basis = retained?.revision ?? value.revision.revision;
			draft = structuredClone(retained?.content ?? value.revision.content);
			dirty = !!retained;
			available = true;
			discardPending = false;
			reloadButton.textContent = "Reload";
			get("h1").textContent = value.output.title;
			get(".doc-meta").textContent =
				`Document revision ${value.revision.revision} · Doc app version ${context.gadget.revision}`;
			get("#doc-file").textContent = draft.file
				? "The attached file is preserved. Use the native editor to preview it."
				: "";
			renderContent();
			message(
				dirty
					? "Restored your unsaved changes"
					: `Saved${editable ? "" : " · Read only"}`,
			);
			updateNotice();
		} catch (error) {
			available = false;
			page.hidden = true;
			editor?.setEditable(false, false);
			message(
				error instanceof Error
					? error.message
					: "Document access is unavailable",
				true,
			);
			if (loaded && editable)
				await bridge
					.call("app.draft.clear", draftArgs())
					.catch(() => undefined);
		} finally {
			busy = false;
			controls();
		}
	}
	async function save() {
		if (!loaded || !draft || !dirty || !editable || busy || !available) return;
		const input = { slot, content: draft, expectedRevision: basis };
		if (new TextEncoder().encode(JSON.stringify(draft)).length > 1_000_000) {
			message(
				"This document exceeds the gadget's 1 MB save limit. Your draft is preserved. Use the native editor for this revision.",
				true,
			);
			return;
		}
		busy = true;
		controls();
		message("Saving document…");
		try {
			const value = parse(await bridge.call<Saved>("outputs.replace", input));
			if (destroyed) return;
			loaded = value;
			basis = value.revision.revision;
			draft = structuredClone(value.revision.content);
			dirty = false;
			choice = 0;
			await bridge.call("app.draft.clear", draftArgs());
			get(".doc-meta").textContent =
				`Document revision ${basis} · Doc app version ${context.gadget.revision}`;
			renderContent();
			message("Saved");
			updateNotice();
		} catch (error) {
			message(
				`${error instanceof Error ? error.message : "Save failed"}. Your draft is preserved; reload only when ready to discard it.`,
				true,
			);
		} finally {
			busy = false;
			controls();
		}
		// A save refused because someone else saved first: bring their changes in.
		if (dirty) void mergeLatest();
	}
	function button(
		label: string,
		text: string,
		action: () => unknown,
		active?: () => boolean,
		available?: () => boolean,
	) {
		const node = document.createElement("button");
		node.type = "button";
		node.textContent = text;
		node.title = label;
		node.setAttribute("aria-label", label);
		node.addEventListener("mousedown", (event) => event.preventDefault());
		node.onclick = () => {
			if (!node.disabled) {
				action();
				controls();
			}
		};
		toolbarTarget.append(node);
		buttons.push({ button: node, active, available });
		return node;
	}
	function select(
		label: string,
		values: [string, string][],
		action: (value: string) => void,
	) {
		const node = document.createElement("select");
		node.setAttribute("aria-label", label);
		for (const [value, text] of values) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = text;
			node.append(option);
		}
		node.onchange = () => {
			action(node.value);
			controls();
		};
		toolbarTarget.append(node);
		return node;
	}
	const divider = () => {
		const line = document.createElement("span");
		line.className = "doc-divider";
		line.setAttribute("aria-hidden", "true");
		toolbarTarget.append(line);
	};
	button(
		"Undo",
		"↶",
		() => editor?.chain().focus().undo().run(),
		undefined,
		() => !!editor?.can().undo(),
	);
	button(
		"Redo",
		"↷",
		() => editor?.chain().focus().redo().run(),
		undefined,
		() => !!editor?.can().redo(),
	);
	button(
		"Move block up",
		"↑",
		() => editor && moveDocumentBlock(editor, -1),
		undefined,
		() => !!editor && canMoveDocumentBlock(editor, -1),
	);
	button(
		"Move block down",
		"↓",
		() => editor && moveDocumentBlock(editor, 1),
		undefined,
		() => !!editor && canMoveDocumentBlock(editor, 1),
	);
	divider();
	const blockStyle = select(
		"Block style",
		[
			["paragraph", "Text"],
			["title", "Title"],
			["1", "Heading 1"],
			["2", "Heading 2"],
			["3", "Heading 3"],
			["quote", "Quote"],
			["code", "Code block"],
		],
		(value) =>
			editor &&
			applyDocumentStyle(
				editor,
				value as Parameters<typeof applyDocumentStyle>[1],
			),
	);
	for (const [name, text] of [
		["bold", "B"],
		["italic", "I"],
		["underline", "U"],
		["strike", "S"],
		["code", "</>"],
	] as const)
		button(
			name === "strike"
				? "Strikethrough"
				: name[0]!.toUpperCase() + name.slice(1),
			text,
			() => editor?.chain().focus().toggleMark(name).run(),
			() => !!editor?.isActive(name),
		);
	button("Add link", "Link", () => {
		linkForm.hidden = false;
		linkInput.value = String(editor?.getAttributes("link").href ?? "");
		linkInput.focus();
	});
	const more = document.createElement("details");
	more.className = "doc-more";
	const summary = document.createElement("summary");
	summary.textContent = "More formatting & insert";
	const extra = document.createElement("div");
	extra.className = "doc-extra";
	more.append(summary, extra);
	toolbar.append(more);
	toolbarTarget = extra;
	divider();
	button(
		"Bulleted list",
		"• List",
		() => editor?.chain().focus().toggleBulletList().run(),
		() => !!editor?.isActive("bulletList"),
	);
	button(
		"Numbered list",
		"1. List",
		() => editor?.chain().focus().toggleOrderedList().run(),
		() => !!editor?.isActive("orderedList"),
	);
	button(
		"Checklist",
		"☑",
		() => editor?.chain().focus().toggleTaskList().run(),
		() => !!editor?.isActive("taskList"),
	);
	button("Insert table", "Table", () =>
		editor
			?.chain()
			.focus()
			.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
			.run(),
	);
	button(
		"Add table row",
		"+ Row",
		() => editor?.chain().focus().addRowAfter().run(),
		undefined,
		() => !!editor?.can().addRowAfter(),
	);
	button(
		"Add table column",
		"+ Column",
		() => editor?.chain().focus().addColumnAfter().run(),
		undefined,
		() => !!editor?.can().addColumnAfter(),
	);
	button(
		"Delete table",
		"− Table",
		() => editor?.chain().focus().deleteTable().run(),
		undefined,
		() => !!editor?.can().deleteTable(),
	);
	button("Insert note", "Note", () =>
		editor
			?.chain()
			.focus()
			.insertContent({ type: "callout", content: [{ type: "paragraph" }] })
			.run(),
	);
	button("Insert details", "Details", () =>
		editor
			?.chain()
			.focus()
			.insertContent({
				type: "details",
				content: [
					{
						type: "detailsSummary",
						content: [{ type: "text", text: "Details" }],
					},
					{ type: "detailsContent", content: [{ type: "paragraph" }] },
				],
			})
			.run(),
	);
	button("Insert divider", "—", () =>
		editor?.chain().focus().setHorizontalRule().run(),
	);
	button("Insert image", "Image", () => imageInput.click());
	divider();
	for (const align of ["left", "center", "right", "justify"])
		button(`Align ${align}`, align[0]!.toUpperCase() + align.slice(1), () =>
			editor?.chain().focus().setTextAlign(align).run(),
		);
	select(
		"Font family",
		[
			["", "Sans serif"],
			["Georgia,serif", "Serif"],
			["ui-monospace,monospace", "Mono"],
		],
		(value) =>
			value
				? editor?.chain().focus().setFontFamily(value).run()
				: editor?.chain().focus().unsetFontFamily().run(),
	);
	select(
		"Font size",
		[
			["12pt", "12 pt"],
			["14pt", "14 pt"],
			["18pt", "18 pt"],
			["24pt", "24 pt"],
			["32pt", "32 pt"],
		],
		(value) => editor?.chain().focus().setFontSize(value).run(),
	);
	for (const [label, command] of [
		["Text color", "setColor"],
		["Highlight color", "highlight"],
	]) {
		const color = document.createElement("input");
		color.type = "color";
		color.setAttribute("aria-label", label!);
		color.title = label!;
		color.oninput = () =>
			command === "setColor"
				? editor?.chain().focus().setColor(color.value).run()
				: editor?.chain().focus().setHighlight({ color: color.value }).run();
		toolbarTarget.append(color);
	}
	linkForm.onsubmit = (event) => {
		event.preventDefault();
		if (busy || !editable || !available) return;
		const href = linkInput.value.trim();
		if (!/^(https?:|mailto:)/i.test(href)) {
			message("Use an https, http or mailto link.", true);
			return;
		}
		editor?.chain().focus().extendMarkRange("link").setLink({ href }).run();
		linkForm.hidden = true;
	};
	get<HTMLButtonElement>("#doc-unlink").onclick = () => {
		editor?.chain().focus().extendMarkRange("link").unsetLink().run();
		linkForm.hidden = true;
	};
	get<HTMLButtonElement>("#doc-link-close").onclick = () => {
		linkForm.hidden = true;
		editor?.commands.focus();
	};
	imageInput.onchange = async () => {
		const file = imageInput.files?.[0];
		if (!file) return;
		if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type) || file.size > 32_000) {
			message(
				"Use a PNG, JPEG, GIF or WebP image up to 32 KB so the document can stay within the gadget save limit.",
				true,
			);
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			if (
				!destroyed &&
				available &&
				editable &&
				!busy &&
				typeof reader.result === "string"
			)
				editor
					?.chain()
					.focus()
					.setImage({ src: reader.result, alt: file.name })
					.run();
		};
		reader.onerror = () => message("The image could not be read.", true);
		reader.readAsDataURL(file);
		imageInput.value = "";
	};
	saveButton.onclick = () => void save();
	reloadButton.onclick = () => {
		if (dirty && !discardPending) {
			discardPending = true;
			reloadButton.textContent = "Discard draft & reload";
			message("Reload will discard your draft. Click again to confirm.", true);
			return;
		}
		void load(true);
	};
	exportButton.onclick = async () => {
		if (busy || !loaded || !available) return;
		busy = true;
		controls();
		try {
			if (exportFormat.value !== "md") {
				await bridge.call("app.exportOutput", {
					slot,
					format: exportFormat.value,
					expectedRevision: loaded.revision.revision,
				});
				message(
					`Exported saved document revision ${loaded.revision.revision}${dirty ? "; unsaved edits are not included" : ""}.`,
				);
				return;
			}
			const result = await call<{
				text: string;
				title: string;
				revision: number;
			}>("exportMarkdown");
			await bridge.call("app.download", {
				filename:
					(result.title || "Document").replace(/[\\/:*?"<>|]/g, "_") + ".md",
				mimeType: "text/markdown",
				text: result.text,
			});
			message(
				`Exported saved document revision ${result.revision} as semantic Markdown. Rich formatting${dirty ? " and unsaved edits are" : " is"} not included.`,
			);
		} catch (error) {
			message(error instanceof Error ? error.message : "Export failed", true);
		} finally {
			busy = false;
			controls();
		}
	};
	const beforeUnload = (event: BeforeUnloadEvent) => {
		if (dirty) {
			event.preventDefault();
			event.returnValue = "";
		}
	};
	const keydown = (event: KeyboardEvent) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
			event.preventDefault();
			void save();
		}
	};
	const onMessage = (event: MessageEvent) => {
		if (
			event.source !== window.parent ||
			event.data?.jsonrpc !== "2.0" ||
			event.data.method !== "tedix/outputs-changed" ||
			!Array.isArray(event.data.params?.outputs) ||
			!loaded
		)
			return;
		for (const output of event.data.params.outputs)
			if (
				output.slot === slot &&
				output.outputId === loaded.output.id &&
				Number.isInteger(output.revision)
			)
				pendingRevision = Math.max(pendingRevision, output.revision);
		updateNotice();
		if (!dirty && !busy && pendingRevision > loaded.revision.revision) {
			pendingRevision = 0;
			void load();
		} else if (dirty && pendingRevision > basis) void mergeLatest();
	};
	window.addEventListener("message", onMessage);
	window.addEventListener("beforeunload", beforeUnload);
	root.addEventListener("keydown", keydown);
	await load();
	editor?.on("selectionUpdate", () => {
		blockStyle.value = currentDocumentStyle(editor!);
	});
	return {
		get editor() {
			return editor;
		},
		get dirty() {
			return dirty;
		},
		save,
		reload: () => load(true),
		destroy() {
			destroyed = true;
			editor?.destroy();
			style.remove();
			window.removeEventListener("message", onMessage);
			window.removeEventListener("beforeunload", beforeUnload);
			root.removeEventListener("keydown", keydown);
		},
	};
}
