import {
	createDocEngine,
	landedRanges,
	showLanded,
	retryLinkedImages,
	blocksFromRichText,
	moveDocumentBlock,
	applyDocumentStyle,
	currentDocumentStyle,
	type Editor,
} from "./doc-engine";
import { TextSelection } from "@tiptap/pm/state";
import {
	blockSelection,
	blockSelectionKey,
	blockSelectionPlugin,
	blocks,
	clearBlockSelection,
	deleteUnit,
	duplicateUnit,
	documentHeadings,
	moveUnit,
	setBlockSelection,
	unitAt,
	type Unit,
} from "./doc-blocks";
import { duplicateDocumentBlock } from "@/lib/document-formatting";
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
import { createOutputSync } from "../lib/output-sync";
import { fileToStoredImage } from "../lib/image-downscale";
import { richTextToMarkdown } from "../lib/rich-text-markdown";
import {
	createLandedChanges,
	landedDelay,
	savedByAgent,
	watchForInput,
	LANDED_SHOWN_MS,
	LANDED_UNDO_MS,
} from "../lib/landed-changes";

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

/**
 * A save sends only the changed blocks, so it follows a short pause in typing
 * and never waits long while someone keeps typing. A failed save that may
 * pass is tried again quickly at first, then less and less often, and is
 * mentioned only once it has kept failing for a while.
 */
const SAVE_IDLE_MS = 220,
	SAVE_MAX_MS = 1200,
	SAVE_RETRY_MS = 40,
	SAVE_RETRY_MAX_MS = 10_000,
	SAVE_QUIET_RETRIES = 8;

/**
 * The palette: each color's text and highlight shade; Default clears.
 * Highlight's Default clears the current highlight.
 */
const PALETTE: [name: string, text: string, highlight: string][] = [
	["Default", "", ""],
	["Gray", "#787774", "#ebebe9"],
	["Brown", "#9f6b53", "#f1e5df"],
	["Orange", "#d9730d", "#fbe4cf"],
	["Yellow", "#b7891c", "#fbefc4"],
	["Green", "#448361", "#ddede3"],
	["Blue", "#337ea9", "#dbeaf5"],
	["Purple", "#9065b0", "#ebe3f3"],
	["Pink", "#c14c8a", "#f6dfeb"],
	["Red", "#d44c47", "#fadedc"],
];
/** What ⌘⇧H highlights with. */
const DEFAULT_HIGHLIGHT = "#fbefc4";
const css = `:root{--ease:cubic-bezier(.2,.8,.2,1);--fg:var(--tedix-fg,CanvasText);--bg:var(--tedix-bg,Canvas);--pri:var(--tedix-primary,Highlight);--mut:var(--tedix-muted-fg,GrayText);--hov:color-mix(in srgb,var(--fg) 5.5%,var(--bg));--act:color-mix(in srgb,var(--fg) 8.5%,var(--bg));--line:color-mix(in srgb,var(--fg) 8%,transparent);--edge:color-mix(in srgb,var(--fg) 15%,transparent);--card:var(--tedix-surface,var(--bg));font:14px var(--tedix-font,system-ui,sans-serif);color:var(--fg);scrollbar-width:thin;scrollbar-color:var(--edge) transparent}*{box-sizing:border-box}body{margin:0;padding:0!important;background:var(--bg)}button,input,select{font:inherit;color:inherit}[hidden]{display:none!important}:focus-visible{outline:2px solid var(--pri);outline-offset:1px}.doc-toolbar{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:2px;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;padding:6px 26px 6px 10px;background:var(--bg);border-bottom:1px solid transparent;transition:border-color .12s}.doc-toolbar[data-scrolled]{border-color:var(--line)}.doc-toolbar>*{flex:none}.doc-table{display:contents}.doc-toolbar button,.doc-toolbar select,.doc-menu button,.doc-status button{height:29px;min-width:29px;display:inline-grid;place-items:center;padding:0 6px;border:0;border-radius:6px;background:none;cursor:pointer;transition:background .12s var(--ease),transform .12s var(--ease)}:is(button,select):hover:not(:disabled){background:var(--hov)}button:active:not(:disabled){background:var(--act);transform:scale(.94)}:is(button,select):disabled{opacity:.38;cursor:default}button[aria-pressed=true]{background:var(--act);color:var(--pri)}.doc-sep{flex:none;width:1px;height:16px;margin:0 5px;background:var(--edge)}.doc-readonly{padding:0 8px;font-size:12px;color:var(--mut)}.doc-toolbar .doc-more{margin-left:auto;position:sticky;right:0;background:var(--bg)}.doc-page{max-width:calc(700px + 2*clamp(20px,5.5vw,52px));margin:0 auto;padding:22px clamp(20px,5.5vw,52px) min(40vh,300px)}.doc-skel{animation:doc-fade .3s .25s both}.doc-skel i{display:block;height:12px;margin-bottom:15px;border-radius:6px;background:var(--act)}.doc-skel i:first-child{width:45%;height:26px;margin-bottom:24px}.doc-skel i:last-child{width:60%}@keyframes doc-fade{from{opacity:0}}@keyframes doc-in{from{opacity:0;transform:scale(.96)}}.doc-status,.doc-link,.doc-menu{position:fixed;background:var(--card);border:1px solid var(--edge);box-shadow:0 6px 22px #0002;animation:doc-in .16s var(--ease)}.doc-status{top:48px;right:12px;z-index:4;max-width:min(380px,calc(100% - 24px));display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;padding:5px 11px;border-radius:14px;font-size:12px;line-height:1.45;color:var(--mut)}.doc-status:empty{display:none}.doc-save{position:fixed;top:18px;right:12px;z-index:4;width:7px;height:7px;border-radius:50%;background:var(--mut)}.doc-save[data-s="1"]{background:#1a7f37}.doc-save[data-s="2"]{background:#c0262d}.doc-status[data-error=true]{color:var(--tedix-danger,#c0262d)}.doc-status button{height:24px;color:var(--fg);background:var(--hov)}.doc-link,.doc-menu{z-index:5;padding:5px;border-radius:10px;transform-origin:0 0}.doc-link{display:flex;gap:4px}.doc-link input{width:min(250px,60vw);height:29px;padding:0 8px;border:0;border-radius:6px;background:var(--hov)}.doc-link button{height:29px;padding:0 10px;border:0;border-radius:6px;background:var(--pri);color:var(--tedix-on-primary,HighlightText);cursor:pointer}.doc-menu{display:grid;min-width:180px}.doc-menu button{justify-content:start;padding:0 9px}.doc-menu div{display:flex;gap:2px}.doc-slash{width:272px;max-height:min(320px,60vh);overflow-y:auto}.doc-slash button{display:flex;gap:10px;align-items:center;height:auto!important;padding:5px 8px!important}.doc-tile{flex:none;display:grid;place-items:center;width:30px;height:30px;border-radius:7px;background:var(--bg);box-shadow:inset 0 0 0 1px var(--line);color:color-mix(in srgb,var(--fg) 72%,transparent);font-size:12px;font-weight:600}.doc-mi{flex:1}.doc-md{font:11.5px var(--tedix-font-mono,ui-monospace,monospace);color:var(--mut)}.doc-mempty{padding:10px;color:var(--mut)}.doc-table-grid{display:grid!important;grid-template-columns:repeat(8,16px);gap:3px;padding:6px;outline:0}.doc-table-grid i{width:16px;height:16px;border-radius:3px;box-shadow:inset 0 0 0 1px var(--edge);cursor:pointer}.doc-table-grid i.on{background:color-mix(in srgb,var(--pri) 22%,transparent);box-shadow:inset 0 0 0 1px var(--pri)}.doc-table-picker p{margin:2px 6px;font-size:12px;color:var(--mut);text-align:center}.doc-table-picker .doc-table-title{font-weight:550;text-align:left}.doc-table-pill{position:absolute;z-index:2;display:grid;place-items:center;padding:0;border:1px solid var(--edge);border-radius:6px;background:var(--card);color:var(--mut);font-size:11px;line-height:1;cursor:pointer}.doc-table-pill.col{width:24px;height:12px}.doc-table-pill.row{width:12px;height:24px}.doc-table-pill:hover{color:var(--fg);border-color:var(--pri)}.doc-table-add{position:absolute;z-index:1;display:grid;place-items:center;padding:0;border:0;border-radius:4px;background:var(--hov);color:var(--mut);opacity:0;transition:opacity .12s;cursor:pointer}.doc-table-add.row{height:14px}.doc-table-add.col{width:14px}.doc-table-add:hover{opacity:1;color:var(--fg)}.doc-table-menu .doc-danger{color:#c0262d}.doc-gutter{position:absolute;z-index:2;display:flex;gap:1px;opacity:0;transition:opacity .14s}.doc-gutter.on{opacity:1}.doc-gutter button{display:grid;place-items:center;width:22px;height:24px;padding:0;border:0;border-radius:5px;background:none;color:color-mix(in srgb,var(--fg) 35%,transparent);cursor:pointer}.doc-gutter .doc-handle{width:18px;cursor:grab}.doc-gutter button:hover{background:var(--hov);color:var(--fg)}.doc-grip-hover{background:color-mix(in srgb,var(--pri) 6%,transparent);border-radius:6px}.doc-drop{position:absolute;z-index:2;height:2px;border-radius:1px;background:var(--pri);pointer-events:none}.doc-drop:before{content:"";position:absolute;left:-8px;top:-3px;width:8px;height:8px;border-radius:50%;box-sizing:border-box;border:2px solid var(--pri);background:var(--bg)}.doc-ghost{position:fixed;z-index:6;max-height:240px;overflow:hidden;padding:4px 10px;border-radius:10px;background:var(--card);box-shadow:0 10px 30px #0003;opacity:.96;pointer-events:none;-webkit-mask-image:linear-gradient(#000 80%,transparent);mask-image:linear-gradient(#000 80%,transparent)}.doc-ghost>*{margin:0!important}.doc-ghost-count{position:absolute;top:6px;right:8px;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:var(--pri);color:var(--tedix-on-primary,HighlightText);font-size:11px;line-height:20px;text-align:center}.doc-dragging{opacity:.28;transition:opacity .16s}.doc-block-selected{background:color-mix(in srgb,var(--pri) 12%,transparent);border-radius:6px}.doc-block-menu{width:252px}.doc-block-menu p{margin:4px 9px 2px;font-size:11px;color:var(--mut)}.doc-turn{display:grid!important;grid-template-columns:repeat(5,1fr);gap:4px;padding:4px}.doc-turn button{height:36px!important;justify-content:center!important;font-size:12px;font-weight:600;box-shadow:inset 0 0 0 1px var(--line)}.doc-turn button[aria-current=true]{color:var(--pri);box-shadow:inset 0 0 0 1.5px var(--pri)}.doc-block-menu button:not(.doc-turn button){display:flex!important;justify-content:space-between!important;gap:12px}.doc-block-menu kbd{font:inherit;font-size:11.5px;color:var(--mut)}.doc-block-menu .doc-danger:hover{background:color-mix(in srgb,#c0262d 12%,transparent);color:#c0262d}.doc-colors{width:248px;padding:4px 8px 10px}.doc-colors p{margin:0;padding:7px 2px 5px;font-size:11.5px;font-weight:550;color:var(--mut)}.doc-swatches{display:grid!important;grid-template-columns:repeat(5,1fr);gap:6px;padding:0 2px}.doc-menu .doc-swatch{aspect-ratio:1;width:auto;height:auto!important;min-width:0;padding:0;border:0;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:620;font-size:14px;background:var(--bg);box-shadow:inset 0 0 0 1px var(--line);transition:transform .12s var(--ease),box-shadow .12s var(--ease)}.doc-menu .doc-swatch:hover{transform:scale(1.07)}.doc-menu .doc-swatch.on{box-shadow:inset 0 0 0 1px var(--line),0 0 0 2px var(--card),0 0 0 3.5px var(--pri)}.doc-menu .doc-swatch.none{background:linear-gradient(135deg,transparent calc(50% - .75px),var(--mut) calc(50% - .75px),var(--mut) calc(50% + .75px),transparent calc(50% + .75px)),var(--bg)}.doc-paint{position:relative;display:grid;place-items:center;width:22px;height:22px}.doc-paint svg{position:relative}.doc-paint-fill{position:absolute;inset:2px 1px;border-radius:5px;background:var(--paint-fill,transparent)}.doc-paint-bar{position:absolute;left:4px;right:4px;bottom:1px;height:2.5px;border-radius:2px;background:var(--paint-text,transparent)}.doc-keys{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(12,12,16,.28);backdrop-filter:blur(3px)}.doc-sheet{width:min(620px,100%);max-height:min(78vh,680px);overflow-y:auto;padding:22px 24px 18px;background:var(--card);border-radius:14px;box-shadow:0 12px 40px #0003}.doc-sheet h2{margin:0 0 4px;font-size:15px;font-weight:620}.doc-sheet .doc-sub{margin:0 0 16px;color:var(--mut);font-size:12.5px}.doc-sheet-cols{display:grid;grid-template-columns:1fr 1fr;gap:0 32px}@media(max-width:580px){.doc-sheet-cols{grid-template-columns:1fr}}.doc-sheet h3{margin:14px 0 4px;font-size:11.5px;font-weight:550;color:var(--mut)}.doc-krow{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:32px;border-bottom:1px solid var(--line);font-size:13px;line-height:20px}.doc-krow:last-child{border-bottom:0}.doc-chips{display:flex;gap:4px;flex:none}.doc-chip{display:inline-flex;align-items:center;justify-content:center;height:22px;min-width:22px;padding:0 6px;border-radius:6px;background:var(--hov);box-shadow:inset 0 -1px 0 var(--edge);font-size:12px}.doc-chip.md{font:11.5px var(--tedix-font-mono,ui-monospace,monospace)}.doc-slash button[aria-selected=true]{background:var(--act)}.doc-menu hr{width:100%;height:0;border:0;border-top:1px solid var(--line);margin:4px 0}.tiptap{outline:0;font-size:16px;line-height:1.62;min-height:50vh;caret-color:var(--pri);overflow-wrap:anywhere}.tiptap>:first-child{margin-top:0}.tiptap p{margin:0 0 .8em}.tiptap h1{font-size:1.875em;line-height:1.22;font-weight:680;letter-spacing:-.024em;margin:1.3em 0 .4em}.tiptap h2{font-size:1.4em;line-height:1.3;font-weight:640;letter-spacing:-.016em;margin:1.3em 0 .35em}.tiptap h3{font-size:1.15em;line-height:1.4;font-weight:620;margin:1.2em 0 .3em}.tiptap .doc-title{font-size:2.3em;font-weight:700}.tiptap [data-hint]:before{content:attr(data-hint);float:left;height:0;pointer-events:none;color:var(--mut);opacity:.65}.tiptap blockquote{margin:0 0 .8em;padding-left:14px;border-left:2px solid var(--edge);color:color-mix(in srgb,var(--fg) 72%,transparent)}.tiptap pre{font:13px/1.55 var(--tedix-font-mono,ui-monospace,monospace);background:var(--hov);margin:0 0 1em;padding:12px 14px;border-radius:8px;white-space:pre-wrap}.tiptap code{font-family:var(--tedix-font-mono,ui-monospace,monospace);font-size:.9em}.tiptap :not(pre)>code{background:var(--act);padding:.1em .3em;border-radius:4px}.tiptap hr{border:0;border-top:1px solid var(--edge);margin:1.6em 0}.tiptap ul,.tiptap ol{margin:0 0 .8em;padding-left:1.5em}.tiptap li p{margin:0 0 .2em}.tiptap ul[data-type=taskList]{list-style:none;padding-left:0}.tiptap li[data-checked]{display:flex;gap:9px}.tiptap li[data-checked]>div{flex:1}.tiptap li[data-checked=true]>div{color:var(--mut)}.tiptap input[type=checkbox]{appearance:none;display:grid;place-content:center;width:16px;height:16px;margin:5px 0 0;border:1.5px solid color-mix(in srgb,var(--fg) 34%,transparent);border-radius:4.5px;cursor:pointer;transition:background .12s}.tiptap input:checked{background:var(--pri);border-color:var(--pri)}.tiptap input:checked:after{content:"";width:8px;height:4px;margin-top:-2px;border:solid var(--tedix-on-primary,HighlightText);border-width:0 0 2px 2px;transform:rotate(-45deg)}.tiptap table{border-collapse:separate;border-spacing:0;table-layout:fixed;width:100%;margin:0 0 1em;border:1px solid var(--edge);border-radius:8px;overflow:hidden}.tiptap th,.tiptap td{border:solid var(--line);border-width:0 1px 1px 0;min-width:60px;padding:7px 10px;position:relative;vertical-align:top;text-align:left}.tiptap :is(th,td):last-child{border-right:0}.tiptap tr:last-child>*{border-bottom:0}.tiptap th{background:color-mix(in srgb,var(--fg) 3.5%,transparent);font-weight:600}.tiptap :is(th,td) p{margin:0}.tiptap .selectedCell:after{content:"";position:absolute;inset:0;background:color-mix(in srgb,var(--pri) 12%,transparent);pointer-events:none}.tiptap .column-resize-handle{position:absolute;right:0;top:0;bottom:0;width:3px;background:var(--pri)}.tiptap img{max-width:100%;height:auto;border-radius:6px}.tiptap .ProseMirror-selectednode{outline:2px solid var(--pri)}.tiptap aside,.tiptap [data-type=details]{margin:0 0 1em;padding:11px 14px;border-radius:8px;background:var(--hov)}.tiptap [data-type=details]{display:flex;gap:6px}.tiptap [data-type=details]>button{flex:none;width:22px;height:26px;border:0;border-radius:5px;background:none;cursor:pointer}.tiptap [data-type=details]>button:before{content:"▸"}.tiptap .is-open>button:before{content:"▾"}.tiptap [data-type=details]>div{flex:1;min-width:0}.tiptap summary{list-style:none;font-weight:600}.tiptap :is(aside,[data-type=detailsContent])>:last-child{margin-bottom:0}.tiptap a{color:var(--pri);text-decoration:underline}@keyframes doc-mark{0%{background:transparent}10%,50%{background:color-mix(in srgb,var(--pri) 17%,transparent)}to{background:transparent}}@keyframes doc-wash{0%{background:transparent}20%{background:color-mix(in srgb,var(--pri) 6.5%,transparent)}to{background:transparent}}@keyframes doc-rise{from{transform:translateY(5px)}}.doc-landed-words{border-radius:3px;animation:doc-mark 1.9s var(--ease) both}.doc-landed{border-radius:7px;animation:doc-wash 1.3s var(--ease) both,doc-rise .28s var(--ease) both}@keyframes doc-tick{0%{opacity:0}15%{opacity:1}to{opacity:0}}@keyframes doc-ghost{0%{opacity:.85;filter:none;max-height:6em}to{opacity:0;filter:blur(1.5px);max-height:0}}.doc-removed{display:inline-block;width:2px;height:1.1em;margin:0 1px;vertical-align:text-bottom;border-radius:1px;background:color-mix(in srgb,var(--pri) 70%,transparent);animation:doc-tick 1.1s var(--ease) both;pointer-events:none}.doc-removed-block{display:block;overflow:hidden;white-space:pre-wrap;color:var(--mut);animation:doc-ghost .22s ease-out both;pointer-events:none}@media(prefers-reduced-motion:reduce){.doc-landed,.doc-landed-words{animation:none;background:color-mix(in srgb,var(--pri) 14%,transparent)}}@media(pointer:coarse){.doc-toolbar button,.doc-toolbar select,.doc-menu button,.doc-link input,.doc-link button{height:44px;min-width:44px}.doc-save{top:25px}.doc-status{top:62px}}`;

