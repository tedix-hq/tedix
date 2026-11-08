import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	SHEET_CLIENT_SOURCE,
	SHEET_SERVER_SOURCE,
} from "@tedix/api-contract/assets/sheet-blueprint";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { normalizeSheetContent, projectWorkbook } from "./output-models";
import { evaluateWorkbook } from "./workbook-formulas";

type Sheet = Extract<OsOutputContent, { kind: "sheet" }>;
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

async function editor(role = "owner") {
	document.body.innerHTML = '<div id="app"></div>';
	const calculate = (content: Sheet) =>
		projectWorkbook(evaluateWorkbook(normalizeSheetContent(content).workbook!));
	let saved = calculate({
		kind: "sheet",
		columns: ["Amount", "Rate", "Total"],
		rows: [[1, 2, "=SUM(A1:B1)"]],
	});
	const sheet = saved.workbook!.sheets[0]!;
	sheet.rows[0]![0]!.format = {
		bold: true,
		numberFormat: "currency",
		fillColor: "#eeeeee",
	};
	sheet.columns[0]!.width = 180;
	saved.workbook!.sheets.push({
		...structuredClone(sheet),
		id: "archive",
		name: "Archive",
	});
	let revision = 1;
	const outputsRead = vi.fn(async () => ({
		output: { id: "output", title: "Budget" },
		revision: { revision, content: structuredClone(saved) },
	}));
	const outputsWrite = vi.fn(
		async (
			_slot: string,
			input: { content: Sheet; expectedRevision: number },
		) => {
			if (input.expectedRevision !== revision)
				throw new Error("Revision conflict");
			saved = structuredClone(input.content);
			revision++;
		},
	);
	const App = new Function(
		SHEET_SERVER_SOURCE.replace("export class App", "class App") +
			"\nreturn App;",
	)();
	const app = new App(
		{},
		{
			CONFIG: { version: 1, settings: { slot: "sheet" } },
			TEDIX: { outputsRead, outputsWrite },
		},
	);
	const download = vi.fn();
	const call = vi.fn(async (method: string, args?: Record<string, unknown>) => {
		if (method === "context") return { role, settings: { slot: "sheet" } };
		if (method === "sheet.evaluate") return calculate(args!.content as Sheet);
		if (method === "app.download") {
			download(args);
			return null;
		}
		if (method === "app.call")
			return app[args!.method as string](...(args!.args as unknown[]));
		throw new Error("Unknown host operation");
	});
	let onMessage: EventListener | undefined;
	const add = window.addEventListener.bind(window);
	vi.spyOn(window, "addEventListener").mockImplementation(
		(name, listener, options) => {
			if (name === "message") onMessage = listener as EventListener;
			add(name, listener, options);
		},
	);
	await new Function(
		"tedix",
		`return (async()=>{${SHEET_CLIENT_SOURCE}\n})();`,
	)({ call });
	cleanups.push(() => {
		if (onMessage) window.removeEventListener("message", onMessage);
	});
	return {
		outputsWrite,
		download,
		saved: () => structuredClone(saved),
		revision: () => revision,
		changeExternal(value: number) {
			saved.workbook!.sheets[0]!.rows[0]![0]!.input = String(value);
			saved = calculate(saved);
			revision++;
			window.dispatchEvent(
				new MessageEvent("message", {
					source: window.parent,
					data: {
						jsonrpc: "2.0",
						method: "tedix/outputs-changed",
						params: {
							outputs: [
								{
									slot: "sheet",
									outputId: "output",
									revisionId: `r${revision}`,
									revision,
								},
							],
						},
					},
				}),
			);
		},
	};
}

function cell(address: string) {
	return document.querySelector<HTMLInputElement>(`[aria-label="${address}"]`)!;
}
function edit(address: string, value: string) {
	const input = cell(address);
	input.value = value;
	input.dispatchEvent(new Event("input"));
	input.dispatchEvent(new Event("change"));
}
function value(column: number) {
	return document.querySelector(`output[data-row="0"][data-column="${column}"]`)
		?.textContent;
}
function click(id: string) {
	document.querySelector<HTMLButtonElement>(id)!.click();
}

