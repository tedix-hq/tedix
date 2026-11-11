import {
	createDocEngine,
	blocksFromRichText,
	moveDocumentBlock,
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
import { editorIcon, type EditorIcon } from "./editor-icons";
import { lastingSaveFailure } from "../lib/save-failure";

type DocumentContent = Extract<OsOutputContent, { kind: "document" }>;
type Context = {
	workspaceId: string;
	role: string;
	settings: { slot: string };
	grants: { slot: string; operations: string[] }[];
};
type Saved = {
	output: { id: string; title: string; workspaceId: string; kind: string };
	revision: { revision: number; content: DocumentContent };
};
type Draft = { revision: number; content: DocumentContent };
type DocNode = Editor["state"]["doc"];
type Action = [label: string, run: () => void];
export interface DocClientBridge {
	call<T = unknown>(method: string, args?: unknown): Promise<T>;
}

/** Wait after the last edit before saving, and the longest a save may wait. */
const SAVE_IDLE_MS = 1500,
	SAVE_MAX_MS = 5000;

const css = `:root{--ease:cubic-bezier(.2,.8,.2,1);--fg:var(--tedix-fg,CanvasText);--bg:var(--tedix-bg,Canvas);--pri:var(--tedix-primary,Highlight);--mut:var(--tedix-muted-fg,GrayText);--hov:color-mix(in srgb,var(--fg) 5.5%,var(--bg));--act:color-mix(in srgb,var(--fg) 8.5%,var(--bg));--line:color-mix(in srgb,var(--fg) 8%,transparent);--edge:color-mix(in srgb,var(--fg) 15%,transparent);--card:var(--tedix-surface,var(--bg));font:14px var(--tedix-font,system-ui,sans-serif);color:var(--fg);scrollbar-width:thin;scrollbar-color:var(--edge) transparent}*{box-sizing:border-box}body{margin:0;padding:0!important;background:var(--bg)}button,input,select{font:inherit;color:inherit}[hidden]{display:none!important}:focus-visible{outline:2px solid var(--pri);outline-offset:1px}.doc-toolbar{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:2px;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;padding:6px 10px;background:var(--bg);border-bottom:1px solid transparent;transition:border-color .12s}.doc-toolbar[data-scrolled]{border-color:var(--line)}.doc-toolbar>*{flex:none}.doc-table{display:contents}.doc-toolbar button,.doc-toolbar select,.doc-menu button,.doc-status button{height:29px;min-width:29px;display:inline-grid;place-items:center;padding:0 6px;border:0;border-radius:6px;background:none;cursor:pointer;transition:background .12s var(--ease),transform .12s var(--ease)}:is(button,select):hover:not(:disabled){background:var(--hov)}button:active:not(:disabled){background:var(--act);transform:scale(.94)}:is(button,select):disabled{opacity:.38;cursor:default}button[aria-pressed=true]{background:var(--act);color:var(--pri)}.doc-sep{flex:none;width:1px;height:16px;margin:0 5px;background:var(--edge)}.doc-readonly{padding:0 8px;font-size:12px;color:var(--mut)}.doc-toolbar .doc-more{margin-left:auto;position:sticky;right:0;background:var(--bg)}.doc-page{max-width:calc(700px + 2*clamp(20px,5.5vw,52px));margin:0 auto;padding:22px clamp(20px,5.5vw,52px) min(40vh,300px)}.doc-skel{animation:doc-fade .3s .25s both}.doc-skel i{display:block;height:12px;margin-bottom:15px;border-radius:6px;background:var(--act)}.doc-skel i:first-child{width:45%;height:26px;margin-bottom:24px}.doc-skel i:last-child{width:60%}@keyframes doc-fade{from{opacity:0}}@keyframes doc-in{from{opacity:0;transform:scale(.96)}}.doc-status,.doc-link,.doc-menu{position:fixed;background:var(--card);border:1px solid var(--edge);box-shadow:0 6px 22px #0002;animation:doc-in .16s var(--ease)}.doc-status{top:48px;right:12px;z-index:4;max-width:min(380px,calc(100% - 24px));display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;padding:5px 11px;border-radius:14px;font-size:12px;line-height:1.45;color:var(--mut)}.doc-status:empty{display:none}.doc-status[data-error=true]{color:var(--tedix-danger,#c0262d)}.doc-status button{height:24px;color:var(--fg);background:var(--hov)}.doc-link,.doc-menu{z-index:5;padding:5px;border-radius:10px;transform-origin:0 0}.doc-link{display:flex;gap:4px}.doc-link input{width:min(250px,60vw);height:29px;padding:0 8px;border:0;border-radius:6px;background:var(--hov)}.doc-link button{height:29px;padding:0 10px;border:0;border-radius:6px;background:var(--pri);color:var(--tedix-on-primary,HighlightText);cursor:pointer}.doc-menu{display:grid;min-width:180px}.doc-menu button{justify-content:start;padding:0 9px}.doc-menu div{display:flex;gap:2px}.doc-menu hr{width:100%;height:0;border:0;border-top:1px solid var(--line);margin:4px 0}.tiptap{outline:0;font-size:16px;line-height:1.62;min-height:50vh;caret-color:var(--pri);overflow-wrap:anywhere}.tiptap>:first-child{margin-top:0}.tiptap p{margin:0 0 .8em}.tiptap h1{font-size:1.875em;line-height:1.22;font-weight:680;letter-spacing:-.024em;margin:1.3em 0 .4em}.tiptap h2{font-size:1.4em;line-height:1.3;font-weight:640;letter-spacing:-.016em;margin:1.3em 0 .35em}.tiptap h3{font-size:1.15em;line-height:1.4;font-weight:620;margin:1.2em 0 .3em}.tiptap .doc-title{font-size:2.3em;font-weight:700}.tiptap [data-hint]:before{content:attr(data-hint);float:left;height:0;pointer-events:none;color:var(--mut);opacity:.65}.tiptap blockquote{margin:0 0 .8em;padding-left:14px;border-left:2px solid var(--edge);color:color-mix(in srgb,var(--fg) 72%,transparent)}.tiptap pre{font:13px/1.55 var(--tedix-font-mono,ui-monospace,monospace);background:var(--hov);margin:0 0 1em;padding:12px 14px;border-radius:8px;white-space:pre-wrap}.tiptap code{font-family:var(--tedix-font-mono,ui-monospace,monospace);font-size:.9em}.tiptap :not(pre)>code{background:var(--act);padding:.1em .3em;border-radius:4px}.tiptap hr{border:0;border-top:1px solid var(--edge);margin:1.6em 0}.tiptap ul,.tiptap ol{margin:0 0 .8em;padding-left:1.5em}.tiptap li p{margin:0 0 .2em}.tiptap ul[data-type=taskList]{list-style:none;padding-left:0}.tiptap li[data-checked]{display:flex;gap:9px}.tiptap li[data-checked]>div{flex:1}.tiptap li[data-checked=true]>div{color:var(--mut)}.tiptap input[type=checkbox]{appearance:none;display:grid;place-content:center;width:16px;height:16px;margin:5px 0 0;border:1.5px solid color-mix(in srgb,var(--fg) 34%,transparent);border-radius:4.5px;cursor:pointer;transition:background .12s}.tiptap input:checked{background:var(--pri);border-color:var(--pri)}.tiptap input:checked:after{content:"";width:8px;height:4px;margin-top:-2px;border:solid var(--tedix-on-primary,HighlightText);border-width:0 0 2px 2px;transform:rotate(-45deg)}.tiptap table{border-collapse:separate;border-spacing:0;table-layout:fixed;width:100%;margin:0 0 1em;border:1px solid var(--edge);border-radius:8px;overflow:hidden}.tiptap th,.tiptap td{border:solid var(--line);border-width:0 1px 1px 0;min-width:60px;padding:7px 10px;position:relative;vertical-align:top;text-align:left}.tiptap :is(th,td):last-child{border-right:0}.tiptap tr:last-child>*{border-bottom:0}.tiptap th{background:color-mix(in srgb,var(--fg) 3.5%,transparent);font-weight:600}.tiptap :is(th,td) p{margin:0}.tiptap .selectedCell:after{content:"";position:absolute;inset:0;background:color-mix(in srgb,var(--pri) 12%,transparent);pointer-events:none}.tiptap .column-resize-handle{position:absolute;right:0;top:0;bottom:0;width:3px;background:var(--pri)}.tiptap img{max-width:100%;height:auto;border-radius:6px}.tiptap .ProseMirror-selectednode{outline:2px solid var(--pri)}.tiptap aside,.tiptap [data-type=details]{margin:0 0 1em;padding:11px 14px;border-radius:8px;background:var(--hov)}.tiptap [data-type=details]{display:flex;gap:6px}.tiptap [data-type=details]>button{flex:none;width:22px;height:26px;border:0;border-radius:5px;background:none;cursor:pointer}.tiptap [data-type=details]>button:before{content:"▸"}.tiptap .is-open>button:before{content:"▾"}.tiptap [data-type=details]>div{flex:1;min-width:0}.tiptap summary{list-style:none;font-weight:600}.tiptap :is(aside,[data-type=detailsContent])>:last-child{margin-bottom:0}.tiptap a{color:var(--pri);text-decoration:underline}@media(pointer:coarse){.doc-toolbar button,.doc-toolbar select{height:36px;min-width:36px}}`;

export async function mountDocClient(
	root: HTMLElement,
	bridge: DocClientBridge,
) {
	const style = document.createElement("style");
	style.textContent = css;
	document.head.append(style);
	root.innerHTML =
		'<main aria-label="Doc gadget"><div class="doc-toolbar" role="toolbar" aria-label="Document formatting"></div><div class="doc-status" role="status" aria-live="polite"></div><form class="doc-link" hidden><input type="text" aria-label="Link URL" placeholder="Paste or type a link"><button type="submit">Apply</button></form><div class="doc-menu" role="menu" aria-label="More" hidden></div><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden><section class="doc-page" aria-label="Document page"><div class="doc-skel"><i></i><i></i><i></i><i></i><i></i></div></section></main>';
	const get = <T extends HTMLElement>(selector: string) =>
		root.querySelector<T>(selector)!;
	const status = get(".doc-status"),
		page = get(".doc-page"),
		toolbar = get(".doc-toolbar"),
		menu = get(".doc-menu"),
		linkForm = get<HTMLFormElement>(".doc-link"),
		linkInput = get<HTMLInputElement>(".doc-link input"),
		imageInput = get<HTMLInputElement>("input[type=file]");
	const context = await bridge.call<Context>("context");
	const slot = context.settings?.slot;
	if (!slot || !context.workspaceId)
		throw new Error("Document slot is not configured");
	const editable =
		(context.role === "owner" || context.role === "build") &&
		!!context.grants?.some(
			(grant) =>
				grant.slot === slot && grant.operations.includes("outputs.write"),
		);
	// `loaded` is the saved copy the draft started from; `draft` carries the
	// parts of the document the editor does not show, such as an attached file.
	let loaded: Saved | undefined,
		draft: DocumentContent | undefined,
		editor: Editor | undefined,
		// A newer saved copy that overlaps the draft, waiting for a choice.
		theirs: Saved | undefined,
		waiting: Promise<void> | undefined,
		tail: Promise<unknown> = Promise.resolve();
	let basis = 0,
		dirty = false,
		available = false,
		destroyed = false,
		failed = false,
		since = 0,
		frame = 0;
	let saveTimer: ReturnType<typeof setTimeout> | undefined,
		draftTimer: typeof saveTimer,
		statusTimer: typeof saveTimer;
	const buttons: {
		node: HTMLButtonElement;
		active?: () => boolean;
		can?: () => boolean;
	}[] = [];
	let blockStyle: HTMLSelectElement | undefined,
		tableTools: HTMLElement | undefined;

	/** Show a short status. Plain notes fade; anything with a choice stays. */
	function say(
		text = "",
		error = false,
		actions: Action[] = [],
		brief = false,
	) {
		clearTimeout(statusTimer);
		status.textContent = text;
		status.dataset.error = String(error);
		for (const [label, run] of actions) {
			const node = document.createElement("button");
			node.type = "button";
			node.textContent = label;
			node.onclick = run;
			status.append(node);
		}
		// A pending choice comes back once a passing note has been read.
		if (text && !actions.length)
			statusTimer = setTimeout(
				() => (theirs ? ask() : say()),
				brief ? 1300 : 7000,
			);
	}
	const reason = (error: unknown, fallback: string) =>
		error instanceof Error && error.message ? error.message : fallback;
	const call = <T>(method: string, input: unknown = {}) =>
		bridge.call<T>("app.call", { method, args: [input] });
	// The host reads the bound Output directly; the app server is the fallback
	// for hosts that cannot (share links, older hosts).
	const read = () =>
		bridge
			.call<Saved>("outputs.readRevision", { slot })
			.catch(() => call<Saved>("readDocument"));
	const draftArgs = () => ({ slot, outputId: loaded!.output.id });
	const clearDraft = () => {
		clearTimeout(draftTimer);
		if (loaded && editable)
			void bridge.call("app.draft.clear", draftArgs()).catch(() => undefined);
	};
	/** One save or refresh at a time, in the order they were asked for. */
	const queue = <T>(work: () => Promise<T>): Promise<T> => {
		const next = tail.then(work, work);
		tail = next.catch(() => undefined);
		return next;
	};
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

	// Toolbar state is read at most once per frame, however fast someone types.
	function paint() {
		frame = 0;
		if (destroyed) return;
		const on = !!editor && editable && available;
		if (editor && editor.isEditable !== on) editor.setEditable(on, false);
		for (const { node, active, can } of buttons) {
			const off = !on || (can ? !can() : false);
			if (node.disabled !== off) node.disabled = off;
			if (active) {
				const pressed = String(on && active());
				if (node.getAttribute("aria-pressed") !== pressed)
					node.setAttribute("aria-pressed", pressed);
			}
		}
		if (blockStyle) {
			blockStyle.disabled = !on;
			if (on) blockStyle.value = currentDocumentStyle(editor!);
		}
		if (tableTools) tableTools.hidden = !on || !editor!.isActive("table");
	}
	const controls = () => {
		frame ||= requestAnimationFrame(paint);
	};

	/** The document as it is on screen, in the shape a save sends. */
	function snapshot(): DocumentContent {
		const richText = editor!.getJSON() as OsRichTextDocument;
		return { ...draft!, richText, blocks: blocksFromRichText(richText) };
	}
	/** Check that this editor can show and keep everything in a document. */
	function check(content: DocumentContent): DocNode {
		const source =
			content.richText ??
			(content.blocks.length === 0 && !content.file
				? { type: "doc" as const, content: [] }
				: undefined);
		if (!source)
			throw new Error(
				"This older document cannot be edited here yet. Open it from its workspace; the saved content has not changed.",
			);
		const { nodes, marks } = editor!.schema;
		const known = (
			part: { type: string; attrs?: Record<string, unknown> },
			types: Record<string, { spec: { attrs?: object } }>,
		) => {
			const type = types[part.type];
			if (
				!type ||
				Object.keys(part.attrs ?? {}).some(
					(key) => !(key in (type.spec.attrs ?? {})),
				)
			)
				throw new Error(
					"This document uses formatting this editor cannot preserve. Its saved content has not changed.",
				);
		};
		const validate = (list: OsRichTextNode[]) => {
			for (const node of list) {
				known(node, nodes);
				for (const mark of node.marks ?? []) known(mark, marks);
				if (node.content) validate(node.content);
			}
		};
		validate(source.content);
		const node = editor!.schema.nodeFromJSON(
			source.content.length
				? source
				: { type: "doc" as const, content: [{ type: "paragraph" }] },
		);
		node.check();
		return node;
	}
	/**
	 * Put a document on screen by changing only the part that differs, as one
	 * step that undo skips. The caret, the selection and the text in view stay
	 * where they are.
	 */
	function show(next: DocNode) {
		const { state, view } = editor!,
			before = state.doc.content;
		const start = before.findDiffStart(next.content);
		if (start === null) return;
		let { a, b } = before.findDiffEnd(next.content)!;
		const overlap = start - Math.min(a, b);
		if (overlap > 0) {
			a += overlap;
			b += overlap;
		}
		const quiet = <T extends { setMeta(key: string, value: unknown): T }>(
			step: T,
		) => step.setMeta("addToHistory", false).setMeta("preventUpdate", true);
		let anchor = state.selection.head,
			top: number | undefined;
		try {
			const box = page.getBoundingClientRect();
			anchor =
				view.posAtCoords({ left: box.left + box.width / 2, top: 80 })?.pos ??
				anchor;
			// Text that is itself being replaced cannot hold the view in place.
			if (anchor < start || anchor > a) top = view.coordsAtPos(anchor).top;
		} catch {
			// Nothing is laid out yet, so there is no position to keep.
		}
		try {
			const step = quiet(state.tr.replace(start, a, next.slice(start, b)));
			anchor = step.mapping.map(anchor);
			view.dispatch(step);
		} catch {
			quiet(
				editor!.chain().setContent(next.toJSON(), { emitUpdate: false }),
			).run();
			top = undefined;
		}
		try {
			if (top !== undefined) scrollBy(0, view.coordsAtPos(anchor).top - top);
		} catch {
			// As above.
		}
		controls();
	}

	function retain() {
		clearTimeout(draftTimer);
		if (!loaded || !editor || !dirty || !editable || destroyed) return;
		// The plain-block copy is rebuilt on save; a kept draft only needs the text.
		void bridge
			.call("app.draft.write", {
				...draftArgs(),
				revision: basis,
				content: {
					...draft!,
					richText: editor.getJSON() as OsRichTextDocument,
				},
			})
			.catch(() => undefined);
	}
	function schedule() {
		clearTimeout(saveTimer);
		if (theirs || destroyed) return;
		saveTimer = setTimeout(
			() => void save(false),
			Math.max(0, Math.min(SAVE_IDLE_MS, since + SAVE_MAX_MS - Date.now())),
		);
	}
	function changed() {
		if (!loaded || !available) return;
		if (!dirty) since = Date.now();
		dirty = true;
		schedule();
		clearTimeout(draftTimer);
		draftTimer = setTimeout(retain, 1000);
	}
	function ask() {
		clearTimeout(saveTimer);
		say(
			"Someone else changed the same part. Which version should stay?",
			false,
			[
				["Keep mine", () => void sync("mine")],
				["Use theirs", () => void sync("theirs")],
			],
		);
	}
	/**
	 * Bring a newer saved copy into the editor. Changes to different parts
	 * are both kept; a choice is asked for only where the same part changed.
	 * A draft restored from an older copy has nothing to compare against, so
	 * it is kept or replaced as a whole.
	 */
	function absorb(latest: Saved, prefer?: OutputMergePreference) {
		const saved = latest.revision.content;
		let content = saved;
		if (dirty) {
			const mine = snapshot();
			// Compare documents the way this editor writes them.
			const normal = (value: DocumentContent): DocumentContent =>
				value.richText
					? {
							...value,
							richText: check(value).toJSON() as OsRichTextDocument,
						}
					: value;
			const result =
				basis !== loaded!.revision.revision
					? prefer
						? { ok: true as const, content: prefer === "mine" ? mine : saved }
						: { ok: false as const }
					: mergeOutputContent(
							normal(loaded!.revision.content),
							mine,
							normal(saved),
							{ prefer, documentBlocks: blocksFromRichText },
						);
			if (!result.ok) {
				theirs = latest;
				return ask();
			}
			content = result.content as DocumentContent;
		}
		const next = check(content);
		dirty &&= !next.eq(check(saved));
		if (theirs) say();
		theirs = undefined;
		loaded = latest;
		basis = latest.revision.revision;
		draft = content;
		show(next);
		if (dirty) {
			since = Date.now();
			schedule();
			retain();
		} else {
			clearTimeout(saveTimer);
			clearDraft();
		}
	}
	/** Stop showing a document this person may no longer read. */
	function close(error: unknown) {
		available = false;
		page.hidden = true;
		editor?.setEditable(false, false);
		clearTimeout(saveTimer);
		say(reason(error, "Document access is unavailable"), true, [
			["Try again", () => void queue(load)],
		]);
		clearDraft();
		controls();
	}
	/** Fetch the latest saved copy in the background and fold it in. */
	async function refresh(prefer?: OutputMergePreference): Promise<boolean> {
		if (!loaded || !editor || !available || destroyed) return false;
		try {
			let latest = parse(await read());
			if (destroyed) return false;
			if (latest.revision.revision <= loaded.revision.revision) {
				if (theirs) latest = theirs;
				// A draft restored from an older copy still has to be settled.
				else if (!dirty || basis === loaded.revision.revision) return false;
			}
			absorb(latest, prefer);
		} catch (error) {
			if (dirty) throw error;
			close(error);
		}
		return true;
	}
	const sync = (prefer?: OutputMergePreference) =>
		queue(() => refresh(prefer)).catch((error) =>
			say(
				`${reason(error, "The newer version could not be loaded")}. Your changes are kept here.`,
				true,
			),
		);
	async function load() {
		try {
			const value = parse(await read());
			if (destroyed) return;
			loaded = value;
			theirs = undefined;
			const retained = editable
				? await bridge.call<Draft | null>("app.draft.read", draftArgs())
				: null;
			if (destroyed) return;
			if (
				retained &&
				(retained.content.kind !== "document" ||
					!Number.isInteger(retained.revision) ||
					retained.revision < 1)
			)
				throw new Error("The retained draft is invalid");
			if (!editor) {
				editor = createDocEngine({
					element: page,
					editable,
					onUpdate: changed,
				});
				editor.on("transaction", controls);
			}
			const content = structuredClone(
				retained?.content ?? value.revision.content,
			);
			show(check(content));
			basis = retained?.revision ?? value.revision.revision;
			draft = content;
			dirty = !!retained;
			failed = false;
			available = true;
			page.hidden = false;
			say(dirty ? "Restored your unsaved changes" : "", false, [], true);
			if (dirty) {
				since = Date.now();
				schedule();
			}
		} catch (error) {
			close(error);
		} finally {
			get(".doc-skel")?.remove();
			paint();
		}
	}
	async function write(asked: boolean, again = true): Promise<void> {
		clearTimeout(saveTimer);
		if (
			!loaded ||
			!editor ||
			!dirty ||
			!editable ||
			!available ||
			theirs ||
			destroyed
		)
			return;
		const sent = editor.state.doc,
			content = snapshot();
		let slow = false;
		const timer = setTimeout(() => {
			slow = true;
			say("Saving…");
		}, 1000);
		try {
			const value = parse(
				await bridge.call<Saved>("outputs.replace", {
					slot,
					content,
					expectedRevision: basis,
				}),
			);
			if (destroyed) return;
			// Typing carried on while this was saving: the screen is not touched,
			// only the copy that later saves and merges compare against.
			const same =
				!value.revision.content.richText ||
				check(value.revision.content).eq(sent);
			basis = value.revision.revision;
			draft = content;
			loaded = same
				? value
				: { ...value, revision: { revision: basis, content } };
			dirty = editor.state.doc !== sent;
			// The saved copy also holds someone else's changes: show them.
			if (!same) absorb(value);
			else if (dirty) {
				since = Date.now();
				schedule();
			} else clearDraft();
			if (!theirs) say(asked || failed || slow ? "Saved" : "", false, [], true);
			failed = false;
		} catch (error) {
			if (destroyed) return;
			since = Date.now();
			// A save refused because someone else saved first: bring theirs in.
			if (await refresh().catch(() => false)) {
				if (again && dirty && !theirs) await write(asked, false);
				return;
			}
			failed = true;
			// A refusal that would repeat has no "Try again"; the next change does.
			const lasting = lastingSaveFailure(error);
			say(
				lasting ||
					`${reason(error, "Saving failed")}. Your changes are kept here.`,
				true,
				lasting ? [] : [["Try again", () => void save()]],
			);
		} finally {
			clearTimeout(timer);
		}
	}
	/** Save now. Edits made while a save is running are saved right after it. */
	function save(asked = true): Promise<void> {
		return (waiting ??= queue(() => {
			waiting = undefined;
			return write(asked);
		}));
	}

	const mac = /Mac|iP(hone|ad)/.test(navigator.platform);
	const keys = (key: string, shift = false) =>
		mac
			? ` ⌘${shift ? "⇧" : ""}${key}`
			: ` Ctrl+${shift ? "Shift+" : ""}${key}`;
	function button(
		target: HTMLElement,
		label: string,
		icon: EditorIcon | undefined,
		action: () => unknown,
		active?: () => boolean,
		can?: () => boolean,
	) {
		const node = document.createElement("button");
		node.type = "button";
		if (icon) {
			node.innerHTML = editorIcon(icon);
			node.title = label;
			node.setAttribute("aria-label", label);
		} else node.textContent = label;
		node.onmousedown = (event) => event.preventDefault();
		node.onclick = () => {
			action();
			controls();
		};
		target.append(node);
		buttons.push({ node, active, can });
		return node;
	}
	const divider = (target: HTMLElement = toolbar) => {
		const line = document.createElement(target === menu ? "hr" : "span");
		line.className = "doc-sep";
		line.setAttribute("aria-hidden", "true");
		target.append(line);
	};
	const run = () => editor!.chain().focus();

	function place(card: HTMLElement, left: number, top: number) {
		card.hidden = false;
		card.style.left = `${Math.max(8, Math.min(left, innerWidth - card.offsetWidth - 8))}px`;
		card.style.top = `${Math.max(8, Math.min(top, innerHeight - card.offsetHeight - 8))}px`;
	}
	function openLink() {
		if (!editor?.isEditable) return;
		linkInput.value = String(editor.getAttributes("link").href ?? "");
		let left = 16,
			top = 52;
		try {
			const box = editor.view.coordsAtPos(editor.state.selection.from);
			left = box.left;
			top = box.bottom + 8;
		} catch {
			// No layout to measure: open under the toolbar.
		}
		place(linkForm, left, top);
		linkInput.select();
	}
	function closePopups(focus = false) {
		if (focus && !(linkForm.hidden && menu.hidden)) editor?.commands.focus();
		linkForm.hidden = menu.hidden = true;
	}
	async function addImage(file: File) {
		if (!editor?.isEditable) return;
		try {
			if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw 0;
			let src = "";
			if (file.size <= 32_000)
				src = await new Promise<string>((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = () => resolve(String(reader.result));
					reader.onerror = reject;
					reader.readAsDataURL(file);
				});
			else {
				// Large pictures are scaled down so the document stays quick to save.
				const picture = await createImageBitmap(file);
				let scale = Math.min(1, 1200 / Math.max(picture.width, picture.height));
				do {
					const canvas = document.createElement("canvas"),
						pen = canvas.getContext("2d")!;
					canvas.width = Math.round(picture.width * scale);
					canvas.height = Math.round(picture.height * scale);
					pen.fillStyle = "#fff";
					pen.fillRect(0, 0, canvas.width, canvas.height);
					pen.drawImage(picture, 0, 0, canvas.width, canvas.height);
					src = canvas.toDataURL("image/jpeg", 0.8);
					scale *= 0.75;
				} while (src.length > 200_000 && scale > 0.05);
			}
			if (!destroyed && editor.isEditable)
				run().setImage({ src, alt: file.name }).run();
		} catch {
			say("Use a PNG, JPEG, GIF or WebP image.", true);
		}
	}
	async function exportAs(format: string, name: string) {
		if (!loaded || !available) return;
		await save(false);
		if (destroyed) return;
		try {
			if (format === "md") {
				const result = await call<{ text: string; title: string }>(
					"exportMarkdown",
				);
				await bridge.call("app.download", {
					filename:
						(result.title || "Document").replace(/[\\/:*?"<>|]/g, "_") + ".md",
					mimeType: "text/markdown",
					text: result.text,
				});
			} else
				await bridge.call("app.exportOutput", {
					slot,
					format,
					expectedRevision: loaded.revision.revision,
				});
			say(
				`Exported as ${name}.${format === "md" ? " Markdown keeps the text and structure, not the styling." : ""}${dirty ? " Your newest changes are not in it yet." : ""}`,
			);
		} catch (error) {
			say(reason(error, "Export failed"), true);
		}
	}

	if (editable) {
		button(
			toolbar,
			"Undo" + keys("Z"),
			"undo",
			() => run().undo().run(),
			undefined,
			() => editor!.can().undo(),
		);
		button(
			toolbar,
			"Redo" + keys("Z", true),
			"redo",
			() => run().redo().run(),
			undefined,
			() => editor!.can().redo(),
		);
		divider();
		const styles = (blockStyle = document.createElement("select"));
		styles.setAttribute("aria-label", "Block style");
		for (const [value, text] of [
			["paragraph", "Text"],
			["title", "Title"],
			["1", "Heading 1"],
			["2", "Heading 2"],
			["3", "Heading 3"],
			["quote", "Quote"],
			["code", "Code block"],
		]) {
			const option = document.createElement("option");
			option.value = value!;
			option.textContent = text!;
			styles.append(option);
		}
		styles.onchange = () => {
			if (editor)
				applyDocumentStyle(
					editor,
					styles.value as Parameters<typeof applyDocumentStyle>[1],
				);
		};
		toolbar.append(styles);
		divider();
		for (const [name, label, icon] of [
			["bold", "Bold" + keys("B"), "bold"],
			["italic", "Italic" + keys("I"), "italic"],
			["underline", "Underline" + keys("U"), "underline"],
			["strike", "Strikethrough" + keys("S", true), "strike"],
			["code", "Code" + keys("E"), "code"],
		] as const)
			button(
				toolbar,
				label,
				icon,
				() => run().toggleMark(name).run(),
				() => editor!.isActive(name),
			);
		divider();
		for (const [name, label, icon] of [
			["bulletList", "Bulleted list" + keys("8", true), "bullets"],
			["orderedList", "Numbered list" + keys("7", true), "numbers"],
			["taskList", "To-do list" + keys("9", true), "todo"],
		] as const)
			button(
				toolbar,
				label,
				icon,
				() =>
					run()
						.toggleList(name, name === "taskList" ? "taskItem" : "listItem")
						.run(),
				() => editor!.isActive(name),
			);
		divider();
		button(toolbar, "Link" + keys("K"), "link", openLink, () =>
			editor!.isActive("link"),
		);
		button(toolbar, "Image", "image", () => imageInput.click());
		button(toolbar, "Table", "table", () =>
			run().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
		);
		const table = (tableTools = document.createElement("span"));
		table.className = "doc-table";
		table.hidden = true;
		toolbar.append(table);
		divider(table);
		button(table, "Add row below", "addRow", () => run().addRowAfter().run());
		button(table, "Add column to the right", "addColumn", () =>
			run().addColumnAfter().run(),
		);
		button(table, "Delete table", "trash", () => run().deleteTable().run());
		const row = document.createElement("div");
		row.setAttribute("role", "group");
		menu.append(row);
		for (const [align, icon] of [
			["left", "alignLeft"],
			["center", "alignCenter"],
			["right", "alignRight"],
			["justify", "alignJustify"],
		] as const)
			button(
				row,
				`Align ${align}`,
				icon,
				() => run().setTextAlign(align).run(),
				() => editor!.isActive({ textAlign: align }),
			);
		divider(menu);
		button(menu, "Note", undefined, () =>
			run()
				.insertContent({ type: "callout", content: [{ type: "paragraph" }] })
				.run(),
		);
		button(menu, "Collapsible section", undefined, () =>
			run()
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
		button(menu, "Divider", undefined, () => run().setHorizontalRule().run());
		divider(menu);
	} else {
		const note = document.createElement("span");
		note.className = "doc-readonly";
		note.textContent = "Read only";
		toolbar.append(note);
	}
	for (const [format, name] of [
		["md", "Markdown"],
		["docx", "Word"],
		["pdf", "PDF"],
		["html", "HTML"],
		["png", "PNG"],
	] as const)
		button(menu, `Export as ${name}`, undefined, () => exportAs(format, name));
	// Exporting and the menu itself also work for someone who can only read.
	buttons.splice(-5);
	for (const node of menu.querySelectorAll("button"))
		node.setAttribute("role", "menuitem");
	const more = button(toolbar, "More", "more", () => {
		const open = menu.hidden;
		closePopups();
		if (!open) return;
		const box = more.getBoundingClientRect();
		menu.hidden = false;
		place(menu, box.right - menu.offsetWidth, box.bottom + 4);
	});
	buttons.pop();
	more.className = "doc-more";
	more.setAttribute("aria-haspopup", "menu");
	// Opened from the keyboard: carry on with the keyboard.
	more.addEventListener("click", (event) => {
		if (!event.detail && !menu.hidden) menu.querySelector("button")?.focus();
	});
	menu.onclick = () => closePopups();
	menu.onkeydown = (event) => {
		const items = [...menu.querySelectorAll("button")],
			step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
		if (!step) return;
		event.preventDefault();
		items[
			(items.indexOf(document.activeElement as HTMLButtonElement) +
				step +
				items.length) %
				items.length
		]!.focus();
	};

	linkForm.onsubmit = (event) => {
		event.preventDefault();
		if (!editor?.isEditable) return;
		let href = linkInput.value.trim();
		const chain = run().extendMarkRange("link");
		if (!href) chain.unsetLink().run();
		else {
			if (!/^(https?:|mailto:)/i.test(href))
				href = (/^[^/\s]+@[^/\s]+$/.test(href) ? "mailto:" : "https://") + href;
			if (editor.state.selection.empty && !editor.isActive("link"))
				chain.insertContent({
					type: "text",
					text: href,
					marks: [{ type: "link", attrs: { href } }],
				});
			else chain.setLink({ href });
			chain.run();
		}
		closePopups();
	};
	// Pressing Apply must not take focus from the field and close the card.
	get(".doc-link button").onmousedown = (event) => event.preventDefault();
	linkForm.addEventListener("focusout", (event) => {
		if (!linkForm.contains(event.relatedTarget as Node | null))
			linkForm.hidden = true;
	});
	imageInput.onchange = () => {
		const file = imageInput.files?.[0];
		imageInput.value = "";
		if (file) void addImage(file);
	};
	const dropped = (event: ClipboardEvent | DragEvent) => {
		const data =
			"clipboardData" in event ? event.clipboardData : event.dataTransfer;
		const file = [...(data?.files ?? [])].find((item) =>
			item.type.startsWith("image/"),
		);
		if (!file || !editor?.isEditable) return;
		event.preventDefault();
		event.stopPropagation();
		if ("clientX" in event) {
			const at = editor.view.posAtCoords({
				left: event.clientX,
				top: event.clientY,
			});
			if (at) editor.commands.setTextSelection(at.pos);
		}
		void addImage(file);
	};
	page.addEventListener("paste", dropped, true);
	page.addEventListener("drop", dropped, true);

	const beforeUnload = (event: BeforeUnloadEvent) => {
		if (dirty) {
			event.preventDefault();
			event.returnValue = "";
		}
	};
	const keydown = (event: KeyboardEvent) => {
		const key = event.key.toLowerCase(),
			mod = event.metaKey || event.ctrlKey;
		if (key === "escape") {
			if (linkForm.hidden && menu.hidden) return;
			closePopups(true);
		} else if (mod && key === "s") void save();
		else if (mod && key === "k") openLink();
		else if (
			editor &&
			event.altKey &&
			event.shiftKey &&
			(key === "arrowup" || key === "arrowdown")
		)
			moveDocumentBlock(editor, key === "arrowup" ? -1 : 1);
		else return;
		event.preventDefault();
	};
	const pointerdown = (event: Event) => {
		const target = event.target as Node;
		if (!menu.contains(target) && !more.contains(target)) menu.hidden = true;
	};
	const flush = (event: Event) => {
		if (
			dirty &&
			(event.type === "pagehide" || document.visibilityState === "hidden")
		) {
			retain();
			void save(false);
		}
	};
	const onScroll = () => toolbar.toggleAttribute("data-scrolled", scrollY > 2);
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
				Number.isInteger(output.revision) &&
				output.revision > loaded.revision.revision
			)
				return void sync();
	};
	window.addEventListener("message", onMessage);
	window.addEventListener("beforeunload", beforeUnload);
	window.addEventListener("pagehide", flush);
	window.addEventListener("scroll", onScroll, { passive: true });
	document.addEventListener("visibilitychange", flush);
	document.addEventListener("pointerdown", pointerdown);
	root.addEventListener("keydown", keydown, true);
	paint();
	await queue(load);
	return {
		get editor() {
			return editor;
		},
		get dirty() {
			return dirty;
		},
		save,
		destroy() {
			destroyed = true;
			for (const timer of [saveTimer, draftTimer, statusTimer])
				clearTimeout(timer);
			cancelAnimationFrame(frame);
			editor?.destroy();
			style.remove();
			window.removeEventListener("message", onMessage);
			window.removeEventListener("beforeunload", beforeUnload);
			window.removeEventListener("pagehide", flush);
			window.removeEventListener("scroll", onScroll);
			document.removeEventListener("visibilitychange", flush);
			document.removeEventListener("pointerdown", pointerdown);
			root.removeEventListener("keydown", keydown, true);
		},
	};
}
