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

This gadget edits one workspace sheet output. Its grid lives inside the
gadget, and the output remains the only saved copy of the workbook.

Use the mouse, Shift with the arrow keys, or the A1 box to choose cells and
ranges. Start typing or press F2 to edit a cell. The formula bar changes the
same cell input. Tab and Enter move through a selected range. Copy and paste
keeps multiline TSV, relative formulas, and cell formats. Undo and redo apply
to your workbook draft.

The toolbar controls number and text formats, colors, alignment, sorting, and
fill. Drag the small square on a selection in any direction to fill nearby
cells. Number patterns continue, and labels such as "Item 1" count forward.
As you write a formula, Sheet suggests matching functions and shows the
current arguments. A bare = shows common functions, while ƒx shows the full
list. Click or drag across cells to add references and see referenced ranges
outlined. Ctrl/⌘ Shift L or $ changes a reference through
A1 → $A$1 → A$1 → $A1. Ctrl/⌘ F searches displayed values on the current
sheet; its options include every sheet and formula text.

Use More or right-click cells, headings, and tabs for row and column changes,
sizing, frozen panes, and filters. Filter detects a table and its heading row,
or uses a selection that spans rows. A heading menu can sort the table, return
it to its original order, or choose the values to display. Everyone sees the
same filtered rows because the filter is saved with the sheet. A workbook can
have up to 32 tabs. Each tab can have 50,000 rows and 702 columns, from A to
ZZ.

Sheet saves shortly after you stop editing. Ctrl/⌘ S saves immediately. Before
each save, the host calculates formulas with the existing spreadsheet engine.
Only cells, formats, and tab properties changed since the loaded revision are
sent; everything else stays as it was. A workbook can contain up to 8 MB of
UTF-8 content. If a save fails, your changes stay in the draft and Sheet tries
again. When retrying cannot help, such as when the file is too large or edit
access is gone, Sheet explains the problem and waits for another change.

If someone else saves first, Sheet combines both sets of changes. The later
save wins when both people changed the same cell, and Sheet tells you when a
recently saved cell was replaced. Undo restores the cells you changed even
after another person edits them.

Range edits from an agent keep typed inputs and last-calculated values. An
open editor recalculates formulas that depend on those edits when it saves.
Agent writes still follow the workspace approval policy. CSV downloads use
the saved values from the active sheet and protect against formula injection.
A full-workbook download keeps formulas, tabs, and styles. Sheet saves your
changes before either download.
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
