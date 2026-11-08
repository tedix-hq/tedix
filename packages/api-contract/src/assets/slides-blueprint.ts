import { z } from "zod";
import {
	OsBlueprintDefinitionSchema,
	OsPresentationPatchOpSchema,
	OsPresentationSlideSchema,
	OsWorkspaceResourceSlotSchema,
	type OsBlueprintDefinition,
} from "../schemas/os-workspaces";

export const SLIDES_BLUEPRINT_VERSION = 1;

export const SLIDES_SERVER_SOURCE = String.raw`
function outline(content) {
  if (!content.deck) return content.slides;
  return content.deck.slides.map(slide => {
    const ordered = [...slide.elements].sort((a,b) => a.y-b.y || a.x-b.x);
    return {title:(ordered.find(element => element.type === "title")?.text ?? slide.name).slice(0,300),
      bullets:ordered.filter(element => element.type === "bullet").flatMap(element => (element.text || "").split("\n")).map(text => text.trim()).filter(Boolean).slice(0,30),
      ...(slide.notes ? {notes:slide.notes} : {})};
  });
}
export class App {
  constructor(ctx,env) { this.env = env; }
  get slot() {
    const slot = this.env.CONFIG?.settings?.slot;
    if (typeof slot !== "string" || !slot) throw new Error("Presentation slot is not configured");
    return slot;
  }
  async readPresentation() {
    const result = await this.env.TEDIX.outputsRead(this.slot,{});
    if (result.revision?.content?.kind !== "presentation") throw new Error("This slot is not a presentation");
    return {...result,outline:outline(result.revision.content)};
  }
  async replacePresentation(input) {
    if (input?.content?.kind !== "presentation" || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error("A presentation and expected revision are required");
    await this.env.TEDIX.outputsWrite(this.slot,{content:input.content,expectedRevision:input.expectedRevision});
    return this.readPresentation();
  }
  async editSlides(input) {
    if (!Array.isArray(input?.ops) || !input.ops.length || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error("Slide edits and expected revision are required");
    await this.env.TEDIX.outputsPatch(this.slot,{kind:"presentation",ops:input.ops,expectedRevision:input.expectedRevision});
    return this.readPresentation();
  }
  async exportOutline() {
    const result = await this.readPresentation();
    return {outputId:result.output.id,revision:result.revision.revision,title:result.output.title,mimeType:"text/markdown",projection:"semantic_outline",
      text:result.outline.map((slide,index) => "# " + (index+1) + ". " + slide.title + "\n\n" + slide.bullets.map(text => "- " + text).join("\n") + (slide.notes ? "\n\nNotes: " + slide.notes : "")).join("\n\n---\n\n")};
  }
}
`;

