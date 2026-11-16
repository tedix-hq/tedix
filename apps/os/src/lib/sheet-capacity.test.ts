import { appendFileSync } from "node:fs";
import {
	applyOutputPatch,
	type OutputPatch,
} from "@tedix/api-contract/utils/output-patch";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { normalizeSheetContent, projectWorkbook } from "./output-models";
import { evaluateWorkbook } from "./workbook-formulas";
import {
	mountSheetClient,
	type SheetClientBridge,
} from "../gadgets/sheet-client";

/**
 * What the Sheet editor's own script costs at large sizes. It takes minutes,
 * so it runs only on request: `SHEET_CAPACITY=<file>` appends one JSON line
 * per size to that file. happy-dom does no layout or paint; the numbers are
 * script time and how much of the sheet is drawn. Results and what they mean:
 * `browser-tests/sheet-capacity-performance.md`.
 */
const results = process.env.SHEET_CAPACITY;
type Sheet = Extract<OsOutputContent, { kind: "sheet" }>;
/** `bare` stores only the sheet's shape: every row is empty. */
type Size = { rows: number; cols: number; bare?: boolean };
const sizes: Size[] = [
	{ rows: 30, cols: 10 },
	{ rows: 1000, cols: 64 },
	{ rows: 2000, cols: 64 },
	{ rows: 4000, cols: 64 },
	{ rows: 20000, cols: 10 },
	{ rows: 50000, cols: 4 },
	{ rows: 300, cols: 702 },
	{ rows: 2000, cols: 702, bare: true },
	{ rows: 10000, cols: 702, bare: true },
];
const log = (record: unknown) =>
	appendFileSync(results!, JSON.stringify(record) + "\n");
const columnName = (index: number) => {
	let name = "";
	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
		name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
	return name;
};
/** A plausible file: names, amounts, a formula every fourth row, half blank. */
function cellAt(row: number, column: number) {
	if (column === 0)
		return { input: `Item ${row + 1}`, value: `Item ${row + 1}` };
	if (column === 1) return { input: String(row * 7 + 13), value: row * 7 + 13 };
	if (column === 2 && row % 4 === 0)
		return { input: `=B${row + 1}*2`, value: (row * 7 + 13) * 2 };
	if (column !== 3 && (row + column) % 2 === 0)
		return {
			input: `r${row + 1}c${column + 1}`,
			value: `r${row + 1}c${column + 1}`,
		};
	return null;
}
const build = ({ rows, cols, bare }: Size) =>
	({
		kind: "sheet",
		columns: [],
		rows: [],
		workbook: {
			activeSheetId: "s1",
			sheets: [
				{
					id: "s1",
					name: "Sheet1",
					columns: Array.from({ length: cols }, (_, index) => ({
						id: `c${index}`,
						label: columnName(index),
						width: 100,
					})),
					rows: Array.from({ length: rows }, (_, row) =>
						bare
							? []
							: Array.from({ length: cols }, (_, column) =>
									cellAt(row, column),
								),
					),
					frozenRows: 0,
					frozenColumns: 0,
				},
			],
		},
	}) as unknown as Sheet;

const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
	document.querySelector<T>(selector)!;
const cell = (address: string) =>
	q<HTMLTableCellElement>(`td[aria-label="${address}"]`);
const display = (address: string) =>
	cell(address)?.querySelector("output")?.textContent;
function key(key: string, target: HTMLElement = q(".grid")) {
	target.dispatchEvent(
		new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
	);
}
function edit(address: string, value: string) {
	cell(address).dispatchEvent(
		new MouseEvent("mousedown", { bubbles: true, button: 0 }),
	);
	document.dispatchEvent(new MouseEvent("mouseup"));
	cell(address).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
	const input = q<HTMLInputElement>(".cell-edit");
	input.value = value;
	input.dispatchEvent(new Event("input"));
	key("Enter", input);
}
const time = (run: () => void) => {
	const start = performance.now();
	run();
	return performance.now() - start;
};
const median = (samples: number[]) =>
	+[...samples].sort((a, b) => a - b)[samples.length >> 1]!.toFixed(1);
/** Approximate: the collector runs when it likes unless the runner exposes it. */
const heap = () => {
	(globalThis as { gc?: () => void }).gc?.();
	return Math.round(process.memoryUsage().heapUsed / 1048576);
};
const wait = (check: () => void) =>
	vi.waitFor(check, { timeout: 120_000, interval: 5 });

let dispose: (() => unknown) | undefined;
afterEach(async () => {
	await dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
});

