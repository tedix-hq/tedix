import { QueryClient } from "@tanstack/react-query";
import type { OsDocumentBlock } from "@tedix/api-contract/schemas/os-workspaces";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	buildOutputsWebMcpTools,
	documentBlocksToMarkdown,
	markdownToDocumentBlocks,
} from "@/components/outputs-webmcp-tools";
import { osApi } from "@/lib/api";
import { osQueryKeys, outputDetailQueryOptions } from "@/lib/os-query-options";
import { richTextFromBlocks } from "@/lib/output-models";
import type { ModelContextLike } from "@tedix/webmcp-core/model-context";
import {
	registerWebMcpScope,
	setModelContextResolverForTests,
	webMcpRegisteredToolNames,
} from "@tedix/webmcp-core/registry";

vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			outputs: {
				list: vi.fn(),
				get: vi.fn(),
				revise: vi.fn(),
				patchDocument: vi.fn(),
				patchSlides: vi.fn(),
				setSheetRange: vi.fn(),
			},
		},
	},
}));

// The tools module imports the app QueryClient singleton for its hook wiring;
// mocking it keeps the whole route tree out of this unit test.
vi.mock("@/router", () => ({ osQueryClient: {} }));

const outputsApi = osApi.osWorkspaces.outputs as unknown as {
	list: ReturnType<typeof vi.fn>;
	get: ReturnType<typeof vi.fn>;
	revise: ReturnType<typeof vi.fn>;
	patchDocument: ReturnType<typeof vi.fn>;
	patchSlides: ReturnType<typeof vi.fn>;
	setSheetRange: ReturnType<typeof vi.fn>;
};

function tools() {
	const queryClient = new QueryClient();
	const invalidateQueries = vi
		.spyOn(queryClient, "invalidateQueries")
		.mockResolvedValue(undefined);
	const built = buildOutputsWebMcpTools({ queryClient });
	const byName = new Map(built.map((tool) => [tool.name, tool]));
	return { built, byName, invalidateQueries };
}

const OUTPUT_ID = "3f6f0c8a-1d2e-4b3c-9a4d-5e6f7a8b9c0d";

const outputRow = {
	id: OUTPUT_ID,
	organizationId: "org-1",
	workspaceId: null,
	kind: "document",
	title: "Q3 plan",
	status: "active",
	currentRevisionId: "d1c2b3a4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
	createdByKind: "user",
	createdById: "u1",
	createdAt: "2026-08-26T00:00:00Z",
	updatedAt: "2026-08-26T01:00:00Z",
};

afterEach(() => {
	setModelContextResolverForTests(null);
	vi.clearAllMocks();
});

