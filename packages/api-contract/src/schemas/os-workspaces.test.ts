import { describe, expect, it } from "vite-plus/test";
import {
	OsGadgetManifestSchema,
	OsGadgetManifestWriteSchema,
	OsOutputLibraryPreviewSchema,
} from "./os-workspaces";

describe("Built-in app manifest settings", () => {
	const source = {
		label: "Inbox",
		workspaceId: "11111111-1111-4111-8111-111111111111",
		cardSheetPrefix: "Inbox cards ",
		columns: {
			source: "Thread",
			why: "Why",
			useful: "Useful?",
			reason: "Reason",
			done: "Approve action?",
		},
		doIt: "approve",
	};

	it("rejects a card review write whose settings do not match", () => {
		const result = OsGadgetManifestWriteSchema.safeParse({
			entry: "tedix:app/card-review",
			config: { version: 1, sources: [{ ...source, doIt: "post" }] },
		});
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path).toEqual([
			"config",
			"sources",
			"0",
			"doIt",
		]);
	});

	it("accepts valid settings and keeps any stored settings on read", () => {
		const manifest = {
			entry: "tedix:app/card-review",
			config: { version: 1, sources: [source] },
		};
		expect(OsGadgetManifestWriteSchema.parse(manifest).config).toEqual(
			manifest.config,
		);
		expect(
			OsGadgetManifestSchema.parse({ ...manifest, config: { version: 9 } })
				.config,
		).toEqual({ version: 9 });
	});
});

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
