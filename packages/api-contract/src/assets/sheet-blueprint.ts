import { z } from "zod";
import {
	OsBlueprintDefinitionSchema,
	OsOutputContentSchema,
	OsOutputPatchSchema,
	OsWorkspaceResourceSlotSchema,
	type OsBlueprintDefinition,
} from "../schemas/os-workspaces";
import { sheetCsvText } from "../utils/sheet-csv";

export const SHEET_BLUEPRINT_VERSION = 1;

export const SHEET_SERVER_SOURCE =
	`const sheetCsvText = (${sheetCsvText.toString()});\n` +
	String.raw`
export class App {
  constructor(ctx,env) { this.env=env; }
  get slot() { const slot=this.env.CONFIG?.settings?.slot; if(typeof slot!=="string"||!slot)throw new Error("Sheet slot is not configured");return slot; }
  async readSheet() {
    const result=await this.env.TEDIX.outputsRead(this.slot,{});
    if(result.revision?.content?.kind!=="sheet")throw new Error("This slot is not a sheet");
    return result;
  }
  async replaceSheet(input) {
    if(input?.content?.kind!=="sheet"||!Number.isInteger(input.expectedRevision)||input.expectedRevision<1)throw new Error("Sheet content and its expected revision are required");
    await this.env.TEDIX.outputsWrite(this.slot,{content:input.content,expectedRevision:input.expectedRevision});return this.readSheet();
  }
  async editSheet(input) {
    if(!input||!Number.isInteger(input.expectedRevision)||input.expectedRevision<1||!Array.isArray(input.cells)||!input.cells.length)throw new Error("A cell range and its expected revision are required");
    await this.env.TEDIX.outputsPatch(this.slot,{kind:"sheet",startRow:input.startRow,startColumn:input.startColumn,cells:input.cells,expectedRevision:input.expectedRevision});return this.readSheet();
  }
  async exportCsv() {
    const {output,revision}=await this.readSheet();const content=revision.content;
    const sheet=content.workbook?.sheets.find(sheet=>sheet.id===content.workbook.activeSheetId);
    const rows=sheet ? [sheet.columns.map(column=>column.label),...sheet.rows.map(row=>sheet.columns.map((_,index)=>row[index]?.value??null))] : [content.columns,...content.rows];
    return {title:output.title,revision:revision.revision,sheetName:sheet?.name??"Sheet1",mimeType:"text/csv;charset=utf-8",text:sheetCsvText(rows)};
  }
}
`;