const featureCss = `
.doc-page{transition:max-width .32s var(--ease)}
.doc-page[data-typeface=sans] .tiptap{font-family:var(--tedix-font,system-ui,sans-serif);font-size:16px;line-height:1.65}
.doc-page[data-typeface=serif] .tiptap{font-family:ui-serif,Georgia,Cambria,"Times New Roman",serif;font-size:18px;line-height:1.6}
.doc-page[data-typeface=mono] .tiptap{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14.5px;line-height:1.7}
.doc-page[data-wide=true]{max-width:calc(980px + 2*clamp(20px,5.5vw,52px))}
.doc-toolbar .doc-more{margin-left:0;position:static}.doc-toolbar .doc-appearance-button{margin-left:auto;position:sticky;right:0;background:var(--bg);font-weight:650;letter-spacing:-.04em}
.doc-appearance{position:fixed;width:250px;padding:10px}.doc-appearance-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.doc-appearance-grid button{height:58px;display:flex;flex-direction:column;align-items:flex-start;justify-content:space-between;padding:9px}.doc-appearance-grid button[aria-pressed=true]{box-shadow:inset 0 0 0 1.5px var(--pri)}.doc-appearance-grid small{font-size:10px;color:var(--mut)}.doc-wide{width:100%;margin-top:8px;display:flex!important;grid-template-columns:1fr auto!important;justify-content:space-between!important;padding:0 9px!important}.doc-wide i{width:28px;height:16px;border-radius:9px;background:var(--edge);position:relative}.doc-wide i:after{content:"";position:absolute;width:12px;height:12px;left:2px;top:2px;border-radius:50%;background:var(--bg);transition:transform .18s var(--ease)}.doc-wide[aria-pressed=true] i{background:var(--pri)}.doc-wide[aria-pressed=true] i:after{transform:translateX(12px)}
.doc-outline{position:fixed;z-index:2;right:14px;top:50%;transform:translateY(-50%);max-height:64vh;padding:8px 0;display:flex;flex-direction:column;align-items:flex-end;overflow:auto;filter:drop-shadow(0 8px 18px transparent);transition:padding .16s var(--ease),background .16s,filter .16s;border-radius:10px}.doc-outline:hover,.doc-outline:focus-within{padding:9px;background:var(--card);filter:drop-shadow(0 8px 18px color-mix(in srgb,var(--fg) 18%,transparent))}.doc-outline button{border:0;background:none;min-height:22px;padding:0;display:flex;align-items:center;justify-content:flex-end;gap:9px;cursor:pointer;color:var(--mut)}.doc-outline i{display:block;height:2px;width:var(--dash);background:currentColor;border-radius:2px;opacity:.46;transition:opacity .14s,transform .14s}.doc-outline button[aria-current=true]{color:var(--pri)}.doc-outline button[aria-current=true] i{opacity:1;transform:scaleY(1.5)}.doc-outline span{display:none;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;line-height:1.35}.doc-outline:hover span,.doc-outline:focus-within span{display:block}.doc-outline:hover i,.doc-outline:focus-within i{order:2}
.doc-agent-caret{position:fixed;z-index:4;width:2px;min-height:8px;background:var(--pri);opacity:0;pointer-events:none;transition:left .28s var(--ease),top .28s var(--ease),height .28s var(--ease),opacity .35s}.doc-agent-caret.on{opacity:.85;transition:left .28s var(--ease),top .28s var(--ease),height .28s var(--ease),opacity .12s}
`;

