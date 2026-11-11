import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { createHash } from "node:crypto";
import { AppRuntimeFilesSchema } from "../schemas/os-app-runtime";
import { OsBlueprintDefinitionSchema } from "../schemas/os-workspaces";
import { normalizeOsOutputInput } from "../utils/os-document";
import {
	buildDocBlueprint,
	DOC_CLIENT_SOURCE,
	DOC_CLIENT_SHA256,
	DOC_SERVER_SOURCE,
} from "./doc-blueprint";
import { DOC_BLUEPRINT_VERSION } from "./office-editor-versions";

type Document = {
	kind: "document";
	blocks: Record<string, unknown>[];
	richText?: { type: "doc"; content: unknown[] };
};

function runtime(content: Document = { kind: "document", blocks: [] }) {
	let current = {
		output: { id: "document-output", title: "Project plan" },
		revision: { revision: 4, content },
	};
	const outputsRead = vi.fn(async () => structuredClone(current));
	const outputsWrite = vi.fn(async (_slot, input) => {
		if (input.expectedRevision !== current.revision.revision)
			throw new Error("Output revision changed");
		current = {
			...current,
			revision: {
				revision: current.revision.revision + 1,
				content: structuredClone(input.content),
			},
		};
		return { ok: true, revision: current.revision };
	});
	const outputsPatch = vi.fn(async (_slot, input) => {
		if (input.expectedRevision !== current.revision.revision)
			throw new Error("Output revision changed");
		for (const op of input.ops) {
			if (op.op === "insert")
				current.revision.content.blocks.splice(op.index, 0, op.block);
		}
		current.revision.revision++;
		return { ok: true, revision: current.revision };
	});
	// Evaluate the shipped module itself, without a separate test implementation.
	const App = new Function(
		DOC_SERVER_SOURCE.replace("export class App", "class App") +
			"\nreturn App;",
	)();
	const app = new App(
		new Proxy(
			{},
			{
				get: () => {
					throw new Error("App storage is unavailable");
				},
			},
		),
		{
			CONFIG: { version: 1, settings: { slot: "project_doc" } },
			TEDIX: { outputsRead, outputsWrite, outputsPatch },
		},
	);
	return { app, outputsRead, outputsWrite, outputsPatch };
}