export const SHEET_CLIENT_SOURCE = String.raw`
const root=document.getElementById("app"),style=document.createElement("style");
style.textContent=":root{font:14px system-ui,sans-serif;color:#1d2532;background:#f6f7f9}*{box-sizing:border-box}body{margin:0}main{padding:20px}header,.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}h1{font-size:22px;flex:1;margin:0}button,select,input{font:inherit;color:inherit}button,select{border:1px solid #cbd2dd;background:white;padding:8px 12px;border-radius:7px}button{cursor:pointer}button.primary{background:#2855bb;color:white;border-color:#2855bb}button:disabled,input:disabled,select:disabled{opacity:.6;cursor:default}.status,#updates{font-size:13px;min-height:24px;color:#526176}.error{color:#a31c30!important}.grid{overflow:auto;max-height:70vh;border:1px solid #d4dae4;border-radius:8px;background:white}table{border-collapse:collapse;min-width:100%}th,td{border:1px solid #e0e5ed;min-width:130px;padding:0;vertical-align:top}thead th{position:sticky;top:0;background:#eef1f6;z-index:2}th.index{min-width:44px;width:44px;padding:10px;text-align:center;position:sticky;left:0;background:#eef1f6;z-index:1}thead th.index{z-index:3}td input,th input{width:100%;min-width:120px;border:0;padding:8px;background:transparent;outline-offset:-2px}td output{display:block;font-size:12px;min-height:22px;padding:2px 8px 5px;color:#526176;white-space:pre-wrap}th label{display:block;font-size:11px;padding:5px 8px 0;color:#68748a}p.help{font-size:12px;color:#526176;margin:10px 0}@media(max-width:500px){main{padding:12px}button{padding:8px}}";document.head.append(style);
const main=document.createElement("main");main.innerHTML='<header><h1>Sheet</h1><button id="save" class="primary">Save</button><button id="reload">Reload</button><button id="export">CSV</button></header><div class="toolbar"><label>Active sheet <select id="tabs"></select></label><button id="add-row">Add row</button><button id="add-column">Add column</button></div><div class="status" role="status" aria-live="polite"></div><div id="updates" role="status" aria-live="polite"></div><p class="help">Type values or formulas such as =SUM(A1:A3). Each cell shows its input and calculated value. Save preserves all workbook tabs and formatting. CSV exports the saved active sheet.</p><div class="grid"><table aria-label="Sheet cells"></table></div>';root.replaceChildren(main);
const status=main.querySelector(".status"),updates=main.querySelector("#updates"),table=main.querySelector("table"),save=main.querySelector("#save"),reload=main.querySelector("#reload"),tabs=main.querySelector("#tabs");
let loaded,draft,canEdit=false,dirty=false,busy=false,discard=false,slot,pendingRevision=0,generation=0;
const call=(method,input={})=>tedix.call("app.call",{method,args:[input]});
const active=()=>draft.workbook.sheets.find(sheet=>sheet.id===draft.workbook.activeSheetId)??draft.workbook.sheets[0];
const label=index=>{let value=index+1,result="";while(value){value--;result=String.fromCharCode(65+value%26)+result;value=Math.floor(value/26);}return result;};
function message(text,error=false){status.textContent=text;status.classList.toggle("error",error);}
function controls(){save.disabled=busy||!canEdit||!dirty;reload.disabled=busy;tabs.disabled=busy;main.querySelectorAll("table input,#add-row,#add-column").forEach(node=>node.disabled=busy||!canEdit);}
function changed(){generation++;dirty=true;discard=false;reload.textContent="Reload";message("Unsaved changes · based on revision "+loaded.revision.revision);controls();}
function showValues(){const sheet=active();table.querySelectorAll("output").forEach(node=>{const cell=sheet.rows[Number(node.dataset.row)]?.[Number(node.dataset.column)];node.textContent=cell?.value===null||cell?.value===undefined?"":String(cell.value);});}
async function calculate(){const version=generation;try{const content=await tedix.call("sheet.evaluate",{content:draft});if(version!==generation)return;draft=content;showValues();}catch(error){message(error.message||String(error),true);}}
function render(){
  const sheet=active();tabs.replaceChildren();draft.workbook.sheets.forEach(item=>{const option=document.createElement("option");option.value=item.id;option.textContent=item.name;option.selected=item.id===sheet.id;tabs.append(option);});table.replaceChildren();
  const head=document.createElement("thead"),header=document.createElement("tr"),corner=document.createElement("th");corner.className="index";corner.textContent="#";header.append(corner);
  sheet.columns.forEach((column,index)=>{const th=document.createElement("th"),name=document.createElement("label"),input=document.createElement("input");name.textContent=label(index);input.value=column.label;input.setAttribute("aria-label","Column "+label(index)+" title");input.oninput=()=>{active().columns[index].label=input.value;changed();};th.append(name,input);header.append(th);});head.append(header);table.append(head);
  const body=document.createElement("tbody");for(let row=0;row<Math.max(sheet.rows.length,8);row++){const tr=document.createElement("tr"),index=document.createElement("th");index.className="index";index.textContent=String(row+1);tr.append(index);
    sheet.columns.forEach((column,col)=>{const td=document.createElement("td"),input=document.createElement("input"),output=document.createElement("output"),cell=sheet.rows[row]?.[col];input.value=cell?.input??"";input.setAttribute("aria-label",label(col)+(row+1));output.dataset.row=String(row);output.dataset.column=String(col);const format=cell?.format;if(format){td.style.fontWeight=format.bold?"bold":"normal";td.style.fontStyle=format.italic?"italic":"normal";td.style.textDecoration=[format.underline?"underline":"",format.strike?"line-through":""].filter(Boolean).join(" ");td.style.fontSize=format.fontSize?format.fontSize+"px":"";td.style.color=format.textColor??"";td.style.backgroundColor=format.fillColor??"";td.style.textAlign=format.horizontalAlign??"";}
      input.oninput=()=>{const current=active();while(current.rows.length<=row)current.rows.push(current.columns.map(()=>null));const previous=current.rows[row][col];current.rows[row][col]={input:input.value,value:previous?.value??null,...(previous?.format?{format:previous.format}:{})};changed();};input.onchange=()=>void calculate();td.append(input,output);tr.append(td);});body.append(tr);}
  table.append(body);showValues();controls();
}
function refreshExternal(){if(!loaded||busy)return;if(pendingRevision<=loaded.revision.revision){pendingRevision=0;updates.textContent="";return;}updates.textContent="Revision "+pendingRevision+" is available."+(dirty?" Your unsaved edits are preserved. Reload to review the saved sheet.":" Loading the saved sheet…");if(dirty)return;pendingRevision=0;void load();}
window.addEventListener("message",event=>{if(event.source!==window.parent||event.data?.jsonrpc!=="2.0"||event.data.method!=="tedix/outputs-changed"||!Array.isArray(event.data.params?.outputs))return;for(const output of event.data.params.outputs)if(output.slot===slot&&(!loaded||output.outputId===loaded.output.id)&&Number.isInteger(output.revision)&&output.revision>0)pendingRevision=Math.max(pendingRevision,output.revision);refreshExternal();});
async function load(){busy=true;controls();message("Loading sheet…");try{const result=await call("readSheet");const content=await tedix.call("sheet.evaluate",{content:result.revision.content});loaded=result;draft=content;generation++;dirty=false;discard=false;reload.textContent="Reload";main.querySelector("h1").textContent=result.output.title;render();message("Revision "+result.revision.revision);}catch(error){message(error.message||String(error),true);}finally{busy=false;controls();refreshExternal();}}
save.onclick=async()=>{if(busy||!dirty||!canEdit)return;busy=true;controls();message("Saving…");try{const content=await tedix.call("sheet.evaluate",{content:draft});const result=await call("replaceSheet",{content,expectedRevision:loaded.revision.revision});loaded=result;draft=await tedix.call("sheet.evaluate",{content:result.revision.content});generation++;dirty=false;discard=false;reload.textContent="Reload";render();message("Saved · revision "+result.revision.revision);}catch(error){message((error.message||String(error))+". Your draft is still here. Reload only when ready to discard it.",true);}finally{busy=false;controls();refreshExternal();}};
reload.onclick=()=>{if(busy)return;if(dirty&&!discard){discard=true;reload.textContent="Discard draft & reload";message("Click Reload again to discard unsaved changes.",true);return;}void load();};
main.querySelector("#add-row").onclick=()=>{if(busy||!canEdit)return;const sheet=active();if(sheet.rows.length>=1000){message("Sheets support up to 1000 rows.",true);return;}sheet.rows.push(sheet.columns.map(()=>null));changed();render();};
main.querySelector("#add-column").onclick=()=>{if(busy||!canEdit)return;const sheet=active();if(sheet.columns.length>=64){message("Sheets support up to 64 columns.",true);return;}sheet.columns.push({id:"column-"+crypto.randomUUID(),label:label(sheet.columns.length),width:120});sheet.rows.forEach(row=>row.push(null));changed();render();};
tabs.onchange=async()=>{if(busy)return;draft.workbook.activeSheetId=tabs.value;if(canEdit)changed();await calculate();render();};
main.querySelector("#export").onclick=async()=>{try{const result=await call("exportCsv");await tedix.call("app.download",{filename:(result.title||"Sheet").replace(/[\\/:*?"<>|]/g,"_")+".csv",mimeType:result.mimeType,text:result.text});message("Exported saved revision "+result.revision+(dirty?" · unsaved changes are not included.":""));}catch(error){message(error.message||String(error),true);}};
try{const context=await tedix.call("context");canEdit=context.role==="owner"||context.role==="build";slot=context.settings?.slot;await load();}catch(error){message(error.message||String(error),true);controls();}
`;

