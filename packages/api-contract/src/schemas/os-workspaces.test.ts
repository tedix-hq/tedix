import { describe, expect, it } from "vite-plus/test";
import {
	OsGadgetManifestSchema,
	OsGadgetManifestWriteSchema,
	OsOutputLibraryPreviewSchema,
	OsBlueprintRequirementsSchema,
} from "./os-workspaces";

describe("Blueprint output slots", () => {
	it("rejects duplicate named slots and collisions with selected resources or legacy defaults", () => {
		const output = {
			gadget: "Editor",
			kind: "document",
			title: "Notes",
			slot: "notes",
		};
		for (const outputs of [
			[output, { ...output, title: "Other" }],
			[
				{ ...output, slot: "output_2" },
				{ gadget: "Editor", kind: "sheet", title: "Data" },
			],
		]) {
			expect(
				OsBlueprintRequirementsSchema.safeParse({ version: 1, outputs })
					.success,
			).toBe(false);
		}
		expect(
			OsBlueprintRequirementsSchema.safeParse({
				version: 1,
				outputs: [output],
				resources: [
					{
						slot: "notes",
						providerId: "tedix",
						resourceType: "output",
						label: "Notes",
					},
				],
			}).success,
		).toBe(false);
		expect(
			OsBlueprintRequirementsSchema.safeParse({
				version: 1,
				outputs: [{ ...output, slot: "Bad Slot" }],
			}).success,
		).toBe(false);
		expect(
			OsBlueprintRequirementsSchema.safeParse({
				version: 1,
				outputs: [{ ...output, kind: "video" }],
			}).success,
		).toBe(false);
	});
});

describe("Built-in app manifest settings", () => {
	it("preserves the Work start-app flag on a validated manifest revision", () => {
		const manifest = OsGadgetManifestWriteSchema.parse({
			entry: "tedix:app/decision-deck",
			navigation: { work: "deck", workDefault: true },
			config: { version: 1 },
		});
		expect(manifest.navigation).toEqual({ work: "deck", workDefault: true });
	});

	it("requires configured projects for the activity feed without constraining stored reads", () => {
		expect(
			OsGadgetManifestWriteSchema.safeParse({
				entry: "tedix:app/activity-feed",
				config: { version: 1, projects: [] },
			}).success,
		).toBe(false);
		expect(
			OsGadgetManifestWriteSchema.safeParse({
				entry: "tedix:app/activity-feed",
				config: {
					version: 1,
					projects: [
						{
							id: "11111111-1111-4111-8111-111111111111",
							label: "Pine Studio",
						},
					],
				},
			}).success,
		).toBe(true);
		expect(
			OsGadgetManifestSchema.safeParse({
				entry: "tedix:app/activity-feed",
				config: { version: 99 },
			}).success,
		).toBe(true);
	});
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

describe("Outbound review app", () => {
	it("validates configurable scope and filters on write, preserves old settings on read", () => {
		const manifest = {
			entry: "tedix:app/outbound-review",
			capabilities: [],
			navigation: { board: true },
			config: {
				version: 1,
				projectId: "33333333-3333-4333-8333-333333333333",
				limit: 25,
				initialStatus: "waiting_on_you",
			},
		};
		expect(OsGadgetManifestWriteSchema.parse(manifest)).toEqual(manifest);
		for (const config of [
			{ version: 2 },
			{ version: 1, limit: 1000 },
			{ version: 1, initialStatus: "approve_and_send" },
			{ version: 1, projectId: "other-tenant" },
		]) {
			expect(
				OsGadgetManifestWriteSchema.safeParse({ ...manifest, config }).success,
			).toBe(false);
			expect(
				OsGadgetManifestSchema.parse({ ...manifest, config }).config,
			).toEqual(config);
		}
	});
});
