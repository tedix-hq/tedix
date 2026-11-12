import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import {
	OsBlueprintDefinitionSchema,
	type OsOutputContent,
} from "../schemas/os-workspaces";
import { applySheetRange } from "../utils/sheet-range";
import { sheetCsvText } from "../utils/sheet-csv";
import {
	buildSheetBlueprint,
	SHEET_CLIENT_SOURCE,
	SHEET_CLIENT_SHA256,
	SHEET_SERVER_SOURCE,
} from "./sheet-blueprint";

type Sheet = Extract<OsOutputContent, { kind: "sheet" }>;
function content(): Sheet {
	return {
		kind: "sheet",
		columns: ["Amount", "Double"],
		rows: [[3, 6]],
		workbook: {
			activeSheetId: "main",
			sheets: [
				{
					id: "main",
					name: "Budget",
					columns: [
						{ id: "a", label: "Amount", width: 130 },
						{ id: "b", label: "Double", width: 140 },
					],
					rows: [
						[
							{
								input: "3",
								value: 3,
								format: { bold: true, numberFormat: "currency" },
							},
							{ input: "=A1*2", value: 6 },
						],
					],
					frozenRows: 0,
					frozenColumns: 0,
				},
				{
					id: "archive",
					name: "Archive",
					columns: [{ id: "a", label: "Saved", width: 120 }],
					rows: [[{ input: "Keep", value: "Keep" }]],
					frozenRows: 0,
					frozenColumns: 0,
				},
			],
		},
	};
}
function runtime(initial = content()) {
	let current = {
		output: { id: "sheet", title: "Budget" },
		revision: { revision: 2, content: initial },
	};
	const outputsRead = vi.fn(async () => structuredClone(current));
	const outputsWrite = vi.fn(
		async (
			_slot: string,
			input: { content: Sheet; expectedRevision: number },
		) => {
			if (input.expectedRevision !== current.revision.revision)
				throw new Error("Revision conflict");
			current = {
				...current,
				revision: {
					revision: current.revision.revision + 1,
					content: structuredClone(input.content),
				},
			};
		},
	);
	const outputsPatch = vi.fn(
		async (
			_slot: string,
			input: {
				expectedRevision: number;
				startRow: number;
				startColumn: number;
				cells: Sheet["rows"];
			},
		) => {
			if (input.expectedRevision !== current.revision.revision)
				throw new Error("Revision conflict");
			current = {
				...current,
				revision: {
					revision: current.revision.revision + 1,
					content: applySheetRange(
						current.revision.content,
						input.startRow,
						input.startColumn,
						input.cells,
					),
				},
			};
		},
	);
	const App = new Function(
		SHEET_SERVER_SOURCE.replace("export class App", "class App") +
			"\nreturn App;",
	)();
	const app = new App(
		new Proxy(
			{},
			{
				get() {
					throw new Error("No app content storage");
				},
			},
		),
		{
			CONFIG: { version: 1, settings: { slot: "budget" } },
			TEDIX: { outputsRead, outputsWrite, outputsPatch },
		},
	);
	return { app, outputsRead, outputsWrite, outputsPatch };
}