export const SLIDES_CLIENT_SOURCE = String.raw`
const root = document.getElementById("app");
const style = document.createElement("style");
style.textContent = "*{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:#1c2330;font:15px system-ui,sans-serif}main{padding:20px;max-width:1400px;margin:auto}header{display:flex;gap:10px;align-items:center;flex-wrap:wrap}h1{font-size:22px;flex:1;margin:0}button,input,textarea{font:inherit;color:inherit}button{border:1px solid #cad1dd;border-radius:7px;background:#fff;padding:8px 12px;cursor:pointer}button:disabled{opacity:.5;cursor:default}button.primary{background:#2855bb;color:white;border-color:#2855bb}.status,#updates{font-size:13px;min-height:23px;margin:10px 0}.error{color:#a31c30}.layout{display:grid;grid-template-columns:190px minmax(260px,1fr);gap:18px;margin-top:15px}nav{display:flex;flex-direction:column;gap:8px}nav button{text-align:left;overflow-wrap:anywhere}nav button[aria-pressed=true]{border-color:#2855bb;box-shadow:0 0 0 1px #2855bb}.workspace{min-width:0}.tools{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}.slide{aspect-ratio:16/9;background:white;border:1px solid #dce1e8;border-radius:8px;box-shadow:0 3px 10px #00000008;padding:5% 6%;overflow:auto;position:relative}.slide h2{font-size:clamp(22px,3vw,42px);line-height:1.15;margin:0 0 7%}.slide li{font-size:clamp(15px,2vw,25px);line-height:1.5;white-space:pre-wrap}.edit{display:grid;gap:12px;margin-top:18px}.edit label{display:grid;gap:5px;font-size:13px;color:#536174}input,textarea{width:100%;background:white;border:1px solid #cad1dd;border-radius:6px;padding:9px}textarea{min-height:80px;resize:vertical}.note{font-size:13px;color:#536174;margin:12px 0}.empty{padding:48px 20px;text-align:center}.presenting{position:fixed;inset:0;z-index:10;background:#111827;padding:30px;display:flex;flex-direction:column;justify-content:center}.presenting .slide{width:min(100%,130vh);margin:auto}.presenting .present-tools{display:flex;justify-content:center;gap:12px;margin-top:14px;color:white}.presenting .badge{color:white;text-align:center;margin-bottom:12px}#presenter[hidden]{display:none}@media(max-width:700px){main{padding:12px}.layout{grid-template-columns:1fr}nav{flex-direction:row;overflow-x:auto}nav button{min-width:140px}.slide{padding:20px}.presenting{padding:10px}}";
document.head.append(style);
root.innerHTML = '<main><header><h1>Slides</h1><button id="save" class="primary">Save</button><button id="reload">Reload</button><button id="outline">Download outline</button><button id="present">Present</button></header><div class="status" role="status" aria-live="polite"></div><div id="updates" role="status" aria-live="polite"></div><div class="layout"><aside><div class="tools"><button id="add">Add slide</button></div><nav aria-label="Slides"></nav></aside><div class="workspace"><div class="tools"><button id="up">Move up</button><button id="down">Move down</button><button id="remove">Remove slide</button></div><section class="slide" aria-label="Slide outline preview"></section><p class="note">Outline preview. Existing canvas artwork and styling stay in the saved presentation; use the workspace presentation editor for exact visual layout and PowerPoint/PDF export.</p><div class="edit"><label>Slide title<input id="title" maxlength="300" aria-label="Slide title"></label><label>Bullets · one per line<textarea id="bullets" aria-label="Slide bullets"></textarea></label><label>Speaker notes<textarea id="notes" maxlength="10000" aria-label="Speaker notes"></textarea></label></div></div></div><section id="presenter" class="presenting" hidden aria-label="Presentation"><div class="badge"></div><div class="slide"></div><div class="present-tools"><button id="previous">Previous slide</button><span id="position"></span><button id="next">Next slide</button><button id="exit">Exit presentation</button></div></section></main>';
const main = root.querySelector("main"), status = main.querySelector(".status"), updates = main.querySelector("#updates"), nav = main.querySelector("nav"), preview = main.querySelector("section.slide"), editor = main.querySelector(".edit"), presenter = main.querySelector("#presenter");
const byId = id => main.querySelector("#"+id);
const call = (method,input={}) => tedix.call("app.call",{method,args:[input]});
let loaded, draft=[], active=0, busy=false, dirty=false, canEdit=false, slot, pendingRevision=0, discardPending=false;
function message(text,error=false) {status.textContent=text;status.classList.toggle("error",error);}
function outlineValue(slide) {return {title:slide.title,bullets:slide.bullets,...(slide.notes ? {notes:slide.notes} : {})};}
function controls() {
  byId("save").disabled=busy || !canEdit || !dirty;
  byId("reload").disabled=busy;
  byId("add").disabled=busy || !canEdit || draft.length>=200;
  byId("up").disabled=busy || !canEdit || active<=0;
  byId("down").disabled=busy || !canEdit || active>=draft.length-1;
  byId("remove").disabled=busy || !canEdit || !draft.length;
  byId("present").disabled=!draft.length;
  editor.querySelectorAll("input,textarea").forEach(node=>node.disabled=busy || !canEdit || !draft.length);
}
function paintSlide(container,slide) {
  container.replaceChildren();
  if (!slide) {const empty=document.createElement("p");empty.className="empty";empty.textContent="Add your first slide to start a presentation.";container.append(empty);return;}
  const title=document.createElement("h2");title.textContent=slide.title || "Untitled slide";container.append(title);
  const list=document.createElement("ul");slide.bullets.forEach(text=>{const item=document.createElement("li");item.textContent=text;list.append(item);});container.append(list);
}
function paintPresentation() {paintSlide(presenter.querySelector(".slide"),draft[active]);presenter.querySelector(".badge").textContent=dirty ? "Draft preview · unsaved changes" : "Saved revision "+loaded.revision.revision;byId("position").textContent=(active+1)+" / "+draft.length;byId("previous").disabled=active===0;byId("next").disabled=active>=draft.length-1;}
function render() {
  active=Math.max(0,Math.min(active,draft.length-1));nav.replaceChildren();
  draft.forEach((slide,index)=>{const button=document.createElement("button");button.textContent=(index+1)+". "+(slide.title || "Untitled slide");button.setAttribute("aria-pressed",String(index===active));button.onclick=()=>{active=index;render();};nav.append(button);});
  const selected=draft[active];byId("title").value=selected?.title || "";byId("bullets").value=selected?.bullets.join("\n") || "";byId("notes").value=selected?.notes || "";
  paintSlide(preview,selected);if (!presenter.hidden) paintPresentation();controls();
}
function changed() {dirty=true;discardPending=false;byId("reload").textContent="Reload";message("Unsaved changes · based on revision "+loaded.revision.revision);paintSlide(preview,draft[active]);const label=nav.children[active];if(label)label.textContent=(active+1)+". "+(draft[active]?.title || "Untitled slide");controls();}
function refreshExternal() {
  if(!loaded || busy)return;
  if(pendingRevision<=loaded.revision.revision){pendingRevision=0;updates.textContent="";return;}
  updates.textContent="Revision "+pendingRevision+" is available."+(dirty ? " Your unsaved edits are preserved. Reload to review the saved presentation." : " Loading saved slides…");
  if(dirty)return;pendingRevision=0;void load();
}
window.addEventListener("message",event=>{
  if(event.source!==window.parent || event.data?.jsonrpc!=="2.0" || event.data.method!=="tedix/outputs-changed" || !Array.isArray(event.data.params?.outputs))return;
  for(const output of event.data.params.outputs)if(output.slot===slot && (!loaded || output.outputId===loaded.output.id) && Number.isInteger(output.revision) && output.revision>0)pendingRevision=Math.max(pendingRevision,output.revision);
  refreshExternal();
});
async function load() {
  busy=true;controls();message("Loading slides…");
  try {loaded=await call("readPresentation");draft=loaded.outline.map((slide,index)=>({...structuredClone(slide),key:loaded.revision.content.deck?.slides[index]?.id || "existing-"+index}));dirty=false;discardPending=false;byId("reload").textContent="Reload";main.querySelector("h1").textContent=loaded.output.title;message("Revision "+loaded.revision.revision+(canEdit ? "" : " · read-only"));render();}
  catch(error){message(error.message || String(error),true);}
  finally{busy=false;controls();refreshExternal();}
}
byId("title").oninput=()=>{if(draft[active]){draft[active].title=byId("title").value;changed();}};
byId("bullets").oninput=()=>{if(draft[active]){draft[active].bullets=byId("bullets").value.split("\n").filter(Boolean);changed();}};
byId("notes").oninput=()=>{if(draft[active]){draft[active].notes=byId("notes").value;changed();}};
byId("add").onclick=()=>{draft.splice(draft.length,0,{key:crypto.randomUUID(),title:"Untitled slide",bullets:[],notes:""});active=draft.length-1;changed();render();};
byId("remove").onclick=()=>{draft.splice(active,1);changed();render();};
function move(to){if(to<0 || to>=draft.length)return;draft.splice(to,0,draft.splice(active,1)[0]);active=to;changed();render();}
byId("up").onclick=()=>move(active-1);byId("down").onclick=()=>move(active+1);
byId("reload").onclick=()=>{if(dirty && !discardPending){discardPending=true;byId("reload").textContent="Discard draft & reload";message("Reload will discard your unsaved slides. Click again to confirm.",true);return;}void load();};
byId("save").onclick=async()=>{
  if(busy || !dirty || !canEdit)return;
  if(draft.some(slide=>!slide.title.trim() || slide.bullets.length>30 || slide.bullets.some(text=>text.length>2000))){message("Each slide needs a title and up to 30 bullets of 2,000 characters each.",true);return;}
  const current=loaded.outline.map((slide,index)=>({...slide,key:loaded.revision.content.deck?.slides[index]?.id || "existing-"+index})),ops=[];
  draft.forEach((slide,index)=>{
    const from=current.findIndex(item=>item.key===slide.key);
    if(from===-1){ops.push({op:"insert",index,slide:outlineValue(slide)});current.splice(index,0,slide);return;}
    if(from!==index){ops.push({op:"move",from,to:index});current.splice(index,0,current.splice(from,1)[0]);}
    if(JSON.stringify(outlineValue(current[index]))!==JSON.stringify(outlineValue(slide))){ops.push({op:"replace",index,slide:outlineValue(slide)});current[index]=slide;}
  });
  for(let index=current.length-1;index>=draft.length;index--)ops.push({op:"delete",index});
  if(ops.length>100){message("Save up to 100 slide changes at a time.",true);return;}
  busy=true;controls();message("Saving…");
  try{const result=ops.length ? await call("editSlides",{ops,expectedRevision:loaded.revision.revision}) : loaded;loaded=result;draft=result.outline.map((slide,index)=>({...structuredClone(slide),key:result.revision.content.deck?.slides[index]?.id || "existing-"+index}));dirty=false;message("Saved · revision "+result.revision.revision);render();}
  catch(error){message((error.message || String(error))+". Your draft is still here. Copy your edits before reloading a newer revision.",true);}
  finally{busy=false;controls();refreshExternal();}
};
byId("present").onclick=()=>{presenter.hidden=false;paintPresentation();};byId("exit").onclick=()=>{presenter.hidden=true;render();};
byId("previous").onclick=()=>{active=Math.max(0,active-1);paintPresentation();};byId("next").onclick=()=>{active=Math.min(draft.length-1,active+1);paintPresentation();};
window.addEventListener("keydown",event=>{if(presenter.hidden)return;if(event.key==="Escape"){presenter.hidden=true;render();}else if(event.key==="ArrowRight"){active=Math.min(draft.length-1,active+1);paintPresentation();}else if(event.key==="ArrowLeft"){active=Math.max(0,active-1);paintPresentation();}});
byId("outline").onclick=async()=>{try{const result=await call("exportOutline");await tedix.call("app.download",{filename:(result.title || "Presentation").replace(/[\\/:*?"<>|]/g,"_")+".md",mimeType:result.mimeType,text:result.text});message("Exported saved revision "+result.revision+" as an outline; canvas artwork is not included."+(dirty ? " Unsaved edits are not included." : ""));}catch(error){message(error.message || String(error),true);}};
controls();
try{const context=await tedix.call("context");canEdit=context.role==="owner" || context.role==="build";slot=context.settings?.slot;await load();}catch(error){message(error.message || String(error),true);controls();}
`;