describe("Sheet grid pilot", () => {
	it("reuses workbook formulas and saves their source, calculated values, other tabs and formats", async () => {
		const app = await editor();
		const archive = app.saved().workbook!.sheets[1];
		expect(value(2)).toBe("3");
		edit("A1", "5");
		await vi.waitFor(() => expect(value(2)).toBe("7"));
		// Editing again after an async calculation must target the current draft.
		edit("B1", "4");
		await vi.waitFor(() => expect(value(2)).toBe("9"));
		edit("C1", "=A1*B1");
		await vi.waitFor(() => expect(value(2)).toBe("20"));
		click("#save");
		await vi.waitFor(() => expect(app.revision()).toBe(2));
		expect(app.saved().rows[0]).toEqual([5, 4, 20]);
		expect(app.saved().workbook!.sheets[0]!.rows[0]![2]!.input).toBe("=A1*B1");
		expect(app.saved().workbook!.sheets[0]!.rows[0]![0]!.format).toEqual({
			bold: true,
			numberFormat: "currency",
			fillColor: "#eeeeee",
		});
		expect(app.saved().workbook!.sheets[0]!.columns[0]!.width).toBe(180);
		expect(app.saved().workbook!.sheets[1]).toEqual(archive);
		click("#export");
		await vi.waitFor(() => expect(app.download).toHaveBeenCalled());
		expect(app.download).toHaveBeenCalledWith({
			filename: "Budget.csv",
			mimeType: "text/csv;charset=utf-8",
			text: "Amount,Rate,Total\r\n5,4,20\r\n",
		});
	});
	it("refreshes a clean grid, preserves a dirty conflict, then reloads only after explicit discard", async () => {
		const app = await editor();
		app.changeExternal(3);
		await vi.waitFor(() => expect(cell("A1").value).toBe("3"));
		edit("A1", "8");
		await vi.waitFor(() => expect(value(2)).toBe("10"));
		const field = cell("A1");
		app.changeExternal(4);
		expect(cell("A1")).toBe(field);
		expect(field.value).toBe("8");
		expect(document.querySelector("#updates")?.textContent).toContain(
			"Your unsaved edits are preserved",
		);
		click("#save");
		await vi.waitFor(() =>
			expect(document.querySelector(".status")?.textContent).toContain(
				"Revision conflict",
			),
		);
		expect(app.saved().rows[0]![0]).toBe(4);
		expect(cell("A1").value).toBe("8");
		click("#reload");
		expect(cell("A1").value).toBe("8");
		click("#reload");
		await vi.waitFor(() => expect(cell("A1").value).toBe("4"));
		expect(document.querySelector("#updates")?.textContent).toBe("");
	});
	it("saves edited headers and added rows and columns through the evaluated workbook", async () => {
		const app = await editor();
		click("#add-column");
		const header = document.querySelector<HTMLInputElement>(
			'[aria-label="Column D title"]',
		)!;
		header.value = "Notes";
		header.dispatchEvent(new Event("input"));
		edit("D2", "Review");
		await vi.waitFor(() =>
			expect(
				document.querySelector('output[data-row="1"][data-column="3"]')
					?.textContent,
			).toBe("Review"),
		);
		click("#add-row");
		click("#save");
		await vi.waitFor(() => expect(app.revision()).toBe(2));
		expect(app.saved().columns).toEqual(["Amount", "Rate", "Total", "Notes"]);
		expect(app.saved().rows).toHaveLength(3);
		expect(app.saved().rows[1]![3]).toBe("Review");
	});
	it("keeps use-role sessions read-only", async () => {
		const app = await editor("use");
		const tabs = document.querySelector<HTMLSelectElement>("#tabs")!;
		expect(tabs.disabled).toBe(false);
		tabs.value = "archive";
		tabs.dispatchEvent(new Event("change"));
		await vi.waitFor(() => expect(tabs.value).toBe("archive"));
		expect(app.outputsWrite).not.toHaveBeenCalled();
		expect(cell("A1").disabled).toBe(true);
		expect(document.querySelector<HTMLButtonElement>("#save")!.disabled).toBe(
			true,
		);
	});
});
