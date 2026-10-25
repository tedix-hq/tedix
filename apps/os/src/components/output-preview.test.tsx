import type { OsOutputLibraryPreview } from "@tedix/api-contract/schemas/os-workspaces";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { OutputPreview } from "./output-preview";

const sheetPreview: Extract<OsOutputLibraryPreview, { kind: "sheet" }> = {
	kind: "sheet",
	columns: ["Revenue forecast", "Customer name", "Status"],
	rows: [
		[1200, "Acme", "Open"],
		[900, "Globex", "Review"],
	],
	rowCount: 12,
	columnCount: 3,
	sheetCount: 1,
};

describe("OutputPreview sheet previews", () => {
	it("keeps a minimum column width so narrow cards cannot crush headers", () => {
		const html = renderToStaticMarkup(<OutputPreview preview={sheetPreview} />);
		expect(html).toContain("repeat(3, minmax(4rem, 1fr))");
	});

	it("exposes each full column label as the header cell title", () => {
		const html = renderToStaticMarkup(<OutputPreview preview={sheetPreview} />);
		for (const column of sheetPreview.columns) {
			expect(html).toContain(`title="${column}"`);
		}
	});
});