describe("Sheet blueprint", () => {
	it("declares a portable real runtime app and typed canonical sheet operations", () => {
		const definition = buildSheetBlueprint("budget");
		expect(OsBlueprintDefinitionSchema.parse(definition)).toEqual(definition);
		expect(definition.requirements?.outputs).toEqual([
			{
				gadget: "Sheet",
				kind: "sheet",
				title: "Untitled sheet",
				slot: "budget",
			},
		]);
		expect(definition.gadgets[0]!.manifest.config).toEqual({
			version: 1,
			settings: { slot: "budget", blueprintVersion: 17 },
		});
		const operations = definition.gadgets[0]!.manifest.operations!;
		expect(
			operations.map((operation) => [
				operation.name,
				operation.effect,
				operation.outputSlot,
			]),
		).toEqual([
			["readSheet", "read", "budget"],
			["replaceSheet", "write", "budget"],
			["editSheet", "write", "budget"],
			["exportCsv", "read", "budget"],
		]);
		const edit = z.fromJSONSchema(
			operations.find((operation) => operation.name === "editSheet")!.input,
		);
		expect(
			edit.safeParse({
				startRow: 0,
				startColumn: 0,
				cells: [["=SUM(A1:A3)"]],
				expectedRevision: 2,
			}).success,
		).toBe(true);
		expect(
			edit.safeParse({
				startRow: -1,
				startColumn: 0,
				cells: [[1]],
				expectedRevision: 2,
			}).success,
		).toBe(false);
		expect(
			edit.safeParse({
				startRow: 0,
				startColumn: 0,
				cells: [],
				expectedRevision: 0,
			}).success,
		).toBe(false);
		expect(() => buildSheetBlueprint("bad-slot")).toThrow();
	});
	it("reads, replaces and patches the canonical output while preserving formulas, tabs and formats", async () => {
		const { app, outputsRead, outputsWrite, outputsPatch } = runtime();
		const read = await app.readSheet();
		expect(outputsRead).toHaveBeenCalledWith("budget", {});
		expect(read.revision.content.workbook.sheets[0].rows[0][1]).toEqual({
			input: "=A1*2",
			value: 6,
		});
		const edited = await app.editSheet({
			startRow: 0,
			startColumn: 0,
			cells: [[4]],
			expectedRevision: 2,
		});
		expect(outputsPatch).toHaveBeenCalledWith("budget", {
			kind: "sheet",
			startRow: 0,
			startColumn: 0,
			cells: [[4]],
			expectedRevision: 2,
		});
		expect(
			edited.revision.content.workbook.sheets[0].rows[0][0].format,
		).toEqual({ bold: true, numberFormat: "currency" });
		expect(edited.revision.content.workbook.sheets[0].rows[0][1]).toEqual({
			input: "=A1*2",
			value: 6,
		});
		expect(edited.revision.content.workbook.sheets[1]).toEqual(
			content().workbook!.sheets[1],
		);
		await expect(
			app.replaceSheet({ content: content(), expectedRevision: 2 }),
		).rejects.toThrow("Revision conflict");
		await app.replaceSheet({ content: content(), expectedRevision: 3 });
		expect(outputsWrite).toHaveBeenLastCalledWith("budget", {
			content: content(),
			expectedRevision: 3,
		});
	});
	it("propagates source-access denial without revealing another sheet", async () => {
		const { app, outputsRead } = runtime();
		outputsRead.mockRejectedValueOnce(
			new Error("Output source access unavailable"),
		);
		await expect(app.readSheet()).rejects.toThrow(
			"Output source access unavailable",
		);
	});
	it("exports saved active-sheet cached values with canonical CSV injection protection", async () => {
		const sheet = content();
		sheet.workbook!.sheets[0]!.rows[0]![0] = { input: "=bad", value: "=bad" };
		const { app } = runtime(sheet);
		const csv = await app.exportCsv();
		expect(csv.revision).toBe(2);
		expect(csv.text).toBe(
			sheetCsvText([
				["Amount", "Double"],
				["=bad", 6],
			]),
		);
		expect(csv.text).toBe("Amount,Double\r\n'=bad,6\r\n");
		expect(csv.text).not.toContain("Keep");
		expect(sheetCsvText([["a,b", 'a"b', "\nnext", -3, null, " @cmd"]])).toBe(
			'"a,b","a""b","\'\nnext",-3,,\' @cmd\r\n',
		);
	});
	it("ships bounded executable client source with generic scoped host operations", () => {
		expect(() => new Function(SHEET_CLIENT_SOURCE)).not.toThrow();
		expect(createHash("sha256").update(SHEET_CLIENT_SOURCE).digest("hex")).toBe(
			SHEET_CLIENT_SHA256,
		);
		for (const method of [
			"sheet.evaluate",
			"outputs.patch",
			"outputs.changes",
			"app.download",
			"app.exportOutput",
		])
			expect(SHEET_CLIENT_SOURCE).toContain(method);
		// The editor sends only what changed, never the whole workbook.
		expect(SHEET_CLIENT_SOURCE).not.toContain("outputs.replace");
		expect(SHEET_CLIENT_SOURCE).not.toContain("URL.createObjectURL");
	});
});