describe("buildOutputsWebMcpTools", () => {
	it("marks output content untrusted and CAS editors as writes", () => {
		const { byName } = tools();
		expect(byName.get("read_output")?.annotations).toEqual({
			readOnlyHint: true,
			untrustedContentHint: true,
		});
		expect(byName.get("patch_document")?.annotations).toEqual({
			readOnlyHint: false,
			untrustedContentHint: false,
		});
	});

	it("registers the six outputs tools on the WebMCP surface", () => {
		const context: ModelContextLike = { provideContext: () => {} };
		setModelContextResolverForTests(() => context);
		const dispose = registerWebMcpScope(
			"outputs",
			buildOutputsWebMcpTools({ queryClient: new QueryClient() }),
		);
		expect(webMcpRegisteredToolNames()).toEqual([
			"list_outputs",
			"read_output",
			"revise_output",
			"patch_document",
			"patch_slides",
			"set_sheet_range",
		]);
		dispose();
	});

	it("list_outputs maps compact rows with per-row deep links", async () => {
		outputsApi.list.mockResolvedValue({ items: [outputRow], truncated: false });
		const { byName } = tools();
		const result = await byName.get("list_outputs")!.execute({
			workspaceId: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a",
			limit: 10,
		});
		expect(outputsApi.list).toHaveBeenCalledWith({
			limit: 10,
			workspaceId: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a",
		});
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			items: [
				{
					id: OUTPUT_ID,
					title: "Q3 plan",
					kind: "document",
					status: "active",
					workspaceId: null,
					updatedAt: "2026-08-26T01:00:00Z",
					deepLink: `/outputs/${OUTPUT_ID}`,
				},
			],
			truncated: false,
		});
	});

	it("list_outputs clamps limit into 1..50 and defaults to 25", async () => {
		outputsApi.list.mockResolvedValue({ items: [], truncated: false });
		const { byName } = tools();
		await byName.get("list_outputs")!.execute({ limit: 999 });
		expect(outputsApi.list).toHaveBeenLastCalledWith({ limit: 50 });
		await byName.get("list_outputs")!.execute({});
		expect(outputsApi.list).toHaveBeenLastCalledWith({ limit: 25 });
	});

	it("read_output projects a document to markdown plus its CAS revision", async () => {
		const blocks: OsDocumentBlock[] = [
			{ type: "heading", level: 1, text: "Q3 plan" },
			{ type: "paragraph", text: "Ship it." },
			{ type: "list", ordered: false, items: ["a", "b"] },
		];
		outputsApi.get.mockResolvedValue({
			output: outputRow,
			currentRevision: {
				id: outputRow.currentRevisionId,
				revision: 3,
				note: "tightened scope",
				content: { kind: "document", blocks },
			},
		});
		const { byName } = tools();
		const result = await byName.get("read_output")!.execute({
			outputId: OUTPUT_ID,
		});
		expect(outputsApi.get).toHaveBeenCalledWith({ outputId: OUTPUT_ID });
		expect(result.structuredContent).toMatchObject({
			id: OUTPUT_ID,
			kind: "document",
			revision: 3,
			revisionNote: "tightened scope",
			contentMarkdown: "# Q3 plan\n\nShip it.\n\n- a\n- b",
			deepLink: `/outputs/${OUTPUT_ID}`,
		});
	});

	it("read_output projects a sheet as columns plus a bounded row preview with coordinates", async () => {
		const rows = Array.from({ length: 60 }, (_, i) => [`r${i}`, i]);
		outputsApi.get.mockResolvedValue({
			output: { ...outputRow, kind: "sheet" },
			currentRevision: {
				id: outputRow.currentRevisionId,
				revision: 1,
				note: null,
				content: { kind: "sheet", columns: ["Name", "Value"], rows },
			},
		});
		const { byName } = tools();
		const result = await byName.get("read_output")!.execute({
			outputId: OUTPUT_ID,
		});
		expect(result.structuredContent).toMatchObject({
			revision: 1,
			columns: ["Name", "Value"],
			rowCount: 60,
			rowsTruncated: true,
		});
		const structured = result.structuredContent as { rows: unknown[][] };
		expect(structured.rows).toHaveLength(50);
		expect(structured.rows[0]).toEqual(["r0", 0]);
		expect(result.structuredContent).not.toHaveProperty("contentMarkdown");
	});

	it("read_output projects a presentation as indexed slide outlines", async () => {
		outputsApi.get.mockResolvedValue({
			output: { ...outputRow, kind: "presentation" },
			currentRevision: {
				id: outputRow.currentRevisionId,
				revision: 2,
				note: null,
				content: {
					kind: "presentation",
					slides: [
						{ title: "Intro", bullets: ["hi"], notes: "welcome them" },
						{ title: "Plan", bullets: ["a", "b"] },
					],
					deck: { some: "heavy canvas state" },
				},
			},
		});
		const { byName } = tools();
		const result = await byName.get("read_output")!.execute({
			outputId: OUTPUT_ID,
		});
		expect(result.structuredContent).toMatchObject({
			revision: 2,
			slideCount: 2,
			slides: [
				{ index: 0, title: "Intro", bullets: ["hi"], notes: "welcome them" },
				{ index: 1, title: "Plan", bullets: ["a", "b"] },
			],
		});
		expect(result.structuredContent).not.toHaveProperty("content");
	});

	it("revise_output builds the document body the way the editor does, passes CAS fields, and invalidates the generated keys", async () => {
		outputsApi.revise.mockResolvedValue({
			output: outputRow,
			revision: { id: "rev-4", revision: 4 },
		});
		const { byName, invalidateQueries } = tools();
		const markdown = "# Q3 plan\n\nShip it.\n\n- a\n- b";
		const result = await byName.get("revise_output")!.execute({
			outputId: OUTPUT_ID,
			content: markdown,
			expectedRevision: 3,
			note: "agent edit",
		});

		const expectedBlocks = markdownToDocumentBlocks(markdown);
		expect(outputsApi.revise).toHaveBeenCalledWith({
			outputId: OUTPUT_ID,
			content: {
				kind: "document",
				blocks: expectedBlocks,
				richText: richTextFromBlocks(expectedBlocks),
			},
			expectedRevision: 3,
			note: "agent edit",
		});
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			outputId: OUTPUT_ID,
			revision: 4,
			deepLink: `/outputs/${OUTPUT_ID}`,
		});

		const invalidatedKeys = invalidateQueries.mock.calls.map(
			(call) => call[0]?.queryKey,
		);
		expect(invalidatedKeys).toContainEqual(
			outputDetailQueryOptions(OUTPUT_ID).queryKey,
		);
		expect(invalidatedKeys).toContainEqual(osQueryKeys.outputs());
	});

	it("revise_output maps a CAS conflict to re-read guidance without invalidating", async () => {
		outputsApi.revise.mockRejectedValue(
			Object.assign(
				new Error(
					"Output revision compare-and-swap lost against a concurrent revision write",
				),
				{ code: "CONFLICT" },
			),
		);
		const { byName, invalidateQueries } = tools();
		const result = await byName.get("revise_output")!.execute({
			outputId: OUTPUT_ID,
			content: "New body",
			expectedRevision: 2,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text.toLowerCase()).toContain("re-read");
		expect(invalidateQueries).not.toHaveBeenCalled();
	});

	it("surfaces an osApi rejection as an isError result, not a throw", async () => {
		outputsApi.revise.mockRejectedValue(
			new Error("Content body is document but the output is sheet"),
		);
		const { byName, invalidateQueries } = tools();
		const result = await byName.get("revise_output")!.execute({
			outputId: OUTPUT_ID,
			content: "New body",
			expectedRevision: 1,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("the output is sheet");
		expect(invalidateQueries).not.toHaveBeenCalled();
	});

	it("patch_slides passes ops and CAS fields through and invalidates the generated keys", async () => {
		outputsApi.patchSlides.mockResolvedValue({
			output: { ...outputRow, kind: "presentation" },
			revision: {
				id: "rev-5",
				revision: 5,
				content: {
					kind: "presentation",
					slides: [
						{ title: "Intro", bullets: [] },
						{ title: "New", bullets: ["x"] },
					],
				},
			},
		});
		const { byName, invalidateQueries } = tools();
		const ops = [
			{ op: "insert", index: 1, slide: { title: "New", bullets: ["x"] } },
			{ op: "move", from: 0, to: 1 },
		];
		const result = await byName.get("patch_slides")!.execute({
			outputId: OUTPUT_ID,
			ops,
			expectedRevision: 4,
			note: "agent slide edit",
		});
		expect(outputsApi.patchSlides).toHaveBeenCalledWith({
			outputId: OUTPUT_ID,
			ops,
			expectedRevision: 4,
			note: "agent slide edit",
		});
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			outputId: OUTPUT_ID,
			revision: 5,
			opsApplied: 2,
			slideCount: 2,
			deepLink: `/outputs/${OUTPUT_ID}`,
		});
		const invalidatedKeys = invalidateQueries.mock.calls.map(
			(call) => call[0]?.queryKey,
		);
		expect(invalidatedKeys).toContainEqual(
			outputDetailQueryOptions(OUTPUT_ID).queryKey,
		);
		expect(invalidatedKeys).toContainEqual(osQueryKeys.outputs());
	});

	it("patch_slides maps a CAS conflict to re-read guidance without invalidating", async () => {
		outputsApi.patchSlides.mockRejectedValue(
			Object.assign(new Error("revision compare-and-swap lost"), {
				code: "CONFLICT",
			}),
		);
		const { byName, invalidateQueries } = tools();
		const result = await byName.get("patch_slides")!.execute({
			outputId: OUTPUT_ID,
			ops: [{ op: "delete", index: 0 }],
			expectedRevision: 1,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text.toLowerCase()).toContain("re-read");
		expect(invalidateQueries).not.toHaveBeenCalled();
	});

	it("patch_slides surfaces a kind-mismatch rejection as an isError result", async () => {
		outputsApi.patchSlides.mockRejectedValue(
			new Error("Output is document, not presentation"),
		);
		const { byName } = tools();
		const result = await byName.get("patch_slides")!.execute({
			outputId: OUTPUT_ID,
			ops: [{ op: "delete", index: 0 }],
			expectedRevision: 1,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("not presentation");
	});

	it("patch_document builds real OsDocumentBlock shapes from simplified blocks", async () => {
		outputsApi.patchDocument.mockResolvedValue({
			output: outputRow,
			revision: {
				id: "rev-6",
				revision: 6,
				content: {
					kind: "document",
					blocks: [{ type: "paragraph", text: "x" }],
				},
			},
		});
		const { byName, invalidateQueries } = tools();
		const result = await byName.get("patch_document")!.execute({
			outputId: OUTPUT_ID,
			ops: [
				{
					op: "insert",
					index: 0,
					block: { kind: "heading", level: 3, text: "Risks" },
				},
				{
					op: "replace",
					index: 2,
					block: { kind: "list", ordered: true, items: ["one", "two"] },
				},
				{
					op: "insert",
					index: 3,
					block: { kind: "code", language: "ts", text: "const a = 1;" },
				},
				{ op: "insert", index: 4, block: { kind: "quote", text: "said so" } },
				{ op: "delete", index: 5 },
			],
			expectedRevision: 5,
		});
		const expectedBlocks: OsDocumentBlock[] = [
			{ type: "heading", level: 3, text: "Risks" },
			{ type: "list", ordered: true, items: ["one", "two"] },
			{ type: "code", language: "ts", text: "const a = 1;" },
			{ type: "quote", text: "said so" },
		];
		expect(outputsApi.patchDocument).toHaveBeenCalledWith({
			outputId: OUTPUT_ID,
			ops: [
				{ op: "insert", index: 0, block: expectedBlocks[0] },
				{ op: "replace", index: 2, block: expectedBlocks[1] },
				{ op: "insert", index: 3, block: expectedBlocks[2] },
				{ op: "insert", index: 4, block: expectedBlocks[3] },
				{ op: "delete", index: 5 },
			],
			expectedRevision: 5,
		});
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			revision: 6,
			opsApplied: 5,
			blockCount: 1,
			deepLink: `/outputs/${OUTPUT_ID}`,
		});
		expect(invalidateQueries).toHaveBeenCalled();
	});

	it("patch_document rejects a malformed block locally without calling the API", async () => {
		const { byName } = tools();
		const result = await byName.get("patch_document")!.execute({
			outputId: OUTPUT_ID,
			ops: [{ op: "insert", index: 0, block: { kind: "table", text: "nope" } }],
			expectedRevision: 1,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("block");
		expect(outputsApi.patchDocument).not.toHaveBeenCalled();
	});

	it("patch_document surfaces an API rejection as an isError result", async () => {
		outputsApi.patchDocument.mockRejectedValue(
			new Error("block index 9 out of range"),
		);
		const { byName, invalidateQueries } = tools();
		const result = await byName.get("patch_document")!.execute({
			outputId: OUTPUT_ID,
			ops: [{ op: "delete", index: 9 }],
			expectedRevision: 1,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("out of range");
		expect(invalidateQueries).not.toHaveBeenCalled();
	});

	it("set_sheet_range maps the rectangle through with CAS fields and invalidates", async () => {
		outputsApi.setSheetRange.mockResolvedValue({
			output: { ...outputRow, kind: "sheet" },
			revision: {
				id: "rev-7",
				revision: 7,
				content: {
					kind: "sheet",
					columns: ["A", "B"],
					rows: [
						["x", 1],
						["y", true],
					],
				},
			},
		});
		const { byName, invalidateQueries } = tools();
		const cells = [
			["x", 1],
			["y", true],
			[null, "z"],
		];
		const result = await byName.get("set_sheet_range")!.execute({
			outputId: OUTPUT_ID,
			startRow: 3,
			startColumn: 0,
			cells,
			expectedRevision: 6,
			note: "fill totals",
		});
		expect(outputsApi.setSheetRange).toHaveBeenCalledWith({
			outputId: OUTPUT_ID,
			startRow: 3,
			startColumn: 0,
			cells,
			expectedRevision: 6,
			note: "fill totals",
		});
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			outputId: OUTPUT_ID,
			revision: 7,
			rowsWritten: 3,
			rowCount: 2,
			deepLink: `/outputs/${OUTPUT_ID}`,
		});
		const invalidatedKeys = invalidateQueries.mock.calls.map(
			(call) => call[0]?.queryKey,
		);
		expect(invalidatedKeys).toContainEqual(
			outputDetailQueryOptions(OUTPUT_ID).queryKey,
		);
		expect(invalidatedKeys).toContainEqual(osQueryKeys.outputs());
	});

	it("set_sheet_range rejects an over-wide or over-tall rectangle without calling the API", async () => {
		const { byName } = tools();
		const wide = await byName.get("set_sheet_range")!.execute({
			outputId: OUTPUT_ID,
			startRow: 0,
			startColumn: 0,
			cells: [Array.from({ length: 65 }, () => "x")],
			expectedRevision: 1,
		});
		expect(wide.isError).toBe(true);
		expect(wide.content[0]?.text).toContain("64");
		const tall = await byName.get("set_sheet_range")!.execute({
			outputId: OUTPUT_ID,
			startRow: 0,
			startColumn: 0,
			cells: Array.from({ length: 201 }, () => ["x"]),
			expectedRevision: 1,
		});
		expect(tall.isError).toBe(true);
		expect(tall.content[0]?.text).toContain("200");
		const badCell = await byName.get("set_sheet_range")!.execute({
			outputId: OUTPUT_ID,
			startRow: 0,
			startColumn: 0,
			cells: [[{ nested: true }]],
			expectedRevision: 1,
		});
		expect(badCell.isError).toBe(true);
		expect(outputsApi.setSheetRange).not.toHaveBeenCalled();
	});

	it("set_sheet_range maps a CAS conflict to re-read guidance", async () => {
		outputsApi.setSheetRange.mockRejectedValue(
			Object.assign(new Error("revision compare-and-swap lost"), {
				code: "CONFLICT",
			}),
		);
		const { byName, invalidateQueries } = tools();
		const result = await byName.get("set_sheet_range")!.execute({
			outputId: OUTPUT_ID,
			startRow: 0,
			startColumn: 0,
			cells: [["x"]],
			expectedRevision: 2,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text.toLowerCase()).toContain("re-read");
		expect(invalidateQueries).not.toHaveBeenCalled();
	});

	it("the patch verbs require expectedRevision locally without calling the API", async () => {
		const { byName } = tools();
		for (const [name, args] of [
			["patch_slides", { ops: [{ op: "delete", index: 0 }] }],
			["patch_document", { ops: [{ op: "delete", index: 0 }] }],
			["set_sheet_range", { startRow: 0, startColumn: 0, cells: [["x"]] }],
		] as const) {
			const result = await byName.get(name)!.execute({
				outputId: OUTPUT_ID,
				...args,
			});
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("expectedRevision");
		}
		expect(outputsApi.patchSlides).not.toHaveBeenCalled();
		expect(outputsApi.patchDocument).not.toHaveBeenCalled();
		expect(outputsApi.setSheetRange).not.toHaveBeenCalled();
	});

	it("validates required args locally without calling the API", async () => {
		const { byName } = tools();
		const missingId = await byName.get("read_output")!.execute({});
		expect(missingId.isError).toBe(true);
		const missingRevision = await byName.get("revise_output")!.execute({
			outputId: OUTPUT_ID,
			content: "body",
		});
		expect(missingRevision.isError).toBe(true);
		expect(missingRevision.content[0]?.text).toContain("expectedRevision");
		const missingContent = await byName.get("revise_output")!.execute({
			outputId: OUTPUT_ID,
			expectedRevision: 1,
		});
		expect(missingContent.isError).toBe(true);
		expect(outputsApi.get).not.toHaveBeenCalled();
		expect(outputsApi.revise).not.toHaveBeenCalled();
	});
});

describe("markdown round trip", () => {
	it("round-trips the full block vocabulary losslessly", () => {
		const blocks: OsDocumentBlock[] = [
			{ type: "heading", level: 2, text: "Plan" },
			{ type: "paragraph", text: "Intro **kept literal**." },
			{ type: "list", ordered: true, items: ["first", "second"] },
			{ type: "list", ordered: false, items: ["x", "y"] },
			{ type: "code", language: "ts", text: "const a = 1;" },
			{ type: "quote", text: "line one\nline two" },
		];
		const markdown = documentBlocksToMarkdown(blocks);
		expect(markdownToDocumentBlocks(markdown)).toEqual(blocks);
	});

	it("parses an unfenced trailing code block and multi-line paragraphs", () => {
		expect(markdownToDocumentBlocks("```\nraw")).toEqual([
			{ type: "code", text: "raw" },
		]);
		expect(markdownToDocumentBlocks("one\ntwo\n\nthree")).toEqual([
			{ type: "paragraph", text: "one\ntwo" },
			{ type: "paragraph", text: "three" },
		]);
	});
});

describe("WebMCP execution cancellation", () => {
	it("forwards the browser AbortSignal to output reads", async () => {
		const controller = new AbortController();
		const { byName } = tools();
		await byName
			.get("list_outputs")!
			.execute({}, { signal: controller.signal });
		expect(outputsApi.list).toHaveBeenCalledWith(
			{ limit: 25 },
			{ signal: controller.signal },
		);
	});
});
