import { describe, expect, it } from "vite-plus/test";
import { OsOutputLibraryPreviewSchema } from "./os-workspaces";

describe("OS output library preview", () => {
	it("represents a server-denied source without carrying content", () => {
		const preview = OsOutputLibraryPreviewSchema.parse({
			kind: "unavailable",
			reason: "source_access_unavailable",
		});
		expect(preview).toEqual({
			kind: "unavailable",
			reason: "source_access_unavailable",
		});
		expect(JSON.stringify(preview)).not.toContain("content");
	});
});

import {
	OsOutputExportFormatSchema,
	osOutputExportFormatsForKind,
} from "./os-workspaces";

describe("portable output export formats", () => {
	it("projects document and sheet formats from the schema used by MCP", () => {
		for (const format of ["markdown", "html", "csv"])
			expect(OsOutputExportFormatSchema.parse(format)).toBe(format);
		expect(osOutputExportFormatsForKind("document")).toEqual([
			"pdf",
			"png",
			"docx",
			"markdown",
			"html",
		]);
		expect(osOutputExportFormatsForKind("sheet")).toEqual([
			"pdf",
			"png",
			"xlsx",
			"csv",
		]);
		expect(osOutputExportFormatsForKind("presentation")).toEqual([
			"pdf",
			"png",
			"pptx",
		]);
	});
});