export function buildSlidesBlueprint(
	slot = "presentation",
): OsBlueprintDefinition {
	OsWorkspaceResourceSlotSchema.parse(slot);
	const expectedRevision = { type: "integer", minimum: 1 };
	const patch = z.toJSONSchema(OsPresentationPatchOpSchema);
	const slide = z.toJSONSchema(OsPresentationSlideSchema);
	const object = (
		properties: Record<string, unknown>,
		required: string[] = [],
	) => ({
		type: "object",
		properties,
		required,
		additionalProperties: false,
	});
	return OsBlueprintDefinitionSchema.parse({
		gadgets: [
			{
				name: "Slides",
				manifest: {
					entry: "tedix:runtime/v1",
					description:
						"Write, arrange and present slides with revision history.",
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
							name: "readPresentation",
							description: "Read the current presentation and revision.",
							input: object({}),
							effect: "read",
							outputSlot: slot,
						},
						{
							name: "replacePresentation",
							description:
								"Replace canonical content at an expected revision; preserve deck fields to retain canvas artwork.",
							input: object(
								{
									content: object(
										{
											kind: { type: "string", const: "presentation" },
											slides: { type: "array", items: slide, maxItems: 200 },
											deck: { type: "object" },
										},
										["kind", "slides"],
									),
									expectedRevision,
								},
								["content", "expectedRevision"],
							),
							effect: "write",
							outputSlot: slot,
						},
						{
							name: "editSlides",
							description:
								"Apply ordered slide insert, replace, delete or move edits while retaining canvas content.",
							input: object(
								{
									ops: {
										type: "array",
										items: patch,
										minItems: 1,
										maxItems: 100,
									},
									expectedRevision,
								},
								["ops", "expectedRevision"],
							),
							effect: "write",
							outputSlot: slot,
						},
						{
							name: "exportOutline",
							description:
								"Export the saved semantic slide outline, excluding canvas artwork.",
							input: object({}),
							effect: "read",
							outputSlot: slot,
						},
					],
				},
				files: {
					"client.js": SLIDES_CLIENT_SOURCE,
					"server.js": SLIDES_SERVER_SOURCE,
					"README.md":
						"# Slides\n\nSlides reads and edits its named canonical presentation output. Save uses the loaded revision; a conflict keeps your draft until explicit discard and reload. Clean editors refresh on saved output notifications. The editor changes title, bullets and notes and can add, remove or reorder slides. Canvas artwork and styles are retained; use the native presentation editor for exact visual layout and PowerPoint/PDF export. Present and Download outline show semantic content only. Templates contain no presentation content, chat or credentials.\n\nAgent methods: readPresentation({}), replacePresentation({content,expectedRevision}), editSlides({ops,expectedRevision}), exportOutline({}). Writes use scoped output capabilities and approval policy.\n",
				},
			},
		],
		requirements: {
			version: 1,
			outputs: [
				{
					gadget: "Slides",
					kind: "presentation",
					title: "Untitled presentation",
					slot,
				},
			],
		},
	});
}
