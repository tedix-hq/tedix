import { z } from "zod";
import portableSheetClient from "./sheet-client.v3.generated.json";
import { SHEET_BLUEPRINT_VERSION } from "./office-editor-versions";
import {
	OsBlueprintDefinitionSchema,
	OsOutputContentSchema,
	OsOutputPatchSchema,
	OsWorkspaceResourceSlotSchema,
	type OsBlueprintDefinition,
} from "../schemas/os-workspaces";
import { sheetCsvText } from "../utils/sheet-csv";

export const SHEET_CLIENT_SOURCE = portableSheetClient.source;
export const SHEET_CLIENT_SHA256 = portableSheetClient.sha256;

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

export const SHEET_README = `# Sheet

Sheet is a reusable spreadsheet gadget bound to one canonical workspace
output. The bundled grid runs inside the gadget, with no native editor
dispatch or separate sheet body in app storage.

Select cells or ranges with the mouse, Shift and arrows, or the A1 name box.
Type or press F2 to edit a cell; the formula bar edits its source. Tab and
Enter move within a selected range. Copy/paste supports quoted multiline
TSV, formula-relative copies and cell formats. Undo and redo preserve the
workbook draft. The toolbar provides number/text formats, fills, alignment,
sorting and filling; More actions and the right-click menus on cells,
headings and tabs cover row/column operations, sizing and frozen panes. Workbooks
can contain up to 32 tabs, each with 50,000 rows and 702 columns (A to ZZ).

Changes save on their own a moment after you stop editing; Ctrl/⌘ S saves at
once. The generic host calculates formulas with the existing spreadsheet
engine before each save, which sends only the cells, formats and tab
properties that changed since the revision you loaded; the saved workbook
keeps everything else. A workbook holds up to 8 MB of UTF-8 content. A failed save
keeps your changes and is tried again, unless trying again cannot help (a
file over the limit, or lost edit access): then Sheet says why and waits for
your next change. When someone else saves first, their
changes and yours are merged; you are asked which version to keep only for a
cell you both changed. Editors with nothing unsaved show external writes in
place.

Agent range edits retain typed inputs and last-calculated values; an open
editor recalculates dependent formulas when it saves. Agent writes keep the
workspace's approval policy. CSV exports saved active-sheet cached values
with the canonical formula-injection protection. Excel exports the complete
saved workbook, including formula source, tabs and styles. A download saves
your changes first.
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
					config: {
						version: 1,
						settings: { slot, blueprintVersion: SHEET_BLUEPRINT_VERSION },
					},
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