export async function mountDocClient(
	root: HTMLElement,
	bridge: DocClientBridge,
) {
	const style = document.createElement("style");
	style.textContent = css + featureCss;
	document.head.append(style);
	root.innerHTML =
		'<main aria-label="Doc gadget"><div class="doc-toolbar" role="toolbar" aria-label="Document formatting"></div><i class="doc-save" role="img" hidden></i><div class="doc-status" role="status" aria-live="polite"></div><form class="doc-link" hidden><input type="text" aria-label="Link URL" placeholder="Paste or type a link"><button type="submit">Apply</button></form><div class="doc-menu" role="menu" aria-label="More" hidden></div><div class="doc-menu doc-slash" role="listbox" aria-label="Insert" hidden></div><div class="doc-menu doc-block-menu" role="menu" aria-label="Block" hidden></div><div class="doc-gutter" hidden><button type="button" class="doc-add" aria-label="Add below" title="Add a block below · ⌥-click adds one above"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg></button><button type="button" class="doc-handle" aria-label="Drag to move, or click for block options" title="Drag to move · Click for options"><svg viewBox="0 0 10 16" width="10" height="16" fill="currentColor"><circle cx="2.5" cy="3.5" r="1.3"/><circle cx="7.5" cy="3.5" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="12.5" r="1.3"/><circle cx="7.5" cy="12.5" r="1.3"/></svg></button></div><i class="doc-drop" hidden></i><div class="doc-ghost" hidden></div><div class="doc-menu doc-table-picker" role="dialog" aria-label="Insert table" hidden></div><div class="doc-menu doc-table-menu" role="menu" aria-label="Table" hidden></div><button type="button" class="doc-table-pill col" title="Column" aria-label="Column" hidden>⋯</button><button type="button" class="doc-table-pill row" title="Row" aria-label="Row" hidden>⋮</button><button type="button" class="doc-table-add row" title="Add row" aria-label="Add row" hidden>+</button><button type="button" class="doc-table-add col" title="Add column" aria-label="Add column" hidden>+</button><div class="doc-menu doc-colors" role="dialog" aria-label="Text color and highlight" hidden></div><div class="doc-keys" hidden></div><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden><section class="doc-page" aria-label="Document page"><div class="doc-skel"><i></i><i></i><i></i><i></i><i></i></div></section></main>';
	const main = root.querySelector("main")!;
	const appearanceMenu = document.createElement("div");
	appearanceMenu.className = "doc-menu doc-appearance";
	appearanceMenu.setAttribute("role", "dialog");
	appearanceMenu.setAttribute("aria-label", "Typeface & width");
	appearanceMenu.hidden = true;
	const outline = document.createElement("nav");
	outline.className = "doc-outline";
	outline.setAttribute("aria-label", "Document outline");
	outline.hidden = true;
	const agentCaret = document.createElement("i");
	agentCaret.className = "doc-agent-caret";
	agentCaret.setAttribute("aria-hidden", "true");
	main.append(appearanceMenu, outline, agentCaret);
	const get = <T extends HTMLElement>(selector: string) =>
		root.querySelector<T>(selector)!;
	const saveDot = get(".doc-save"),
		status = get(".doc-status"),
		page = get(".doc-page"),
		toolbar = get(".doc-toolbar"),
		menu = get(".doc-menu"),
		slash = get(".doc-slash"),
		colors = get(".doc-colors"),
		blockMenu = get(".doc-block-menu"),
		handle = get<HTMLButtonElement>(".doc-handle"),
		addButton = get<HTMLButtonElement>(".doc-add"),
		gutter = get(".doc-gutter"),
		ghost = get(".doc-ghost"),
		tablePicker = get(".doc-table-picker"),
		tableMenu = get(".doc-table-menu"),
		tablePills = [
			get<HTMLButtonElement>(".doc-table-pill.col"),
			get<HTMLButtonElement>(".doc-table-pill.row"),
			get<HTMLButtonElement>(".doc-table-add.row"),
			get<HTMLButtonElement>(".doc-table-add.col"),
		],
		drop = get(".doc-drop"),
		shortcuts = get(".doc-keys"),
		linkForm = get<HTMLFormElement>(".doc-link"),
		linkInput = get<HTMLInputElement>(".doc-link input"),
		imageInput = get<HTMLInputElement>("input[type=file]");
	const context = await bridge.call<Context>("context");
	const slot = context.settings?.slot;
	if (!slot || !context.workspaceId)
		throw new Error("Document slot is not configured");
	// Someone invited through a link to edit: their page saves changes but
	// cannot store a new picture or build a Word, PDF, HTML or PNG file.
	const visitor = context.role === "edit";
	const editable =
		(context.role === "owner" ||
			context.role === "build" ||
			context.role === "edit") &&
		!!context.grants?.some(
			(grant) =>
				grant.slot === slot && grant.operations.includes("outputs.write"),
		);
	// `loaded` is the saved copy the draft started from; `draft` carries the
	// parts of the document the editor does not show, such as an attached file.
	let loaded: Saved | undefined,
		draft: DocumentContent | undefined,
		editor: Editor | undefined,
		waiting: Promise<void> | undefined,
		tail: Promise<unknown> = Promise.resolve();
	let basis = 0,
		dirty = false,
		available = false,
		destroyed = false,
		failed = false,
		busy = false,
		tries = 0,
		failedWhy = "",
		since = 0,
		frame = 0,
		agentPos = -1;
	let saveTimer: ReturnType<typeof setTimeout> | undefined,
		draftTimer: typeof saveTimer,
		statusTimer: typeof saveTimer,
		landedTimer: typeof saveTimer,
		outlineTimer: typeof saveTimer,
		agentTimer: typeof saveTimer;
	// What someone else changed while the document was open here.
	const landed = createLandedChanges<DocumentContent>({
			documentBlocks: blocksFromRichText,
		}),
		input = watchForInput(window);
	let offering = false;
	// The Color button shows the text color and highlight under the caret.
	let paintButton: HTMLButtonElement | undefined;
	const buttons: {
		node: HTMLButtonElement;
		active?: () => boolean;
		can?: () => boolean;
	}[] = [];
	let blockStyle: HTMLSelectElement | undefined;

	/** Show a short status. Plain notes fade; anything with a choice stays. */
	function say(
		text = "",
		error = false,
		actions: Action[] = [],
		brief = false,
	) {
		clearTimeout(statusTimer);
		mark();
		offering = false;
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
				() => (landed.undoable ? offerUndo() : say()),
				brief ? 1300 : 7000,
			);
	}
	/** The steady save state: there is no Save button, so this always answers "is it saved?". */
	function mark() {
		const state = busy ? 0 : failed ? 2 : dirty ? 3 : 1;
		saveDot.hidden = !loaded || !editable || !available;
		saveDot.dataset.s = String(state);
		saveDot.title = [
			"Saving…",
			"All changes saved",
			"Not saved. " + failedWhy,
			"Changes not saved yet",
		][state]!;
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
	// Saves send only what changed and catching up fetches only what changed.
	const outputSync = createOutputSync<DocumentContent, Saved>(bridge, slot, {
		documentBlocks: blocksFromRichText,
	});
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
		if (paintButton && editor) {
			const text = editor.getAttributes("textStyle").color as
				| string
				| undefined;
			const highlight = editor.getAttributes("highlight").color as
				| string
				| undefined;
			paintButton.style.setProperty("--paint-text", text ?? "transparent");
			paintButton.style.setProperty("--paint-fill", highlight ?? "transparent");
		}
	}
	const controls = () => {
		frame ||= requestAnimationFrame(paint);
	};
	const appearance = () => ({
		typeface: draft?.appearance?.typeface ?? ("sans" as const),
		wide: draft?.appearance?.wide ?? false,
	});
	function showAppearance() {
		const value = appearance();
		page.dataset.typeface = value.typeface;
		page.dataset.wide = String(value.wide);
		for (const node of appearanceMenu.querySelectorAll<HTMLButtonElement>(
			"[data-typeface]",
		))
			node.setAttribute(
				"aria-pressed",
				String(node.dataset.typeface === value.typeface),
			);
		appearanceMenu
			.querySelector<HTMLButtonElement>(".doc-wide")
			?.setAttribute("aria-pressed", String(value.wide));
	}
	function updateOutlineCurrent() {
		if (outline.hidden) return;
		const threshold = toolbar.getBoundingClientRect().bottom + 40;
		let current = -1;
		for (const [index, node] of [
			...outline.querySelectorAll<HTMLButtonElement>("button"),
		].entries()) {
			const dom = editor?.view.nodeDOM(Number(node.dataset.pos));
			if (
				dom instanceof HTMLElement &&
				dom.getBoundingClientRect().top <= threshold
			)
				current = index;
		}
		for (const [index, node] of [
			...outline.querySelectorAll<HTMLButtonElement>("button"),
		].entries())
			if (index === Math.max(0, current))
				node.setAttribute("aria-current", "true");
			else node.removeAttribute("aria-current");
	}
	function rebuildOutline() {
		clearTimeout(outlineTimer);
		if (!editor || page.hidden) return (outline.hidden = true);
		const headings = documentHeadings(editor);
		const room = innerWidth - page.getBoundingClientRect().right;
		if (headings.length < 2 || room < 120) return (outline.hidden = true);
		outline.replaceChildren(
			...headings.map((heading) => {
				const node = document.createElement("button");
				node.type = "button";
				node.dataset.pos = String(heading.pos);
				node.setAttribute("aria-label", heading.label);
				const label = document.createElement("span");
				label.textContent = heading.label;
				const dash = document.createElement("i");
				dash.style.setProperty(
					"--dash",
					`${heading.level === 1 ? 16 : heading.level === 2 ? 11 : 7}px`,
				);
				node.append(label, dash);
				node.onclick = () => {
					const dom = editor?.view.nodeDOM(heading.pos);
					if (dom instanceof HTMLElement)
						dom.scrollIntoView({
							behavior: matchMedia("(prefers-reduced-motion:reduce)").matches
								? "auto"
								: "smooth",
							block: "start",
						});
				};
				return node;
			}),
		);
		outline.hidden = false;
		updateOutlineCurrent();
	}
	function scheduleOutline() {
		clearTimeout(outlineTimer);
		outlineTimer = setTimeout(rebuildOutline, 400);
	}
	function moveAgentCaret(pos: number) {
		if (!editor) return;
		agentPos = pos;
		try {
			const box = editor.view.coordsAtPos(pos);
			agentCaret.style.left = `${box.left}px`;
			agentCaret.style.top = `${box.top}px`;
			agentCaret.style.height = `${Math.max(8, box.bottom - box.top)}px`;
			agentCaret.classList.add("on");
			clearTimeout(agentTimer);
			agentTimer = setTimeout(() => agentCaret.classList.remove("on"), 1400);
		} catch {
			agentCaret.classList.remove("on");
		}
	}

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
	 * where they are. With `edit` it is the person's own change instead.
	 */
	function show(next: DocNode, edit = false) {
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
		// An edit the person asked for is theirs: it saves and can be undone.
		const quiet = <T extends { setMeta(key: string, value: unknown): T }>(
			step: T,
		) =>
			edit
				? step
				: step.setMeta("addToHistory", false).setMeta("preventUpdate", true);
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
		if (destroyed) return;
		saveTimer = setTimeout(
			() => void save(false),
			Math.max(0, Math.min(SAVE_IDLE_MS, since + SAVE_MAX_MS - Date.now())),
		);
	}
	function changed() {
		if (!loaded || !available) return;
		landed.clear();
		if (offering) say();
		if (!dirty) since = Date.now();
		dirty = true;
		mark();
		schedule();
		clearTimeout(draftTimer);
		draftTimer = setTimeout(retain, 1000);
		scheduleOutline();
	}
	/**
	 * Show what someone else's save changed on screen: each part lights up
	 * where it is, one after another, and the first comes into view when the
	 * person is only watching. An agent's change can be taken back.
	 */
	function land(before: DocNode, after: DocNode, agent: boolean) {
		const ranges = landedRanges(before, after);
		const content = (doc: DocNode): DocumentContent => ({
			...draft!,
			richText: doc.toJSON() as OsRichTextDocument,
		});
		if (!before.eq(after)) landed.add(content(before), content(after), agent);
		if (!ranges.length) return;
		showLanded(editor!, ranges);
		if (agent) moveAgentCaret(ranges[ranges.length - 1]!.to);
		clearTimeout(landedTimer);
		landedTimer = setTimeout(
			() => editor && !destroyed && showLanded(editor, []),
			LANDED_SHOWN_MS + landedDelay(ranges.length - 1, ranges.length),
		);
		if (input.watching && !dirty)
			try {
				const box = editor!.view.coordsAtPos(ranges[0]!.from);
				if (box.top < 56 || box.bottom > innerHeight - 24)
					scrollTo({
						top: scrollY + box.top - innerHeight / 3,
						behavior: matchMedia("(prefers-reduced-motion:reduce)").matches
							? "auto"
							: "smooth",
					});
			} catch {
				// Nothing is laid out yet, so there is nowhere to scroll to.
			}
		if (agent && editable) offerUndo();
	}
	function offerUndo() {
		say("An agent changed this document.", false, [
			["Undo agent change", undoLanded],
		]);
		offering = true;
		statusTimer = setTimeout(() => offering && say(), LANDED_UNDO_MS);
	}
	/**
	 * Take the agent's change set back out as an edit of the person's own: it
	 * saves as a new change and their own undo brings the agent's work back.
	 */
	function undoLanded() {
		if (!editor?.isEditable || !landed.undoable) return say();
		const before = editor.state.doc,
			content = landed.undo(snapshot());
		if (!content) return say();
		const next = check(content);
		show(next, true);
		if (!before.eq(editor.state.doc)) changed();
		showLanded(editor, landedRanges(before, next));
		clearTimeout(landedTimer);
		landedTimer = setTimeout(
			() => editor && !destroyed && showLanded(editor, []),
			LANDED_SHOWN_MS,
		);
		say("Agent change undone.", false, [], true);
	}
	/** A document as this editor writes it, so comparisons see real changes only. */
	function normalized(value: DocumentContent): DocumentContent {
		return value.richText
			? { ...value, richText: check(value).toJSON() as OsRichTextDocument }
			: value;
	}
	/**
	 * Bring a newer saved copy into the editor. Changes to different parts
	 * are both kept, down to different words of one paragraph; a choice is
	 * asked for only where the same words changed.
	 * A draft restored from an older copy is compared with that copy
	 * (`older`); only when it is no longer stored is the draft kept or
	 * replaced as a whole.
	 */
	function absorb(
		latest: Saved,
		prefer?: OutputMergePreference,
		older?: DocumentContent,
	) {
		const saved = latest.revision.content;
		let content = saved;
		if (dirty) {
			const mine = snapshot();
			const base =
				basis === loaded!.revision.revision ? loaded!.revision.content : older;
			const merge = (side: OutputMergePreference | undefined) =>
				mergeOutputContent(normalized(base!), mine, normalized(saved), {
					prefer: side,
					documentBlocks: blocksFromRichText,
				});
			// Where both changed the same words, the person's words stay, without
			// a question; with nothing older to compare against, their whole
			// unsaved version stays.
			const result = !base
				? { ok: true as const, content: prefer === "theirs" ? saved : mine }
				: merge(prefer ?? "mine");
			if (!result.ok) {
				content = mine;
			} else content = result.content as DocumentContent;
		}
		const next = check(content);
		dirty &&= !next.eq(check(saved));
		const before = editor!.state.doc;
		loaded = latest;
		basis = latest.revision.revision;
		draft = content;
		show(next);
		showAppearance();
		scheduleOutline();
		land(before, editor!.state.doc, savedByAgent(latest.revision));
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
	/** The saved copy at `revision`, or undefined when it is no longer stored. */
	async function olderCopy(
		revision: number,
	): Promise<DocumentContent | undefined> {
		try {
			const value = await bridge.call<Saved>("outputs.readRevision", {
				slot,
				revision,
			});
			return value?.revision?.revision === revision &&
				value.revision.content?.kind === "document"
				? value.revision.content
				: undefined;
		} catch {
			return undefined;
		}
	}
	/** Fetch the latest saved copy in the background and fold it in. */
	async function refresh(prefer?: OutputMergePreference): Promise<boolean> {
		if (!loaded || !editor || !available || destroyed) return false;
		try {
			const latest = parse(await outputSync.latest(read));
			if (destroyed) return false;
			// A draft restored from an older copy still has to be settled.
			if (
				latest.revision.revision <= loaded.revision.revision &&
				(!dirty || basis === loaded.revision.revision)
			)
				return false;
			const older =
				dirty && basis !== loaded.revision.revision
					? await olderCopy(basis)
					: undefined;
			if (destroyed) return false;
			absorb(latest, prefer, older);
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
			// Opening reads the whole document once; after that, changes only.
			outputSync.forget();
			const value = outputSync.remember(parse(await read()));
			if (destroyed) return;
			loaded = value;
			const savedContent = value.revision.content;
			if (
				savedContent.file &&
				!savedContent.richText &&
				savedContent.blocks.length === 0
			) {
				// The host renders the attached file outside the editor frame.
				editor?.destroy();
				editor = undefined;
				toolbar.hidden = true;
				page.hidden = true;
				available = false;
				dirty = false;
				say();
				return;
			}
			toolbar.hidden = false;
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
					readImage: async (url) =>
						(
							await bridge.call<{ dataUrl: string }>("outputs.image", {
								slot,
								url,
							})
						).dataUrl,
				});
				editor.registerPlugin(blockSelectionPlugin());
				editor.on("transaction", () => {
					controls();
					slashSync();
				});
			}
			const content = structuredClone(
				retained?.content ?? value.revision.content,
			);
			show(check(content));
			basis = retained?.revision ?? value.revision.revision;
			draft = content;
			showAppearance();
			dirty = !!retained;
			failed = false;
			available = true;
			page.hidden = false;
			scheduleOutline();
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
		if (!loaded || !editor || !dirty || !editable || !available || destroyed)
			return;
		const sent = editor.state.doc,
			content = snapshot();
		let slow = false;
		busy = true;
		mark();
		const timer = setTimeout(() => {
			slow = true;
			say("Saving…");
		}, 1000);
		try {
			const value = parse(await outputSync.save(content, basis, read, asked));
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
			// An offer to undo an agent's change stays up through a quiet save.
			const note = asked || failed || slow ? "Saved" : "";
			if (note || !offering) say(note, false, [], true);
			failed = false;
			tries = 0;
			// A link typed just now can only be fetched once it is saved.
			retryLinkedImages();
		} catch (error) {
			if (destroyed) return;
			since = Date.now();
			// A save refused because someone else saved first: bring theirs in.
			if (await refresh().catch(() => false)) {
				if (again && dirty) await write(asked, false);
				return;
			}
			// A refusal that would repeat has no "Try again"; the next change does.
			const lasting = lastingSaveFailure(error);
			// A passing failure is tried again quietly before anyone is told.
			if (!lasting) {
				saveTimer = setTimeout(
					() => void save(false),
					Math.min(SAVE_RETRY_MAX_MS, SAVE_RETRY_MS * 2 ** tries),
				);
				if (tries++ < SAVE_QUIET_RETRIES && !asked) return;
			}
			failed = true;
			failedWhy = lasting || reason(error, "Saving failed");
			say(
				lasting ||
					`${reason(error, "Saving failed")}. Your changes are kept here.`,
				true,
				lasting ? [] : [["Try again", () => void save()]],
			);
		} finally {
			clearTimeout(timer);
			busy = false;
			mark();
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
		if (
			focus &&
			!(
				linkForm.hidden &&
				menu.hidden &&
				appearanceMenu.hidden &&
				colors.hidden &&
				shortcuts.hidden
			)
		)
			editor?.commands.focus();
		linkForm.hidden =
			blockMenu.hidden =
			tablePicker.hidden =
			tableMenu.hidden =
			menu.hidden =
			appearanceMenu.hidden =
			slash.hidden =
			colors.hidden =
			shortcuts.hidden =
				true;
	}
	async function addImage(file: File) {
		if (!editor?.isEditable) return;
		try {
			if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw 0;
			// Large pictures are scaled down so they stay quick to load.
			let src = await fileToStoredImage(file);
			// The picture is stored with the file; the document names it.
			src = (
				await bridge.call<{ reference: string }>("outputs.uploadImage", {
					slot,
					dataUrl: src,
				})
			).reference;
			if (!destroyed && editor.isEditable)
				run().setImage({ src, alt: file.name }).run();
		} catch (error) {
			say(reason(error, "Use a PNG, JPEG, GIF or WebP image."), true);
		}
	}
	const addTable = () =>
		run().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
	const addSection = () =>
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
			.run();
	const addNote = () =>
		run()
			.insertContent({ type: "callout", content: [{ type: "paragraph" }] })
			.run();
	const addList = (name: "bulletList" | "orderedList" | "taskList") =>
		run()
			.toggleList(name, name === "taskList" ? "taskItem" : "listItem")
			.run();
	/**
	 * What "/" offers: each block kind with its tile, the Markdown that also
	 * makes it, and the extra words it answers to.
	 */
	const inserts: {
		label: string;
		tile: string;
		hint?: string;
		words: string;
		add: () => unknown;
	}[] = [
		{
			label: "Text",
			tile: "T",
			words: "paragraph plain normal",
			add: () => applyDocumentStyle(editor!, "paragraph"),
		},
		{
			label: "Heading 1",
			tile: "H1",
			hint: "#",
			words: "title heading large",
			add: () => applyDocumentStyle(editor!, "1"),
		},
		{
			label: "Heading 2",
			tile: "H2",
			hint: "##",
			words: "heading subtitle medium",
			add: () => applyDocumentStyle(editor!, "2"),
		},
		{
			label: "Heading 3",
			tile: "H3",
			hint: "###",
			words: "heading small subheading",
			add: () => applyDocumentStyle(editor!, "3"),
		},
		{
			label: "Bulleted list",
			tile: "•",
			hint: "-",
			words: "bullet unordered list",
			add: () => addList("bulletList"),
		},
		{
			label: "Numbered list",
			tile: "1.",
			hint: "1.",
			words: "number ordered list",
			add: () => addList("orderedList"),
		},
		{
			label: "To-do list",
			tile: "☐",
			hint: "[]",
			words: "todo checkbox task checklist",
			add: () => addList("taskList"),
		},
		{
			label: "Quote",
			tile: "❝",
			hint: ">",
			words: "blockquote citation",
			add: () => applyDocumentStyle(editor!, "quote"),
		},
		{
			label: "Code block",
			tile: "{ }",
			hint: "```",
			words: "pre snippet monospace",
			add: () => applyDocumentStyle(editor!, "code"),
		},
		{
			label: "Divider",
			tile: "—",
			hint: "---",
			words: "hr line rule separator",
			add: () => run().setHorizontalRule().run(),
		},
		...(visitor
			? []
			: [
					{
						label: "Image",
						tile: "▣",
						words: "picture photo upload media",
						add: () => imageInput.click(),
					},
				]),
		{
			label: "Table",
			tile: "▦",
			hint: "| |",
			words: "grid rows columns cells spreadsheet",
			add: addTable,
		},
	];
	/** Label starts first, then a word of the label, then anywhere in label and words. */
	function slashMatches(query: string) {
		const q = query.toLowerCase().trim();
		if (!q) return inserts;
		return inserts
			.map((item) => {
				const label = item.label.toLowerCase();
				const score = label.startsWith(q)
					? 0
					: label.split(" ").some((word) => word.startsWith(q))
						? 1
						: `${label} ${item.words}`.includes(q)
							? 2
							: -1;
				return { item, score };
			})
			.filter((entry) => entry.score >= 0)
			.sort((a, b) => a.score - b.score)
			.map((entry) => entry.item);
	}
	// Where the "/" that opened the list is, where it was dismissed, the
	// highlighted choice, the filter it was made under, and the matches.
	let slashLine = -1,
		slashOff = -1,
		slashPick = 0,
		slashQuery = "",
		slashFound: typeof inserts = [];
	/** Open, filter or close the insert list to match the text before the caret. */
	function slashSync() {
		if (!editor) return;
		const { $from, empty } = editor.state.selection,
			line = $from.parent;
		const inTable = (() => {
			for (let depth = $from.depth; depth > 0; depth--)
				if (/^table(Cell|Header)$/.test($from.node(depth).type.name))
					return true;
			return false;
		})();
		// "/" at the start of a line or after a space, outside code and tables.
		const head =
			empty &&
			editor.isEditable &&
			line.isTextblock &&
			line.type.name !== "codeBlock" &&
			!inTable
				? line.textBetween(0, $from.parentOffset, undefined, "\ufffc")
				: "";
		const typed = /(^|\s)\/([^\n]*)$/.exec(head);
		const query = typed?.[2] ?? "";
		const valid = !!typed && query.length <= 24 && !/^\s|\s\s/.test(query);
		const at = valid ? $from.pos - query.length - 1 : -1;
		if (slashOff !== at) slashOff = -1;
		const found = at < 0 || slashOff === at ? [] : slashMatches(query);
		if (at < 0 || slashOff === at || (!found.length && query.length > 4)) {
			slashLine = -1;
			slashFound = [];
			slash.hidden = true;
			return;
		}
		if (slashLine !== at || slashQuery !== query) slashPick = 0;
		slashLine = at;
		slashQuery = query;
		slashFound = found;
		slashPick = Math.min(slashPick, Math.max(0, found.length - 1));
		slash.replaceChildren(
			...(found.length
				? found.map((item, index) => {
						const node = document.createElement("button");
						node.type = "button";
						node.setAttribute("role", "option");
						node.setAttribute("aria-selected", String(index === slashPick));
						node.innerHTML =
							'<span class="doc-tile"></span><span class="doc-mi"></span><span class="doc-md"></span>';
						node.children[0]!.textContent = item.tile;
						node.children[1]!.textContent = item.label;
						node.children[2]!.textContent = item.hint ?? "";
						node.onmousedown = (event) => event.preventDefault();
						node.onmousemove = () => {
							if (slashPick === index) return;
							slashPick = index;
							for (const [at, option] of [...slash.children].entries())
								option.setAttribute("aria-selected", String(at === index));
						};
						node.onclick = () => chooseSlash(item);
						return node;
					})
				: [
						Object.assign(document.createElement("div"), {
							className: "doc-mempty",
							textContent: "No blocks found",
						}),
					]),
		);
		let left = 16,
			top = 52;
		try {
			const box = editor.view.coordsAtPos(at);
			left = box.left;
			top = box.bottom + 6;
		} catch {
			// No layout to measure: open under the toolbar.
		}
		place(slash, left, top);
		slash.children[slashPick]?.scrollIntoView?.({ block: "nearest" });
	}
	/** The typed "/" and filter make way for what was chosen. */
	function chooseSlash(item: (typeof inserts)[number]) {
		if (!editor || slashLine < 0) return;
		const from = slashLine,
			to = editor.state.selection.from;
		slash.hidden = true;
		slashLine = -1;
		run().deleteRange({ from, to }).run();
		item.add();
	}
	async function exportAs(format: string, name: string) {
		if (!loaded || !available) return;
		await save(false);
		if (destroyed) return;
		try {
			if (format === "md") {
				const richText = editor!.getJSON() as OsRichTextDocument;
				// A picture stored with the file is written into the Markdown itself.
				const stored = new Map<string, string>();
				const collect = (nodes: OsRichTextNode[] = []) => {
					for (const node of nodes) {
						const src = node.type === "image" && node.attrs?.src;
						if (typeof src === "string" && src.startsWith("tedix-asset:"))
							stored.set(src, "");
						collect(node.content);
					}
				};
				collect(richText.content);
				await Promise.all(
					[...stored.keys()].map((url) =>
						bridge
							.call<{ dataUrl: string }>("outputs.image", { slot, url })
							.then(
								(image) => stored.set(url, image.dataUrl),
								() => undefined,
							),
					),
				);
				await bridge.call("app.download", {
					filename:
						(loaded.output.title || "Document").replace(/[\\/:*?"<>|]/g, "_") +
						".md",
					mimeType: "text/markdown",
					text: richTextToMarkdown(richText, (source) =>
						stored.has(source) ? stored.get(source) : source,
					),
				});
			} else
				await bridge.call("app.exportOutput", {
					slot,
					format,
					expectedRevision: loaded.revision.revision,
				});
			say(
				`Exported as ${name}.${format === "md" ? " Colours, sizes and alignment are not part of Markdown." : dirty ? " Your newest changes are not in it yet." : ""}`,
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
			["strike", "Strikethrough" + keys("X", true), "strike"],
			["code", "Code" + keys("E"), "code"],
		] as const)
			button(
				toolbar,
				label,
				icon,
				() => run().toggleMark(name).run(),
				() => editor!.isActive(name),
			);
		// Text color and highlight from one small palette.
		const paint = button(toolbar, "Text color and highlight", undefined, () => {
			const open = colors.hidden;
			closePopups();
			if (!open) return;
			colors.hidden = false;
			const box = paint.getBoundingClientRect();
			place(colors, box.left, box.bottom + 4);
			colors.querySelector("button")?.focus();
		});
		paint.innerHTML =
			'<span class="doc-paint" aria-hidden="true"><i class="doc-paint-fill"></i><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 16.5 12 4l5.5 12.5"/><path d="M8.6 12h6.8"/></svg><i class="doc-paint-bar"></i></span>';
		paint.title = "Color";
		paint.setAttribute("aria-label", "Color");
		paint.setAttribute("aria-haspopup", "dialog");
		paintButton = paint;
		const current = () => ({
			text: String(
				editor?.getAttributes("textStyle").color ?? "",
			).toLowerCase(),
			highlight: String(
				editor?.getAttributes("highlight").color ?? "",
			).toLowerCase(),
		});
		for (const kind of ["Text", "Highlight"] as const) {
			const heading = document.createElement("p");
			heading.textContent = kind;
			const grid = document.createElement("div");
			grid.className = "doc-swatches";
			grid.setAttribute("role", "group");
			grid.setAttribute("aria-label", kind);
			for (const [name, text, highlight] of PALETTE) {
				const color = kind === "Text" ? text : highlight;
				const swatch = document.createElement("button");
				swatch.type = "button";
				swatch.className = "doc-swatch";
				swatch.dataset.color = color;
				swatch.dataset.kind = kind;
				if (kind === "Text") {
					swatch.textContent = "A";
					swatch.style.color = color || "var(--fg)";
				} else if (color) swatch.style.background = color;
				else swatch.classList.add("none");
				swatch.title =
					kind === "Highlight" && !color ? "Clear highlight" : name;
				swatch.setAttribute("aria-label", `${kind} ${name}`);
				swatch.onmousedown = (event) => event.preventDefault();
				swatch.onclick = () => {
					if (kind === "Text")
						color ? run().setColor(color).run() : run().unsetColor().run();
					else
						color
							? run().setHighlight({ color }).run()
							: run().unsetHighlight().run();
					closePopups(true);
				};
				grid.append(swatch);
			}
			colors.append(heading, grid);
		}
		// The open palette rings the colors in use.
		paint.addEventListener("click", () => {
			const { text, highlight } = current();
			for (const swatch of colors.querySelectorAll<HTMLElement>(".doc-swatch"))
				swatch.classList.toggle(
					"on",
					(swatch.dataset.kind === "Text" ? text : highlight) ===
						swatch.dataset.color,
				);
		});
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
				() => addList(name),
				() => editor!.isActive(name),
			);
		divider();
		button(toolbar, "Link" + keys("K"), "link", openLink, () =>
			editor!.isActive("link"),
		);
		if (!visitor) button(toolbar, "Image", "image", () => imageInput.click());
		const tableButton = button(toolbar, "Table", "table", () =>
			openTablePicker(tableButton),
		);
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
		button(menu, "Note", undefined, addNote);
		button(menu, "Collapsible section", undefined, addSection);
		button(menu, "Divider", undefined, () => run().setHorizontalRule().run());
		divider(menu);
		button(menu, "Keyboard shortcuts" + keys("/"), undefined, () => {
			closePopups();
			showShortcuts();
		});
		divider(menu);
	} else {
		const note = document.createElement("span");
		note.className = "doc-readonly";
		note.textContent = "Read only";
		toolbar.append(note);
	}
	const exports = (
		[
			["md", "Markdown"],
			["docx", "Word"],
			["pdf", "PDF"],
			["html", "HTML"],
			["png", "PNG"],
		] as const
	).filter(([format]) => !visitor || format === "md");
	for (const [format, name] of exports)
		button(menu, `Export as ${name}`, undefined, () => exportAs(format, name));
	// Exporting and the menu itself also work for someone who can only read.
	buttons.splice(-exports.length);
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
	const appearanceButton = document.createElement("button");
	appearanceButton.type = "button";
	appearanceButton.className = "doc-appearance-button";
	appearanceButton.textContent = "Aa";
	appearanceButton.title = "Typeface & width";
	appearanceButton.setAttribute("aria-label", "Typeface & width");
	appearanceButton.setAttribute("aria-haspopup", "dialog");
	appearanceButton.onmousedown = (event) => event.preventDefault();
	appearanceButton.onclick = () => {
		const open = appearanceMenu.hidden;
		closePopups();
		if (!open) return;
		showAppearance();
		const box = appearanceButton.getBoundingClientRect();
		place(appearanceMenu, box.right - 250, box.bottom + 4);
	};
	toolbar.append(appearanceButton);
	const appearanceGrid = document.createElement("div");
	appearanceGrid.className = "doc-appearance-grid";
	const setAppearance = (
		typeface: "sans" | "serif" | "mono",
		wide: boolean,
	) => {
		if (!draft || !editable) return;
		const { appearance: _old, ...rest } = draft;
		draft =
			typeface === "sans" && !wide
				? rest
				: { ...rest, appearance: { typeface, wide } };
		showAppearance();
		changed();
	};
	for (const [typeface, label, sample] of [
		["sans", "Default", "Sans"],
		["serif", "Serif", "Aa"],
		["mono", "Mono", "Aa"],
	] as const) {
		const tile = document.createElement("button");
		tile.type = "button";
		tile.dataset.typeface = typeface;
		tile.disabled = !editable;
		tile.innerHTML = "<span></span><small></small>";
		tile.children[0]!.textContent = label;
		tile.children[1]!.textContent = sample;
		tile.onclick = () => setAppearance(typeface, appearance().wide);
		appearanceGrid.append(tile);
	}
	const wideButton = document.createElement("button");
	wideButton.type = "button";
	wideButton.className = "doc-wide";
	wideButton.disabled = !editable;
	wideButton.innerHTML = "<span>Full width</span><i aria-hidden=true></i>";
	wideButton.onclick = () => {
		const value = appearance();
		setAppearance(value.typeface, !value.wide);
	};
	appearanceMenu.append(appearanceGrid, wideButton);
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
	// ---- Tables: a size picker, and pills on the column and row under the pointer ----
	/** "Insert table": an 8 × 8 grid; pointer or arrow keys choose the size. */
	function openTablePicker(anchor: HTMLElement) {
		if (!editor) return;
		closePopups();
		let columns = 3,
			rows = 3;
		const label = document.createElement("p");
		const grid = document.createElement("div");
		grid.className = "doc-table-grid";
		grid.tabIndex = 0;
		const cells: HTMLElement[] = [];
		const paintGrid = () => {
			label.textContent = `${columns} × ${rows}`;
			cells.forEach((cell, index) =>
				cell.classList.toggle(
					"on",
					index % 8 < columns && Math.floor(index / 8) < rows,
				),
			);
		};
		const insert = () => {
			closePopups(true);
			run().insertTable({ rows, cols: columns, withHeaderRow: true }).run();
		};
		for (let index = 0; index < 64; index++) {
			const cell = document.createElement("i");
			cell.onmouseenter = () => {
				columns = (index % 8) + 1;
				rows = Math.floor(index / 8) + 1;
				paintGrid();
			};
			cell.onclick = insert;
			cells.push(cell);
		}
		grid.append(...cells);
		grid.onkeydown = (event) => {
			const moves: Record<string, [number, number]> = {
				ArrowRight: [1, 0],
				ArrowLeft: [-1, 0],
				ArrowDown: [0, 1],
				ArrowUp: [0, -1],
			};
			const move = moves[event.key];
			if (move) {
				event.preventDefault();
				event.stopPropagation();
				columns = Math.max(1, Math.min(8, columns + move[0]));
				rows = Math.max(1, Math.min(8, rows + move[1]));
				paintGrid();
			} else if (event.key === "Enter") {
				event.preventDefault();
				event.stopPropagation();
				insert();
			}
		};
		const title = document.createElement("p");
		title.className = "doc-table-title";
		title.textContent = "Insert table";
		tablePicker.replaceChildren(title, grid, label);
		paintGrid();
		const box = anchor.getBoundingClientRect();
		place(tablePicker, box.left, box.bottom + 4);
		grid.focus();
	}
	let tableCell: HTMLElement | undefined;
	/** The cell's position in the document, to put the caret in it. */
	const cellPos = (cell: HTMLElement) => editor!.view.posAtDOM(cell, 0);
	page.addEventListener("mousemove", (event) => {
		if (!editor?.isEditable || drag) return;
		const target = event.target as HTMLElement;
		if (target.closest?.(".doc-table-pill,.doc-table-add")) return;
		const cell = target.closest?.<HTMLElement>(".tiptap td, .tiptap th");
		const table = cell?.closest("table") as HTMLTableElement | null;
		if (!cell || !table) {
			if (!target.closest?.(".tiptap table"))
				for (const node of tablePills) node.hidden = true;
			return;
		}
		tableCell = cell;
		const tableBox = table.getBoundingClientRect(),
			cellBox = cell.getBoundingClientRect();
		const [columnPill, rowPill, addRow, addColumn] = tablePills;
		Object.assign(columnPill!.style, {
			left: `${cellBox.left + scrollX + cellBox.width / 2 - 12}px`,
			top: `${tableBox.top + scrollY - 6}px`,
		});
		Object.assign(rowPill!.style, {
			left: `${tableBox.left + scrollX - 6}px`,
			top: `${cellBox.top + scrollY + cellBox.height / 2 - 12}px`,
		});
		Object.assign(addRow!.style, {
			left: `${tableBox.left + scrollX}px`,
			top: `${tableBox.bottom + scrollY + 2}px`,
			width: `${tableBox.width}px`,
		});
		Object.assign(addColumn!.style, {
			left: `${tableBox.right + scrollX + 2}px`,
			top: `${tableBox.top + scrollY}px`,
			height: `${tableBox.height}px`,
		});
		for (const node of tablePills) node.hidden = false;
	});
	/** A pill's menu: insert or delete the column or row under the pointer. */
	function openTableMenu(kind: "column" | "row", anchor: HTMLElement) {
		if (!editor || !tableCell) return;
		const cell = tableCell,
			row = cell.parentElement as HTMLTableRowElement,
			header = row.rowIndex === 0 && cell.tagName === "TH";
		editor.chain().focus().setTextSelection(cellPos(cell)).run();
		const item = (label: string, run: () => unknown, danger = false) => {
			const node = document.createElement("button");
			node.type = "button";
			node.setAttribute("role", "menuitem");
			node.textContent = label;
			if (danger) node.className = "doc-danger";
			node.onmousedown = (event) => event.preventDefault();
			node.onclick = () => {
				run();
				closePopups(true);
			};
			return node;
		};
		const chain = () => editor!.chain().focus().setTextSelection(cellPos(cell));
		const items =
			kind === "column"
				? [
						item("Insert left", () => chain().addColumnBefore().run()),
						item("Insert right", () => chain().addColumnAfter().run()),
						document.createElement("hr"),
						item("Delete column", () => chain().deleteColumn().run(), true),
					]
				: [
						...(header
							? []
							: [item("Insert above", () => chain().addRowBefore().run())]),
						item("Insert below", () => chain().addRowAfter().run()),
						...(row.rowIndex === 0
							? [
									item(`${header ? "✓ " : ""}Header row`, () =>
										chain().toggleHeaderRow().run(),
									),
								]
							: []),
						document.createElement("hr"),
						item(
							header ? "Delete header row" : "Delete row",
							() => chain().deleteRow().run(),
							true,
						),
					];
		closePopups();
		tableMenu.replaceChildren(...items);
		const box = anchor.getBoundingClientRect();
		place(tableMenu, box.left, box.bottom + 4);
	}
	const [columnPill, rowPill, addRowBar, addColumnBar] = tablePills;
	for (const node of tablePills)
		node.onmousedown = (event) => event.preventDefault();
	columnPill!.onclick = () => openTableMenu("column", columnPill!);
	rowPill!.onclick = () => openTableMenu("row", rowPill!);
	/** Put the caret in the table's last cell, so a row or column is added at the end. */
	const toLastCell = () => {
		const table = tableCell?.closest("table");
		const cells = table?.querySelectorAll<HTMLElement>("td, th");
		const last = cells?.[cells.length - 1];
		return last
			? editor!.chain().focus().setTextSelection(cellPos(last))
			: undefined;
	};
	addRowBar!.onclick = () => toLastCell()?.addRowAfter().run();
	addColumnBar!.onclick = () => toLastCell()?.addColumnAfter().run();

	// ---- Block handles: "+" adds a block, the grip drags or opens the menu ----
	/** The block (a top-level block or list item) at a height on screen, with its element. */
	function unitAtY(clientY: number) {
		if (!editor) return undefined;
		const box = editor.view.dom.getBoundingClientRect();
		const found = editor.view.posAtCoords({
			left: box.left + 8,
			top: Math.max(box.top + 1, Math.min(box.bottom - 1, clientY)),
		});
		if (!found) return undefined;
		const unit = unitAt(
			editor,
			found.inside >= 0 ? found.inside + 1 : found.pos,
		);
		const dom = unit && editor.view.nodeDOM(unit.pos);
		return unit && dom instanceof HTMLElement ? { unit, dom } : undefined;
	}
	let hovered: { unit: Unit; dom: HTMLElement } | undefined;
	/** Put the "+" and grip beside a block, centred on its first line. */
	function showHandles(target: { unit: Unit; dom: HTMLElement }) {
		hovered = target;
		const content = editor!.view.dom.getBoundingClientRect(),
			box = target.dom.getBoundingClientRect();
		const line = parseFloat(getComputedStyle(target.dom).lineHeight) || 24;
		gutter.hidden = false;
		gutter.style.top = `${box.top + scrollY + Math.max(0, (Math.min(line, box.height) - 24) / 2)}px`;
		gutter.style.left = `${Math.max(2, content.left + scrollX - 12 - 41)}px`;
		// No room for "+" in a narrow window.
		addButton.hidden = content.left < 60;
		requestAnimationFrame(() => gutter.classList.add("on"));
	}
	function hideHandles() {
		gutter.classList.remove("on");
		gutter.hidden = true;
		hovered = undefined;
	}
	page.addEventListener("mousemove", (event) => {
		if (!editor?.isEditable || drag || !blockMenu.hidden || sweep) return;
		if (gutter.contains(event.target as Node)) return;
		const target = unitAtY(event.clientY);
		if (target) showHandles(target);
	});
	page.addEventListener("mouseleave", (event) => {
		if (
			!drag &&
			!gutter.contains(event.relatedTarget as Node) &&
			blockMenu.hidden
		)
			hideHandles();
	});
	// Typing hides the handles until the mouse moves again.
	page.addEventListener("keydown", () => {
		if (!drag) hideHandles();
	});
	handle.addEventListener("mouseenter", () =>
		hovered?.dom.classList.add("doc-grip-hover"),
	);
	handle.addEventListener("mouseleave", () =>
		hovered?.dom.classList.remove("doc-grip-hover"),
	);
	addButton.onmousedown = (event) => event.preventDefault();
	addButton.onclick = (event) => {
		if (!editor || !hovered) return;
		// A new empty line below (or above with Alt), then the / menu on it.
		const { unit } = hovered;
		const at = event.altKey ? unit.pos : unit.pos + unit.node.nodeSize;
		const type =
			unit.depth > 1 ? unit.node.type : editor.schema.nodes.paragraph!;
		const created =
			unit.depth > 1
				? type.createAndFill()!
				: editor.schema.nodes.paragraph!.create();
		const tr = editor.state.tr.insert(at, created);
		tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));
		editor.view.dispatch(tr);
		editor.commands.focus();
		editor.commands.insertContent("/");
		hideHandles();
	};
	let drag:
		| {
				units: Unit[];
				moved: boolean;
				y: number;
				x: number;
				to: number;
				from: { left: number; top: number };
				dims: HTMLElement[];
		  }
		| undefined;
	handle.onmousedown = (event) => event.preventDefault();
	handle.onpointerdown = (event) => {
		if (!editor?.isEditable || !hovered || event.button !== 0) return;
		event.preventDefault();
		// Dragging from a block selection moves the selected blocks together.
		const range = blockSelection(editor);
		const index = editor.state.doc.resolve(hovered.unit.pos).index(0);
		const units =
			range &&
			hovered.unit.depth === 1 &&
			index >= range.from &&
			index <= range.to
				? Array.from({ length: range.to - range.from + 1 }, (_, i) =>
						unitAt(editor!, blocks.blockStart(editor!, range.from + i) + 1)!,
					)
				: [hovered.unit];
		const box = hovered.dom.getBoundingClientRect();
		drag = {
			units,
			moved: false,
			y: event.clientY,
			x: event.clientX,
			to: -1,
			from: { left: box.left, top: box.top },
			dims: [],
		};
		handle.setPointerCapture?.(event.pointerId);
		handle.onpointermove = (move) => moveDrag(move);
		handle.onpointerup = handle.onpointercancel = (end) =>
			endDrag(end.type === "pointerup");
	};
	/** Follow the pointer with a card of the block, and show where it would land. */
	function moveDrag(move: PointerEvent) {
		if (!drag || !editor) return;
		if (!drag.moved && Math.abs(move.clientY - drag.y) < 4) return;
		if (!drag.moved) {
			drag.moved = true;
			const first = editor.view.nodeDOM(drag.units[0]!.pos) as HTMLElement;
			ghost.replaceChildren(first.cloneNode(true));
			if (drag.units.length > 1) {
				const badge = document.createElement("span");
				badge.className = "doc-ghost-count";
				badge.textContent = String(drag.units.length);
				ghost.append(badge);
			}
			ghost.style.width = `${first.getBoundingClientRect().width}px`;
			ghost.hidden = false;
			for (const unit of drag.units) {
				const dom = editor.view.nodeDOM(unit.pos);
				if (dom instanceof HTMLElement) {
					dom.classList.add("doc-dragging");
					drag.dims.push(dom);
				}
			}
			hideHandles();
		}
		// The card rides the pointer, with a little sideways give.
		ghost.style.left = `${drag.from.left + (move.clientX - drag.x) * 0.1}px`;
		ghost.style.top = `${drag.from.top + move.clientY - drag.y}px`;
		// Near the window's top or bottom, the page scrolls along.
		if (move.clientY < 64) scrollBy(0, -12);
		else if (move.clientY > innerHeight - 64) scrollBy(0, 12);
		const target = unitAtY(move.clientY);
		const lead = drag.units[0]!;
		const leadIndex = editor.state.doc.resolve(lead.pos).index(lead.depth - 1);
		if (!target || target.unit.depth !== lead.depth)
			return (drop.hidden = true);
		const box = target.dom.getBoundingClientRect();
		const after = move.clientY > box.top + box.height / 2;
		const index = editor.state.doc
			.resolve(target.unit.pos)
			.index(target.unit.depth - 1);
		const sameParent =
			editor.state.doc.resolve(target.unit.pos).start() ===
			editor.state.doc.resolve(lead.pos).start();
		drag.to = sameParent ? index + (after ? 1 : 0) : -1;
		// No line where dropping would change nothing.
		const size = drag.units.length;
		if (drag.to < 0 || (drag.to >= leadIndex && drag.to <= leadIndex + size))
			return (drop.hidden = true);
		const lane = target.dom.getBoundingClientRect();
		drop.hidden = false;
		drop.style.left = `${lane.left + scrollX}px`;
		drop.style.width = `${lane.width}px`;
		drop.style.top = `${(after ? box.bottom : box.top) + scrollY - 1}px`;
	}
	/** Drop the dragged blocks, or open the menu when the grip was only clicked. */
	function endDrag(dropped: boolean) {
		if (!drag || !editor) return;
		const { units, moved, to, dims } = drag;
		handle.onpointermove = handle.onpointerup = handle.onpointercancel = null;
		drag = undefined;
		ghost.hidden = true;
		ghost.replaceChildren();
		drop.hidden = true;
		for (const dom of dims) dom.classList.remove("doc-dragging");
		if (!moved) {
			const lead = units[0]!;
			if (lead.depth === 1) {
				const index = editor.state.doc.resolve(lead.pos).index(0);
				if (!blockSelection(editor))
					setBlockSelection(editor, { anchor: index, head: index });
			}
			return openBlockMenu(lead);
		}
		if (!dropped || to < 0) return;
		if (units.length === 1) moveUnit(editor, units[0]!, to);
		else {
			// Several selected blocks move as one, one step at a time.
			const range = blockSelection(editor)!;
			const steps = to > range.to ? to - range.to - 1 : to - range.from;
			for (let step = 0; step < Math.abs(steps); step++)
				blocks.moveSelected(editor, steps < 0 ? -1 : 1);
		}
		editor.commands.focus();
	}
	// Esc cancels a drag.
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && drag) {
			event.preventDefault();
			drag.moved && (drag.to = -1);
			endDrag(false);
		}
	});
	// Keyboard users reach the same menu from the grip.
	handle.onkeydown = (event) => {
		if ((event.key === "Enter" || event.key === " ") && hovered) {
			event.preventDefault();
			openBlockMenu(hovered.unit);
		}
	};
	/** The kinds a block can turn into, as tiles. */
	const TURN_INTO: [string, string, () => unknown][] = [
		["Text", "T", () => applyDocumentStyle(editor!, "paragraph")],
		["Heading 1", "H1", () => applyDocumentStyle(editor!, "1")],
		["Heading 2", "H2", () => applyDocumentStyle(editor!, "2")],
		["Heading 3", "H3", () => applyDocumentStyle(editor!, "3")],
		["Bulleted list", "•", () => addList("bulletList")],
		["Numbered list", "1.", () => addList("orderedList")],
		["To-do list", "☐", () => addList("taskList")],
		["Quote", "❝", () => applyDocumentStyle(editor!, "quote")],
		["Code block", "{ }", () => applyDocumentStyle(editor!, "code")],
	];
	/** The actions for a block, or for the selected blocks. */
	function openBlockMenu(unit: Unit) {
		if (!editor) return;
		closePopups();
		const range = blockSelection(editor);
		const count = range ? range.to - range.from + 1 : 1;
		const several = count > 1;
		const header = document.createElement("p");
		header.textContent = several ? `Turn ${count} blocks into` : "Turn into";
		const grid = document.createElement("div");
		grid.className = "doc-turn";
		const current = currentDocumentStyle(editor);
		for (const [name, tile, apply] of TURN_INTO) {
			const item = document.createElement("button");
			item.type = "button";
			item.setAttribute("role", "menuitem");
			item.title = name;
			item.setAttribute("aria-label", name);
			item.textContent = tile;
			if (
				!several &&
				name ===
					(
						{
							paragraph: "Text",
							"1": "Heading 1",
							"2": "Heading 2",
							"3": "Heading 3",
							quote: "Quote",
							code: "Code block",
						} as Record<string, string>
					)[current]
			)
				item.setAttribute("aria-current", "true");
			item.onmousedown = (event) => event.preventDefault();
			item.onclick = () => {
				const first = range ? blocks.blockStart(editor!, range.from) : unit.pos;
				const last = range
					? blocks.blockStart(editor!, range.to + 1) - 1
					: unit.pos + unit.node.nodeSize - 1;
				setBlockSelection(editor!, null);
				editor!
					.chain()
					.focus()
					.setTextSelection({
						from: first + 1,
						to: Math.max(first + 1, last - 1),
					})
					.run();
				apply();
				closePopups();
			};
			grid.append(item);
		}
		const action = (
			label: string,
			keysLabel: string,
			run: () => unknown,
			danger = false,
		) => {
			const item = document.createElement("button");
			item.type = "button";
			item.setAttribute("role", "menuitem");
			item.className = danger ? "doc-danger" : "";
			item.innerHTML = "<span></span><kbd></kbd>";
			item.children[0]!.textContent = label;
			item.children[1]!.textContent = keysLabel;
			item.onmousedown = (event) => event.preventDefault();
			item.onclick = () => {
				run();
				closePopups();
				hideHandles();
			};
			return item;
		};
		const mod = mac ? "⌘" : "Ctrl+",
			alt = mac ? "⌥⇧" : "Alt+Shift+";
		const items: HTMLElement[] = [
			action("Duplicate", `${mod}D`, () =>
				several
					? blocks.duplicateSelected(editor!)
					: duplicateUnit(editor!, unit),
			),
			action("Move up", `${alt}↑`, () =>
				several || unit.depth === 1
					? (blockSelection(editor!) ||
							setBlockSelection(editor!, {
								anchor: editor!.state.doc.resolve(unit.pos).index(0),
								head: editor!.state.doc.resolve(unit.pos).index(0),
							}),
						blocks.moveSelected(editor!, -1))
					: moveUnit(
							editor!,
							unit,
							editor!.state.doc.resolve(unit.pos).index() - 1,
						),
			),
			action("Move down", `${alt}↓`, () =>
				several || unit.depth === 1
					? (blockSelection(editor!) ||
							setBlockSelection(editor!, {
								anchor: editor!.state.doc.resolve(unit.pos).index(0),
								head: editor!.state.doc.resolve(unit.pos).index(0),
							}),
						blocks.moveSelected(editor!, 1))
					: moveUnit(
							editor!,
							unit,
							editor!.state.doc.resolve(unit.pos).index() + 2,
						),
			),
			action("Copy", `${mod}C`, () => {
				const from = range ? blocks.blockStart(editor!, range.from) : unit.pos;
				const to = range
					? blocks.blockStart(editor!, range.to + 1)
					: unit.pos + unit.node.nodeSize;
				void navigator.clipboard?.writeText(
					editor!.state.doc.textBetween(from, to, "\n\n"),
				);
			}),
		];
		// A table also offers its header row and even widths.
		const table =
			!several && unit.node.type.name === "table" ? unit.node : undefined;
		if (table) {
			const header = table.firstChild?.firstChild?.type.name === "tableHeader";
			items.push(
				action(`${header ? "✓ " : ""}Header row`, "", () => {
					editor!
						.chain()
						.focus()
						.setTextSelection(unit.pos + 4)
						.toggleHeaderRow()
						.run();
				}),
			);
			let widths = false;
			table.descendants((node) => {
				if (
					Array.isArray(node.attrs.colwidth) &&
					node.attrs.colwidth.some(Boolean)
				)
					widths = true;
			});
			if (widths)
				items.push(
					action("Even column widths", "", () => {
						const tr = editor!.state.tr;
						table.descendants((node, offset) => {
							if (node.attrs.colwidth)
								tr.setNodeMarkup(unit.pos + 1 + offset, undefined, {
									...node.attrs,
									colwidth: null,
								});
						});
						editor!.view.dispatch(tr);
					}),
				);
		}
		blockMenu.replaceChildren(
			header,
			grid,
			document.createElement("hr"),
			...items,
			document.createElement("hr"),
			action(
				several ? `Delete ${count} blocks` : "Delete",
				mac ? "⌫" : "Del",
				() =>
					several ? blocks.deleteSelected(editor!) : deleteUnit(editor!, unit),
				true,
			),
		);
		const box = handle.getBoundingClientRect();
		place(blockMenu, box.left, box.bottom + 4);
		blockMenu.querySelector("button")?.focus();
	}
	// ---- Block selection: Esc, Shift+arrows, or a sweep in the margin ----
	let sweep: { y: number } | undefined;
	page.addEventListener("pointerdown", (event) => {
		if (!editor?.isEditable || event.button !== 0) return;
		const content = editor.view.dom.getBoundingClientRect();
		// A press beside the text, not on it, starts a sweep over whole blocks.
		if (
			event.clientX >= content.left ||
			gutter.contains(event.target as Node)
		) {
			if (editor.view.dom.contains(event.target as Node))
				clearBlockSelection(editor);
			return;
		}
		event.preventDefault();
		sweep = { y: event.clientY };
		const select = (y: number) => {
			const a = unitAtY(sweep!.y),
				b = unitAtY(y);
			if (!a || !b) return;
			setBlockSelection(editor!, {
				anchor: editor!.state.doc.resolve(a.unit.pos).index(0),
				head: editor!.state.doc.resolve(b.unit.pos).index(0),
			});
		};
		select(event.clientY);
		const move = (next: PointerEvent) => select(next.clientY);
		const up = () => {
			sweep = undefined;
			removeEventListener("pointermove", move);
			removeEventListener("pointerup", up);
		};
		addEventListener("pointermove", move);
		addEventListener("pointerup", up);
	});
	/** The keyboard shortcuts sheet: every key, and the Markdown that types blocks. */
	function showShortcuts() {
		const chip = (text: string, md = false) => {
			const node = document.createElement("span");
			node.className = md ? "doc-chip md" : "doc-chip";
			node.textContent = text;
			return node;
		};
		const combo = (...parts: string[]) =>
			mac
				? parts
						.map(
							(part) =>
								({ mod: "⌘", shift: "⇧", alt: "⌥" })[part as "mod"] ?? part,
						)
						.join("")
				: parts
						.map(
							(part) =>
								({ mod: "Ctrl", shift: "Shift", alt: "Alt" })[part as "mod"] ??
								part,
						)
						.join("+");
		const row = (label: string, ...combos: string[]) => {
			const line = document.createElement("div");
			line.className = "doc-krow";
			const name = document.createElement("span");
			name.textContent = label;
			const chips = document.createElement("span");
			chips.className = "doc-chips";
			chips.append(...combos.map((text) => chip(text)));
			line.append(name, chips);
			return line;
		};
		const md = (label: string, ...tokens: string[]) => {
			const line = row(label);
			line.lastElementChild!.append(...tokens.map((text) => chip(text, true)));
			return line;
		};
		const heading = (text: string) => {
			const node = document.createElement("h3");
			node.textContent = text;
			return node;
		};
		const column = (...children: HTMLElement[]) => {
			const node = document.createElement("div");
			node.append(...children);
			return node;
		};
		const title = document.createElement("h2");
		title.textContent = "Keyboard shortcuts";
		const sub = document.createElement("p");
		sub.className = "doc-sub";
		sub.textContent =
			"Press / on a blank line to choose a block. Use its handle to move it.";
		const columns = document.createElement("div");
		columns.className = "doc-sheet-cols";
		columns.append(
			column(
				heading("Text style"),
				row("Bold", combo("mod", "B")),
				row("Italic", combo("mod", "I")),
				row("Underline", combo("mod", "U")),
				row("Strikethrough", combo("mod", "shift", "X")),
				row("Inline code", combo("mod", "E")),
				row("Highlight", combo("mod", "shift", "H")),
				row("Link", combo("mod", "K")),
				row("Clear formatting", combo("mod", "\\")),
				heading("Block types"),
				row("Text", combo("mod", "alt", "0")),
				row(
					"Heading 1 · 2 · 3",
					combo("mod", "alt", "1"),
					combo("mod", "alt", "2"),
					combo("mod", "alt", "3"),
				),
				row("Bulleted list", combo("mod", "shift", "8")),
				row("Numbered list", combo("mod", "shift", "7")),
				row("To-do list", combo("mod", "shift", "9")),
				row("Toggle a to-do", combo("mod", "↵")),
				row("Change list level", combo("Tab"), combo("shift", "Tab")),
				heading("Move blocks"),
				row("Choose current block", combo("Esc")),
				row("Choose more blocks", combo("shift", "↑"), combo("shift", "↓")),
				row(
					"Shift blocks up · down",
					combo("alt", "shift", "↑"),
					combo("alt", "shift", "↓"),
				),
				row("Duplicate", combo("mod", "D")),
				row("Remove chosen blocks", mac ? "⌫" : "Del"),
			),
			column(
				heading("Short text patterns"),
				md("Heading 1 · 2 · 3", "#", "##", "###"),
				md("Bulleted list", "-"),
				md("Numbered list", "1."),
				md("To-do list", "[]", "- [ ]"),
				md("Quote", ">"),
				md("Code block", "```"),
				md("Divider", "---"),
				md("Bold · italic", "**text**", "*text*"),
				md("Code · strike", "`code`", "~~text~~"),
				md("Make arrows · long dash", "->", "--"),
				md("Start table, then ↵", "| a | b |"),
				heading("Work with tables"),
				row("Go to next · prior cell", combo("Tab"), combo("shift", "Tab")),
				row("Go down · add row", combo("↵")),
				row("Add line inside cell", combo("shift", "↵")),
				heading("Other"),
				md("Open block menu", "/"),
				row("Save now", combo("mod", "S")),
				row(
					"Undo · redo",
					combo("mod", "Z"),
					mac ? combo("mod", "shift", "Z") : combo("mod", "Y"),
				),
				row("Show these shortcuts", combo("mod", "/")),
			),
		);
		const card = document.createElement("div");
		card.className = "doc-sheet";
		card.setAttribute("role", "dialog");
		card.setAttribute("aria-label", "Keyboard shortcuts");
		card.append(title, sub, columns);
		shortcuts.replaceChildren(card);
		shortcuts.hidden = false;
	}
	shortcuts.addEventListener("mousedown", (event) => {
		if (event.target === shortcuts) closePopups(true);
	});
	const keydown = (event: KeyboardEvent) => {
		const key = event.key.toLowerCase(),
			mod = event.metaKey || event.ctrlKey;
		// Whole blocks: Esc selects them, then arrows, Backspace, Cmd+D and Enter.
		const popupOpen =
			!slash.hidden ||
			!menu.hidden ||
			!appearanceMenu.hidden ||
			!linkForm.hidden ||
			!blockMenu.hidden ||
			!colors.hidden ||
			!shortcuts.hidden;
		if (
			editor?.isEditable &&
			!popupOpen &&
			editor.view.dom.contains(event.target as Node) &&
			blockSelectionKey(editor, event)
		) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (!slash.hidden && /^(arrow(up|down)|enter|tab|escape)$/.test(key)) {
			const choices = slashFound.length;
			if (key === "escape") {
				slashOff = slashLine;
				slash.hidden = true;
			} else if (key.startsWith("arrow")) {
				if (choices)
					slashPick =
						(slashPick + (key === "arrowdown" ? 1 : choices - 1)) % choices;
				slashSync();
			} else if (slashFound[slashPick]) chooseSlash(slashFound[slashPick]!);
			else {
				// Nothing to choose: the list closes and the key does its usual job.
				slashOff = slashLine;
				slash.hidden = true;
				return;
			}
			// The editor must not also move the caret or break the line.
			event.stopPropagation();
		} else if (mod && key === "z" && !event.shiftKey && offering) {
			// The agent's change is the newest one: undo takes that back first.
			undoLanded();
			event.stopPropagation();
		} else if (key === "escape") {
			if (
				linkForm.hidden &&
				menu.hidden &&
				appearanceMenu.hidden &&
				colors.hidden &&
				shortcuts.hidden
			)
				return;
			closePopups(true);
		} else if (mod && key === "s") void save();
		else if (mod && key === "/") {
			event.preventDefault();
			event.stopPropagation();
			const open = shortcuts.hidden;
			closePopups();
			if (open) showShortcuts();
		} else if (mod && key === "k") openLink();
		else if (editor?.isEditable && mod && event.shiftKey && key === "x")
			run().toggleStrike().run();
		else if (editor?.isEditable && mod && event.shiftKey && key === "h")
			editor.isActive("highlight")
				? run().unsetHighlight().run()
				: run().setHighlight({ color: DEFAULT_HIGHLIGHT }).run();
		else if (editor?.isEditable && mod && key === "\\")
			run().unsetAllMarks().run();
		else if (
			editor?.isEditable &&
			mod &&
			event.altKey &&
			/^Digit[0-3]$/.test(event.code)
		)
			applyDocumentStyle(
				editor,
				event.code === "Digit0"
					? "paragraph"
					: (event.code.slice(5) as "1" | "2" | "3"),
			);
		else if (
			editor?.isEditable &&
			mod &&
			key === "enter" &&
			editor.isActive("taskItem")
		)
			run()
				.updateAttributes("taskItem", {
					checked: !editor.getAttributes("taskItem").checked,
				})
				.run();
		else if (mod && key === "d" && editor?.isEditable && !event.shiftKey)
			duplicateDocumentBlock(editor, editor.state.selection.$from.index(0));
		else if (
			editor &&
			event.altKey &&
			event.shiftKey &&
			(key === "arrowup" || key === "arrowdown")
		)
			moveDocumentBlock(editor, key === "arrowup" ? -1 : 1);
		else return;
		event.preventDefault();
		// Handled here: the editor's own binding for the same keys must not run too.
		event.stopPropagation();
	};
	const pointerdown = (event: Event) => {
		const target = event.target as Node;
		if (!menu.contains(target) && !more.contains(target)) menu.hidden = true;
		if (!appearanceMenu.contains(target) && !appearanceButton.contains(target))
			appearanceMenu.hidden = true;
		if (!slash.contains(target)) slash.hidden = true;
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
	const onScroll = () => {
		toolbar.toggleAttribute("data-scrolled", scrollY > 2);
		updateOutlineCurrent();
		if (agentPos >= 0 && agentCaret.classList.contains("on"))
			moveAgentCaret(agentPos);
	};
	const onResize = () => scheduleOutline();
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
	window.addEventListener("resize", onResize, { passive: true });
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
			for (const timer of [
				saveTimer,
				draftTimer,
				statusTimer,
				landedTimer,
				outlineTimer,
				agentTimer,
			])
				clearTimeout(timer);
			input.stop();
			cancelAnimationFrame(frame);
			editor?.destroy();
			style.remove();
			window.removeEventListener("message", onMessage);
			window.removeEventListener("beforeunload", beforeUnload);
			window.removeEventListener("pagehide", flush);
			window.removeEventListener("scroll", onScroll);
			window.removeEventListener("resize", onResize);
			document.removeEventListener("visibilitychange", flush);
			document.removeEventListener("pointerdown", pointerdown);
			root.removeEventListener("keydown", keydown, true);
		},
	};
}