export const SHEET_README = `# Sheet

Sheet binds one canonical workspace output. Its grid reads and saves the
same content and revisions as the native spreadsheet editor. No sheet body
is copied into app storage.

The browser calculates formulas with the existing spreadsheet engine before
saving the entire workbook, including other tabs, cell formats and formula
inputs. Agent range edits store typed inputs; dependent formula caches stay
at their last calculation. They do not independently recalculate formulas.
Reload or save in an editor
to calculate updated values. CSV exports the saved active sheet's cached
values using the same formula-injection protection as workspace exports.

Clean editors refresh after external writes. Unsaved drafts stay on screen
with a newer-revision notice. Save checks the revision you loaded; a conflict
keeps the draft, and Reload requires confirmation before discarding it.
`;

export function buildSheetBlueprint(slot = "sheet"): OsBlueprintDefinition {
	OsWorkspaceResourceSlotSchema.parse(slot);
	const content = OsOutputContentSchema.options.find(
		(option) => option.shape.kind.value === "sheet",
	)!;
	const patch = OsOutputPatchSchema.options.find(
		(option) => option.shape.kind.value === "sheet",
	)!;
	const editInput = z.toJSONSchema(patch);
	if ("properties" in editInput && editInput.properties)
		delete editInput.properties.kind;
	if ("required" in editInput && Array.isArray(editInput.required))
		editInput.required = editInput.required.filter((key) => key !== "kind");
	const empty = { type: "object", properties: {}, additionalProperties: false };
	return OsBlueprintDefinitionSchema.parse({
		gadgets: [
			{
				name: "Sheet",
				manifest: {
					entry: "tedix:runtime/v1",
					description: "Edit a spreadsheet with formulas and revision history.",
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
							name: "readSheet",
							description:
								"Read sheet input and last-calculated values at the current revision.",
							input: empty,
							effect: "read",
							outputSlot: slot,
						},
						{
							name: "replaceSheet",
							description:
								"Replace a full workbook at an expected revision, preserving formula input and formats.",
							input: {
								type: "object",
								properties: {
									content: z.toJSONSchema(content),
									expectedRevision: { type: "integer", minimum: 1 },
								},
								required: ["content", "expectedRevision"],
								additionalProperties: false,
							},
							effect: "write",
							outputSlot: slot,
						},
						{
							name: "editSheet",
							description:
								"Write a bounded rectangle into the active sheet at an expected revision. Formula inputs are preserved; cached values recalculate in editors.",
							input: editInput,
							effect: "write",
							outputSlot: slot,
						},
						{
							name: "exportCsv",
							description:
								"Export the saved active sheet's cached values as formula-injection-safe CSV.",
							input: empty,
							effect: "read",
							outputSlot: slot,
						},
					],
				},
				files: {
					"client.js": SHEET_CLIENT_SOURCE,
					"server.js": SHEET_SERVER_SOURCE,
					"README.md": SHEET_README,
				},
			},
		],
		requirements: {
			version: 1,
			outputs: [
				{ gadget: "Sheet", kind: "sheet", title: "Untitled sheet", slot },
			],
		},
	});
}