describe.runIf(results)("Sheet editor capacity", () => {
	for (const size of sizes)
		it(`${size.rows} x ${size.cols}${size.bare ? " bare" : ""}`, async () => {
			const record: Record<string, unknown> = { ...size };
			const heapBefore = heap();
			let saved = build(size);
			record.megabytes = +(JSON.stringify(saved).length / 1e6).toFixed(2);
			let revision = 1;
			const spent: Record<string, number[]> = {};
			const note = (name: string, ms: number) => (spent[name] ??= []).push(ms);
			const patches: number[] = [];
			const output = {
				id: "output",
				title: "Capacity",
				workspaceId: "workspace",
				kind: "sheet",
			};
			// The real host answers across a frame boundary, so every content
			// that crosses is copied, as postMessage would copy it.
			const call = async (method: string, args?: Record<string, unknown>) => {
				if (method === "context")
					return {
						role: "owner",
						workspaceId: "workspace",
						grants: [
							{ slot: "sheet", operations: ["outputs.read", "outputs.write"] },
						],
						settings: { slot: "sheet" },
					};
				if (method === "app.draft.read") return null;
				if (method === "app.draft.clear") return null;
				if (method === "app.draft.write") {
					note(
						"draftCopyMs",
						time(() => structuredClone(args!.content)),
					);
					return null;
				}
				if (method === "sheet.evaluate") {
					let content!: Sheet, result!: Sheet;
					note(
						"evaluateCopyMs",
						time(() => (content = structuredClone(args!.content as Sheet))),
					);
					note(
						"evaluateMs",
						time(
							() =>
								(result = projectWorkbook(
									evaluateWorkbook(normalizeSheetContent(content).workbook!),
								)),
						),
					);
					note(
						"evaluateCopyMs",
						time(() => structuredClone(result)),
					);
					return result;
				}
				if (method === "outputs.patch") {
					const { patch } = args as { patch: OutputPatch };
					patches.push(JSON.stringify(patch).length);
					note(
						"applyPatchMs",
						time(() => (saved = applyOutputPatch(saved, patch) as Sheet)),
					);
					revision++;
					return {
						output,
						revision: { revision },
						mergedWith: null,
						catchUp: null,
					};
				}
				if (method === "outputs.readRevision") {
					let content!: Sheet;
					note(
						"readCopyMs",
						time(() => (content = structuredClone(saved))),
					);
					return { output, revision: { revision, content } };
				}
				throw new Error(`Unknown host operation ${method}`);
			};
			document.body.innerHTML = '<div id="app"></div>';
			let start = performance.now();
			const mounted = await mountSheetClient(q("#app"), {
				call,
			} as SheetClientBridge);
			dispose = () => mounted.dispose();
			await wait(() => expect(cell("A1")).toBeTruthy());
			record.openMs = Math.round(performance.now() - start);
			const drawn = () => ({
				nodes: document.querySelectorAll("*").length,
				rows: document.querySelectorAll("tbody tr:not([aria-hidden])").length,
				cells: document.querySelectorAll("td[data-row]").length,
			});
			record.drawn = drawn();

			// Arrow keys: how long each one holds the main thread.
			q(".grid").focus();
			const arrows: number[] = [];
			for (let step = 0; step < 10; step++)
				arrows.push(time(() => key(step % 2 ? "ArrowRight" : "ArrowDown")));
			record.arrowMs = median(arrows);

			// Jump to the last cell and back: the far end is drawn on demand.
			const last = `${columnName(size.cols - 1)}${size.rows}`;
			const jump = (address: string) => {
				const box = q<HTMLInputElement>("#range");
				box.value = address;
				key("Enter", box);
			};
			start = performance.now();
			jump(last);
			await wait(() => expect(cell(last)).toBeTruthy());
			record.jumpToEndMs = Math.round(performance.now() - start);
			record.drawnAtEnd = drawn();
			jump("A1");
			await wait(() => expect(cell("D1")).toBeTruthy());

			// Type into an empty cell. `block` is how long Enter holds the main
			// thread; `saved` is Enter to the save's answer.
			const block: number[] = [],
				savedAfter: number[] = [];
			for (let sample = 0; sample < 5; sample++) {
				const before = revision;
				start = performance.now();
				block.push(time(() => edit(`D${sample + 1}`, `v${sample}`)));
				await wait(() => expect(revision).toBeGreaterThan(before));
				savedAfter.push(performance.now() - start);
			}
			record.typeBlockMs = median(block);
			record.typeSavedMs = median(savedAfter);
			if (!size.bare) {
				// Change a number a formula reads: Enter to the new result.
				const recalc: number[] = [];
				for (let sample = 0; sample < 3; sample++) {
					start = performance.now();
					edit("B1", String(50 + sample));
					await wait(() =>
						expect(display("C1")).toBe(String(100 + sample * 2)),
					);
					recalc.push(performance.now() - start);
				}
				record.recalcShownMs = median(recalc);
			}
			record.patchBytes = median(patches);
			for (const [name, samples] of Object.entries(spent))
				record[name] = median(samples);
			record.heapAtEndMB = heap() - heapBefore;
			log(record);
		}, 600_000);

	// What the calculation the editor asks for after each edit makes of a
	// sheet that stores only its shape.
	for (const rows of [5000, 20000])
		it(`calculate ${rows} x 702 bare`, () => {
			const record: Record<string, unknown> = { calculate: `${rows} x 702` };
			const content = build({ rows, cols: 702, bare: true });
			let result!: Sheet;
			record.calculateMs = Math.round(
				time(
					() =>
						(result = projectWorkbook(
							evaluateWorkbook(normalizeSheetContent(content).workbook!),
						)),
				),
			);
			record.megabytesAfter = +(JSON.stringify(result).length / 1e6).toFixed(2);
			log(record);
		}, 600_000);
});
