import { z } from "zod";
import {
	OsBlueprintDefinitionSchema,
	OsDocumentBlockSchema,
	OsDocumentPatchOpSchema,
	OsWorkspaceResourceSlotSchema,
	type OsBlueprintDefinition,
} from "../schemas/os-workspaces";

export const DOC_SERVER_SOURCE = String.raw`
function supportsBlockEditing(content) {
  if (content.file) return false;
  if (!content.richText) return true;
  const text = value => value ? [{type:"text",text:value}] : [];
  const paragraph = value => ({type:"paragraph",content:text(value)});
  const nodes = content.blocks.map(block => {
    switch (block.type) {
      case "paragraph": return paragraph(block.text);
      case "heading": return {type:"heading",attrs:{level:block.level},content:text(block.text)};
      case "quote": return {type:"blockquote",content:[paragraph(block.text)]};
      case "code": return {type:"codeBlock",attrs:{language:block.language ?? null},content:text(block.text)};
      case "list": return {type:block.ordered ? "orderedList" : "bulletList",content:block.items.map(item => ({type:"listItem",content:item ? [paragraph(item)] : []}))};
      case "checklist": return {type:"taskList",content:block.items.map(item => ({type:"taskItem",attrs:{checked:item.checked},content:[paragraph(item.text)]}))};
      case "divider": return {type:"horizontalRule"};
      case "callout": return {type:"callout",content:block.text ? [paragraph(block.text)] : []};
      case "toggle": return {type:"details",content:[{type:"detailsSummary",content:text(block.summary)},{type:"detailsContent",content:block.text ? [paragraph(block.text)] : []}]};
      case "table": return {type:"table",content:[block.headers,...block.rows].map((row,i) => ({type:"tableRow",content:block.headers.map((_,col) => ({type:i === 0 ? "tableHeader" : "tableCell",attrs:{colwidth:block.widths?.[col] ? [block.widths[col]] : null},content:[{type:"paragraph",attrs:{textAlign:block.align?.[col] || "left"},content:text(row[col] || "")}]}))}))};
      default: return null;
    }
  });
  const stable = value => JSON.stringify(value, function(key, entry) {
    return entry && typeof entry === "object" && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a],[b]) => a.localeCompare(b))) : entry;
  });
  return !nodes.includes(null) && stable(content.richText) === stable({type:"doc",content:nodes});
}
export class App {
  constructor(ctx, env) { this.env = env; }
  get slot() {
    const slot = this.env.CONFIG?.settings?.slot;
    if (typeof slot !== "string" || !slot) throw new Error("Document slot is not configured");
    return slot;
  }
  async readDocument(input = {}) {
    const result = await this.env.TEDIX.outputsRead(this.slot, {});
    if (result.revision?.content?.kind !== "document") throw new Error("This slot is not a document");
    return { ...result, blockEditingSupported: supportsBlockEditing(result.revision.content) };
  }
  async replaceDocument(input) {
    if (!input || input.content?.kind !== "document" || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error("A document and its expected revision are required");
    }
    await this.env.TEDIX.outputsWrite(this.slot, { content: input.content, expectedRevision: input.expectedRevision });
    return this.readDocument({});
  }
  async editDocument(input) {
    if (!input || !Array.isArray(input.ops) || !input.ops.length || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error("Document edits and their expected revision are required");
    }
    await this.env.TEDIX.outputsPatch(this.slot, { kind: "document", ops: input.ops, expectedRevision: input.expectedRevision });
    return this.readDocument({});
  }
  async exportMarkdown(input = {}) {
    const { output, revision } = await this.readDocument(input);
    const cell = value => String(value).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
    const text = revision.content.blocks.map(block => {
      switch (block.type) {
        case "heading": return "#".repeat(block.level) + " " + block.text;
        case "paragraph": return block.text;
        case "quote": return block.text.split("\n").map(line => "> " + line).join("\n");
        case "callout": return "> " + block.text.replace(/\n/g, "\n> ");
        case "toggle": return block.summary + "\n\n" + block.text;
        case "list": return block.items.map((item, i) => (block.ordered ? (i + 1) + ". " : "- ") + item).join("\n");
        case "checklist": return block.items.map(item => "- [" + (item.checked ? "x" : " ") + "] " + item.text).join("\n");
        case "divider": return "---";
        case "code": {
          const runs = block.text.match(/\x60+/g) || [];
          const fence = String.fromCharCode(96).repeat(Math.max(3, ...runs.map(run => run.length + 1)));
          return fence + (block.language || "") + "\n" + block.text + "\n" + fence;
        }
        case "table": return [block.headers, block.headers.map(() => "---"), ...block.rows].map(row => "| " + row.map(cell).join(" | ") + " |").join("\n");
        default: throw new Error("Unsupported document block: " + block.type);
      }
    }).join("\n\n");
    return { outputId: output.id, revision: revision.revision, title: output.title, mimeType: "text/markdown", text,
      projection: revision.content.richText ? "semantic_blocks" : "complete" };
  }
}
`;