describe("Doc blueprint", () => {
	it("pins a self-contained version-4 client with a checked digest and complete code under the runtime limit", () => {
		const files = buildDocBlueprint().gadgets[0]!.files!;
		expect(DOC_BLUEPRINT_VERSION).toBe(12);
		expect(createHash("sha256").update(DOC_CLIENT_SOURCE).digest("hex")).toBe(
			DOC_CLIENT_SHA256,
		);
		expect(AppRuntimeFilesSchema.parse(files)).toEqual(files);
		expect(
			Object.values(files).reduce((sum, text) => sum + text.length, 0),
		).toBeLessThanOrEqual(512_000);
		expect(DOC_CLIENT_SOURCE).toMatch(
			/Bundled license information|@license|Copyright/i,
		);
	});
	it("ships a portable runtime app with one canonical document slot", () => {
		const definition = buildDocBlueprint("project_doc");
		expect(OsBlueprintDefinitionSchema.parse(definition)).toEqual(definition);
		expect(definition.requirements?.outputs).toEqual([
			{
				gadget: "Doc",
				kind: "document",
				title: "Untitled document",
				slot: "project_doc",
			},
		]);
		const gadget = definition.gadgets[0]!;
		expect(gadget.manifest.config).toEqual({
			version: 1,
			settings: {
				slot: "project_doc",
				editor: "document-v4",
				blueprintVersion: 12,
			},
		});
		expect(gadget.manifest.resourceGrants).toEqual([
			{
				slot: "project_doc",
				operations: ["outputs.read", "outputs.write", "outputs.patch"],
			},
		]);
		expect(Object.keys(gadget.files!)).toEqual([
			"client.js",
			"server.js",
			"README.md",
		]);
		expect(
			gadget.manifest.operations?.map((op) => [
				op.name,
				op.effect,
				op.outputSlot,
			]),
		).toEqual([
			["readDocument", "read", "project_doc"],
			["replaceDocument", "write", "project_doc"],
			["editDocument", "write", "project_doc"],
			["exportMarkdown", "read", "project_doc"],
		]);
		expect(() => buildDocBlueprint("invalid-slot")).toThrow();
	});

	it("validates agent edit inputs with the same typed block operations", () => {
		const operations = buildDocBlueprint().gadgets[0]!.manifest.operations!;
		const edit = z.fromJSONSchema(
			operations.find((op) => op.name === "editDocument")!.input,
		);
		expect(
			edit.safeParse({
				expectedRevision: 1,
				ops: [
					{
						op: "insert",
						index: 0,
						block: { type: "paragraph", text: "Plan" },
					},
				],
			}).success,
		).toBe(true);
		expect(edit.safeParse({ expectedRevision: 0, ops: [] }).success).toBe(
			false,
		);
		expect(
			edit.safeParse({
				expectedRevision: 1,
				ops: [
					{
						op: "replace",
						index: 0,
						block: { type: "heading", level: 9, text: "Plan" },
					},
				],
			}).success,
		).toBe(false);
		const replace = z.fromJSONSchema(
			operations.find((op) => op.name === "replaceDocument")!.input,
		);
		expect(
			replace.safeParse({
				expectedRevision: 1,
				content: { kind: "sheet", blocks: [] },
			}).success,
		).toBe(false);
	});

	it("reads and writes through the canonical capability without app storage", async () => {
		const { app, outputsRead, outputsWrite } = runtime();
		expect((await app.readDocument({})).revision.revision).toBe(4);
		expect(outputsRead).toHaveBeenCalledWith("project_doc", {});
		const content = {
			kind: "document",
			blocks: [{ type: "paragraph", text: "Draft" }],
			richText: { type: "doc", content: [] },
		};
		const result = await app.replaceDocument({ content, expectedRevision: 4 });
		expect(outputsWrite).toHaveBeenCalledWith("project_doc", {
			content,
			expectedRevision: 4,
		});
		expect(result.revision).toEqual({ revision: 5, content });
	});

	it("keeps derived plain rich text editable and protects formatting outside the block editor", async () => {
		const normalized = normalizeOsOutputInput({
			kind: "document",
			blocks: [
				{ type: "paragraph", text: "Plan" },
				{ type: "heading", level: 2, text: "Scope" },
				{ type: "list", ordered: false, items: ["First", ""] },
				{ type: "checklist", items: [{ text: "Review", checked: false }] },
				{ type: "quote", text: "A quote" },
				{ type: "code", language: "", text: "const a = 1;" },
				{ type: "table", headers: ["Name"], rows: [["One"]] },
				{ type: "divider" },
				{ type: "callout", text: "Note" },
				{ type: "toggle", summary: "Details", text: "More" },
			],
		});
		if (normalized.kind !== "document") throw new Error("Expected document");
		expect(
			(await runtime(normalized).app.readDocument({})).blockEditingSupported,
		).toBe(true);
		const blank = normalizeOsOutputInput({ kind: "document", blocks: [] });
		if (blank.kind !== "document") throw new Error("Expected document");
		expect(
			(await runtime(blank).app.readDocument({})).blockEditingSupported,
		).toBe(true);
		const formatted = normalizeOsOutputInput("A **bold** word");
		if (formatted.kind !== "document") throw new Error("Expected document");
		expect(
			(await runtime(formatted).app.readDocument({})).blockEditingSupported,
		).toBe(false);
		const withAttrs = structuredClone(normalized);
		withAttrs.richText!.content[0]!.attrs = { textAlign: "center" };
		expect(
			(await runtime(withAttrs).app.readDocument({})).blockEditingSupported,
		).toBe(false);
	});

	it("propagates source access and revision failures without an alternate storage path", async () => {
		const { app, outputsRead, outputsWrite } = runtime();
		await expect(
			app.replaceDocument({
				content: { kind: "document", blocks: [] },
				expectedRevision: 3,
			}),
		).rejects.toThrow("Output revision changed");
		expect(outputsRead).not.toHaveBeenCalled();
		expect(outputsWrite).toHaveBeenCalledTimes(1);
		outputsRead.mockRejectedValueOnce(new Error("Source access denied"));
		await expect(app.readDocument({})).rejects.toThrow("Source access denied");
	});

	it("sends block patches with the selected slot and expected revision", async () => {
		const { app, outputsPatch } = runtime();
		const ops = [
			{
				op: "insert",
				index: 0,
				block: { type: "heading", level: 2, text: "Scope" },
			},
		];
		const result = await app.editDocument({ ops, expectedRevision: 4 });
		expect(outputsPatch).toHaveBeenCalledWith("project_doc", {
			kind: "document",
			ops,
			expectedRevision: 4,
		});
		expect(result.revision.content.blocks).toEqual([ops[0]!.block]);
		await expect(
			app.editDocument({ ops: [], expectedRevision: 5 }),
		).rejects.toThrow("Document edits");
		expect(outputsPatch).toHaveBeenCalledTimes(1);
	});

	it("exports saved semantic blocks with a safe code fence and source revision", async () => {
		const { app } = runtime({
			kind: "document",
			richText: { type: "doc", content: [] },
			blocks: [
				{ type: "heading", level: 2, text: "Scope" },
				{ type: "code", language: "md", text: "```literal```" },
				{ type: "table", headers: ["Name"], rows: [["A|B\nC"]] },
				{ type: "checklist", items: [{ text: "Review", checked: true }] },
			],
		});
		const result = await app.exportMarkdown({});
		expect(result).toMatchObject({
			outputId: "document-output",
			revision: 4,
			projection: "semantic_blocks",
			mimeType: "text/markdown",
		});
		expect(result.text).toContain("````md\n```literal```\n````");
		expect(result.text).toContain("A\\|B<br>C");
		expect(result.text).toContain("- [x] Review");
	});

	it("ships syntactically valid browser code", () => {
		const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
		expect(() => new AsyncFunction("tedix", DOC_CLIENT_SOURCE)).not.toThrow();
	});
});
