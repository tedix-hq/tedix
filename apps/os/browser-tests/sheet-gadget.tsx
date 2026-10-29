import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { OutputContentView } from "../src/components/output-content";
import { SheetEditor } from "../src/components/output-editor-sheet";
import { CanvasWorkpieceTabs } from "../src/components/canvas-workpiece-tabs";
import type { SheetContent } from "../src/lib/output-models";
import "../src/styles.css";
import "../src/components/output-editor.css";
import "../src/components/output-detail.css";
import "../src/components/canvas-page.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "light";
const mode = params.get("mode") ?? "edit";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.mode = theme;
document.documentElement.dataset.theme = "tedix";

type Format = NonNullable<
	NonNullable<
		SheetContent["workbook"]
	>["sheets"][number]["rows"][number][number]
>["format"];

const cell = (input: string, format?: Format) => ({
	input,
	value: null,
	...(format ? { format } : {}),
});

/** A fictional bakery's quarter: text, money, counts, a percent and formulas. */
const headings = ["Week", "Revenue", "Orders", "Growth", "Notes"];
const revenue = [
	12450, 13120, 12980, 14210, 13870, 14630, 15020, 14410, 15880, 16240,
];
const notes: Record<number, string> = {
	1: "Weekend promotion on rye loaves",
	3: "Wholesale order from a café",
	8: "New sourdough line",
};
const rows = [
	...revenue.map((amount, index) => [
		`W${29 + index}`,
		String(amount),
		String(480 + ((index * 37) % 90)),
		index === 0 ? "" : `=B${index + 1}/B${index}-1`,
		notes[index] ?? "",
	]),
	[
		"Total",
		`=SUM(B1:B${revenue.length})`,
		`=SUM(C1:C${revenue.length})`,
		"",
		"",
	],
];

function formatFor(rowIndex: number, columnIndex: number): Format | undefined {
	if (rowIndex === rows.length - 1)
		return columnIndex === 1
			? { bold: true, numberFormat: "currency" }
			: { bold: true };
	if (columnIndex === 1) return { numberFormat: "currency" };
	if (columnIndex === 3) return { numberFormat: "percent", decimals: 1 };
	return undefined;
}

const populated: SheetContent = {
	kind: "sheet",
	columns: [],
	rows: [],
	workbook: {
		locale: "en-US",
		currency: "EUR",
		activeSheetId: "quarter",
		sheets: [
			{
				id: "quarter",
				name: "Quarter",
				columns: headings.map((label, index) => ({
					id: `quarter-${index}`,
					label,
					width: index === 4 ? 220 : 110,
				})),
				rows: rows.map((row, rowIndex) =>
					row.map((input, columnIndex) =>
						cell(input, formatFor(rowIndex, columnIndex)),
					),
				),
				frozenRows: 0,
				frozenColumns: 1,
			},
			{
				id: "suppliers",
				name: "Suppliers",
				columns: [{ id: "suppliers-0", label: "Supplier", width: 160 }],
				rows: [[cell("Mill & Grain")], [cell("=1/0")]],
				frozenRows: 0,
				frozenColumns: 0,
			},
		],
	},
};

const empty: SheetContent = { kind: "sheet", columns: [], rows: [] };

function Fixture() {
	const [value, setValue] = useState<SheetContent>(
		params.get("data") === "empty" ? empty : populated,
	);
	return (
		<main className="flex h-dvh min-w-0 flex-col bg-kumo-base text-kumo-default">
			{params.has("workspace") && (
				<div className="canvas-workpiece-bar">
					<CanvasWorkpieceTabs
						opened={[
							{ type: "gadget", id: "review" },
							{ type: "output", id: "sheet" },
						]}
						selectedKey="output:sheet"
						gadgets={[{ id: "review", name: "Quarter review" }]}
						outputs={[{ id: "sheet", title: "Quarter", kind: "sheet" }]}
						onClose={() => {}}
						onSelect={() => {}}
					/>
				</div>
			)}
			{mode === "view" ? (
				<div className="min-h-0 flex-1 overflow-auto p-2">
					<OutputContentView content={value as OsOutputContent} />
				</div>
			) : (
				<div
					className="output-detail-workshop flex min-h-0 flex-1 flex-col"
					data-output-kind="sheet"
				>
					<div className="output-workshop-stage">
						<SheetEditor value={value} onChange={setValue} />
					</div>
				</div>
			)}
			<output aria-label="Saved cells" hidden>
				{JSON.stringify(
					value.workbook?.sheets[0]?.rows
						.slice(0, 8)
						.map((row) => row.map((item) => item?.input ?? "")),
				)}
			</output>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<Fixture />);