export const DOC_CLIENT_SOURCE = String.raw`
const root = document.getElementById("app");
const style = document.createElement("style");
style.textContent = ":root{font:15px system-ui,sans-serif;color:#1c2330;background:#f6f7f9}*{box-sizing:border-box}body{margin:0}main{max-width:860px;margin:auto;padding:24px}header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}h1{font-size:23px;margin:0;flex:1}button,select{font:inherit;border:1px solid #c9cfd8;background:white;border-radius:7px;padding:8px 12px;color:inherit;cursor:pointer}button.primary{background:#2855bb;color:white;border-color:#2855bb}button:disabled{opacity:.5;cursor:default}.status{min-height:24px;font-size:13px;color:#536174}.status.error{color:#a31c30}.block{background:white;border:1px solid #dce1e8;border-radius:9px;padding:14px;margin:12px 0}.block header{margin:0 0 8px;font-size:12px;color:#536174}.block textarea{width:100%;min-height:64px;resize:vertical;padding:8px;border:1px solid #dde2e9;border-radius:5px;font:inherit;line-height:1.6}.block input[type=text]{width:100%;padding:8px;border:1px solid #dde2e9;border-radius:5px;font:inherit}.block[data-type=heading] textarea{font-size:22px;font-weight:650}.block[data-type=code] textarea{font:13px monospace}.block table{width:100%;border-collapse:collapse}.block td,.block th{padding:3px;min-width:100px}.table-wrap{overflow-x:auto}.check{display:flex;gap:8px;align-items:center;margin:6px 0}.check textarea{min-height:42px}.note{background:#fff5d7;padding:12px;border-radius:7px;margin:12px 0}.add{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:500px){main{padding:14px}header{gap:8px}button{padding:8px}}";
document.head.append(style);
const main = document.createElement("main");
main.innerHTML = '<header><h1>Doc</h1><button class="primary" id="save">Save</button><button id="reload">Reload</button><button id="export">Markdown</button></header><div class="status" role="status" aria-live="polite"></div><div id="notice"></div><section aria-label="Document blocks"></section><div class="add"><select aria-label="New block type"><option value="paragraph">Paragraph</option><option value="heading">Heading</option><option value="list">List</option><option value="checklist">Checklist</option><option value="quote">Quote</option><option value="code">Code</option><option value="table">Table</option><option value="callout">Callout</option><option value="toggle">Toggle</option><option value="divider">Divider</option></select><button id="add">Add block</button></div>';
root.replaceChildren(main);
const status = main.querySelector(".status"), blocks = main.querySelector("section"), notice = main.querySelector("#notice");
const save = main.querySelector("#save"), reload = main.querySelector("#reload"), add = main.querySelector("#add");
let loaded, draft, dirty = false, busy = false, editable = false, canEdit = false, discardPending = false;
const call = (method, input = {}) => tedix.call("app.call", { method, args: [input] });
function message(text, error = false) { status.textContent = text; status.classList.toggle("error", error); }
function controls() { save.disabled = busy || !editable || !dirty; reload.disabled = busy; add.disabled = busy || !editable; main.querySelector("select").disabled = busy || !editable; blocks.querySelectorAll("input,textarea,select,button").forEach(node => node.disabled = busy || !editable); }
function changed() { dirty = true; discardPending = false; reload.textContent = "Reload"; message("Unsaved changes · based on revision " + loaded.revision.revision); controls(); }
function field(parent, value, update, label, multiline = true) {
  const input = document.createElement(multiline ? "textarea" : "input");
  if (!multiline) input.type = "text";
  input.value = value; input.setAttribute("aria-label", label);
  input.addEventListener("input", () => { update(input.value); changed(); });
  parent.append(input); return input;
}
function render() {
  blocks.replaceChildren();
  draft.blocks.forEach((block, index) => {
    const card = document.createElement("article"); card.className = "block"; card.dataset.type = block.type;
    const header = document.createElement("header"), label = document.createElement("span");
    label.textContent = (index + 1) + " · " + block.type; header.append(label);
    const remove = document.createElement("button"); remove.textContent = "Remove"; remove.setAttribute("aria-label", "Remove block " + (index + 1));
    remove.addEventListener("click", () => { draft.blocks.splice(index, 1); changed(); render(); }); header.append(remove); card.append(header);
    if (block.type === "heading") {
      const level = document.createElement("select"); level.setAttribute("aria-label", "Heading level");
      [1,2,3,4].forEach(value => { const option = document.createElement("option"); option.value = String(value); option.textContent = "Heading " + value; level.append(option); });
      level.value = String(block.level); level.addEventListener("change", () => { block.level = Number(level.value); changed(); }); card.append(level);
    }
    if (typeof block.text === "string") {
      if (block.type === "toggle") field(card, block.summary, value => block.summary = value, "Toggle summary", false);
      if (block.type === "code") field(card, block.language || "", value => block.language = value, "Code language", false);
      field(card, block.text, value => block.text = value, "Block " + (index + 1) + " text");
    } else if (block.type === "list") {
      const ordered = document.createElement("label"), checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = block.ordered;
      checkbox.addEventListener("change", () => { block.ordered = checkbox.checked; changed(); }); ordered.append(checkbox, " Numbered list"); card.append(ordered);
      block.items.forEach((item, i) => field(card, item, value => block.items[i] = value, "List item " + (i + 1)));
      const more = document.createElement("button"); more.textContent = "Add item"; more.onclick = () => { block.items.push(""); changed(); render(); }; card.append(more);
    } else if (block.type === "checklist") {
      block.items.forEach((item, i) => { const row = document.createElement("div"); row.className = "check"; const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = item.checked; checkbox.setAttribute("aria-label", "Complete item " + (i + 1)); checkbox.onchange = () => { item.checked = checkbox.checked; changed(); }; row.append(checkbox); field(row, item.text, value => item.text = value, "Checklist item " + (i + 1)); card.append(row); });
      const more = document.createElement("button"); more.textContent = "Add item"; more.onclick = () => { block.items.push({text:"",checked:false}); changed(); render(); }; card.append(more);
    } else if (block.type === "table") {
      const wrap = document.createElement("div"); wrap.className = "table-wrap"; const table = document.createElement("table");
      [block.headers, ...block.rows].forEach((values, rowIndex) => { const row = document.createElement("tr"); values.forEach((value, col) => { const cell = document.createElement(rowIndex === 0 ? "th" : "td"); field(cell, value, text => values[col] = text, "Table row " + (rowIndex + 1) + " column " + (col + 1), false); row.append(cell); }); table.append(row); }); wrap.append(table); card.append(wrap);
      const more = document.createElement("button"); more.textContent = "Add row"; more.onclick = () => { block.rows.push(block.headers.map(() => "")); changed(); render(); }; card.append(more);
    } else if (block.type === "divider") card.append(document.createElement("hr"));
    else { const raw = document.createElement("pre"); raw.textContent = JSON.stringify(block, null, 2); card.append(raw); }
    blocks.append(card);
  });
  if (!draft.blocks.length) { const empty = document.createElement("p"); empty.textContent = "Start with a paragraph, heading or list."; blocks.append(empty); }
  controls();
}
async function load() {
  busy = true; controls(); message("Loading document…");
  try {
    const result = await call("readDocument");
    loaded = result; draft = structuredClone(result.revision.content); dirty = false; discardPending = false; reload.textContent = "Reload";
    main.querySelector("h1").textContent = result.output.title;
    editable = canEdit && result.blockEditingSupported;
    notice.replaceChildren();
    if (!result.blockEditingSupported) { const note = document.createElement("p"); note.className = "note"; note.textContent = "This document contains rich formatting or a file. Open its workspace output editor to edit it without losing content. This Doc view is read-only."; notice.append(note); }
    else if (!canEdit) notice.textContent = "You have read-only access to this document.";
    message("Revision " + result.revision.revision); render();
  } catch (error) { message(error.message || String(error), true); }
  finally { busy = false; controls(); }
}
save.onclick = async () => {
  if (busy || !editable || !dirty) return;
  busy = true; controls(); message("Saving…");
  try {
    const previous = loaded.revision.content.blocks, ops = [];
    for (let i = 0; i < Math.min(previous.length, draft.blocks.length); i++) if (JSON.stringify(previous[i]) !== JSON.stringify(draft.blocks[i])) ops.push({op:"replace",index:i,block:draft.blocks[i]});
    for (let i = previous.length - 1; i >= draft.blocks.length; i--) ops.push({op:"delete",index:i});
    for (let i = previous.length; i < draft.blocks.length; i++) ops.push({op:"insert",index:i,block:draft.blocks[i]});
    if (ops.length > 100) throw new Error("Save up to 100 block changes at a time, or use the workspace output editor");
    const result = ops.length ? await call("editDocument", { ops, expectedRevision: loaded.revision.revision }) : loaded;
    loaded = result; draft = structuredClone(result.revision.content); dirty = false; editable = canEdit && result.blockEditingSupported;
    notice.replaceChildren();
    if (!result.blockEditingSupported) notice.textContent = "Saved. This document now includes rich formatting. Use its workspace output editor for further edits.";
    message("Saved · revision " + result.revision.revision); render();
  } catch (error) { message((error.message || String(error)) + ". Your draft is still here. Copy your edits before reloading a newer revision.", true); }
  finally { busy = false; controls(); }
};
reload.onclick = () => { if (dirty && !discardPending) { discardPending = true; reload.textContent = "Discard draft & reload"; message("Reload will discard your unsaved edits. Click again to confirm.", true); return; } load(); };
add.onclick = () => {
  if (!editable || busy) return;
  const type = main.querySelector("select").value;
  const defaults = { heading:{level:2,text:""}, paragraph:{text:""}, list:{ordered:false,items:[""]}, checklist:{items:[{text:"",checked:false}]}, code:{language:"",text:""}, quote:{text:""}, callout:{text:""}, toggle:{summary:"Details",text:""}, table:{headers:["Column 1","Column 2"],rows:[["",""]]}, divider:{} };
  draft.blocks.push({type,...defaults[type]}); changed(); render();
};
main.querySelector("#export").onclick = async () => {
  try { const result = await call("exportMarkdown"); const link = document.createElement("a"), url = URL.createObjectURL(new Blob([result.text], {type:result.mimeType})); link.href = url; link.download = (result.title || "Document").replace(/[\\/:*?"<>|]/g, "_") + ".md"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); message("Exported saved revision " + result.revision + (result.projection === "semantic_blocks" ? " as semantic Markdown; rich formatting is not included." : "") + (dirty ? " · unsaved edits are not included." : "")); }
  catch (error) { message(error.message || String(error), true); }
};
try { const context = await tedix.call("context"); canEdit = context.role === "owner" || context.role === "build"; await load(); }
catch (error) { message(error.message || String(error), true); controls(); }
`;

export const DOC_README = `# Doc

Doc reads and edits the document output bound to its named workspace slot.
The output owns the content, revision history and source access rules. App
storage never holds a second copy of the document.

Save uses the revision you loaded. A conflict keeps your draft on screen;
copy your edits before explicitly discarding the draft and reloading.
Plain block documents, including their derived rich text, stay editable.
Documents with additional rich formatting or attached files remain read-only
here; use their workspace output editor to preserve that content.

Agent methods: readDocument({}), replaceDocument({content, expectedRevision}),
editDocument({ops, expectedRevision}) and exportMarkdown({}). Edits use the
same output capabilities as the editor and remain subject to access and
approval policy. Markdown exports use the saved semantic blocks.
`;

export function buildDocBlueprint(slot = "document"): OsBlueprintDefinition {
	OsWorkspaceResourceSlotSchema.parse(slot);
	const block = z.toJSONSchema(OsDocumentBlockSchema);
	const patch = z.toJSONSchema(OsDocumentPatchOpSchema);
	const expectedRevision = { type: "integer", minimum: 1 };
	return OsBlueprintDefinitionSchema.parse({
		gadgets: [
			{
				name: "Doc",
				manifest: {
					entry: "tedix:runtime/v1",
					description: "Write and review a document with revision history.",
					capabilities: [],
					config: { version: 1, settings: { slot } },
					resourceGrants: [
						{
							slot,
							operations: ["outputs.read", "outputs.write", "outputs.patch"],
						},
					],
					operations: [
						{
							name: "readDocument",
							description: "Read the current document and its revision.",
							input: {
								type: "object",
								properties: {},
								additionalProperties: false,
							},
							effect: "read",
							outputSlot: slot,
						},
						{
							name: "replaceDocument",
							description:
								"Replace a document at an expected revision; preserve any richText or file fields that should remain.",
							input: {
								type: "object",
								properties: {
									content: {
										type: "object",
										properties: {
											kind: { const: "document", type: "string" },
											blocks: { type: "array", items: block, maxItems: 500 },
											richText: { type: "object" },
											file: { type: "object" },
										},
										required: ["kind", "blocks"],
										additionalProperties: false,
									},
									expectedRevision,
								},
								required: ["content", "expectedRevision"],
								additionalProperties: false,
							},
							effect: "write",
							outputSlot: slot,
						},
						{
							name: "editDocument",
							description:
								"Apply ordered insert, replace or delete block edits at an expected revision.",
							input: {
								type: "object",
								properties: {
									ops: {
										type: "array",
										items: patch,
										minItems: 1,
										maxItems: 100,
									},
									expectedRevision,
								},
								required: ["ops", "expectedRevision"],
								additionalProperties: false,
							},
							effect: "write",
							outputSlot: slot,
						},
						{
							name: "exportMarkdown",
							description:
								"Export saved semantic document blocks as Markdown with their source revision.",
							input: {
								type: "object",
								properties: {},
								additionalProperties: false,
							},
							effect: "read",
							outputSlot: slot,
						},
					],
				},
				files: {
					"client.js": DOC_CLIENT_SOURCE,
					"server.js": DOC_SERVER_SOURCE,
					"README.md": DOC_README,
				},
			},
		],
		requirements: {
			version: 1,
			outputs: [
				{ gadget: "Doc", kind: "document", title: "Untitled document", slot },
			],
		},
	});
}
