import type { QueryClient } from "@tanstack/react-query";
// The contract module is pure zod/oRPC metadata — safe at module scope (the
// import-inertness rule bans only the app-bootstrap modules).
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import type {
	OsDocumentBlock,
	OsOutputContent,
} from "@tedix/api-contract/schemas/os-workspaces";
// Pure module: only type imports in its chain — safe at module scope.
import { richTextFromBlocks } from "@/lib/output-models";
import type {
	WebMcpToolDef,
	WebMcpToolExecuteOptions,
	WebMcpToolResult,
} from "@tedix/webmcp-core/model-context";
import { webMcpError, webMcpResult } from "@tedix/webmcp-core/model-context";
import { toWebMcpFailure } from "@/components/webmcp-execute";
import {
	contractInputSchema,
	deriveToolSchema,
} from "@/lib/webmcp/derive-schema";
import { useWebMcpTools } from "@/lib/webmcp/use-webmcp-tools";
import { errorMessage } from "@tedix/worker-kit/error-message";

/**
 * WebMCP tools for workspace Outputs: an in-page browser agent can list the
 * same durable revisioned deliverables the human sees in the Outputs library,
 * read one as an editable markdown projection, and record a new revision
 * through the canonical CAS write path (`outputs.revise` with
 * `expectedRevision`). Successful writes invalidate the generated query keys.
 * They do not merge or acknowledge the workspace editor's live draft: an edited
 * room preserves its draft and requires review when a new saved version arrives.
 * Prefer collaboration proposals discovered through Code Mode for workspace edits.
 *
 * Full-body revision writes stay document-only on purpose: the document block
 * vocabulary (heading/paragraph/list/code/quote) supports a markdown projection;
 * replacing it can discard richer formatting absent from that projection.
 * Sheets and presentations are edited through the finer-grained
 * patch verbs instead — patch_slides, patch_document, and set_sheet_range —
 * which share the identical CAS write path; videos stay read-only.
 */

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 50;
const MAX_PATCH_OPS = 100;
const MAX_SHEET_COLUMNS = 64;
const MAX_SHEET_ROWS = 1_000;
const MAX_SHEET_RANGE_ROWS = 200;
const SHEET_PREVIEW_ROWS = 50;

type OutputsApi =
	(typeof import("@/lib/api"))["osApi"]["osWorkspaces"]["outputs"];
type OutputsListInput = NonNullable<Parameters<OutputsApi["list"]>[0]>;
type PatchSlidesInput = NonNullable<Parameters<OutputsApi["patchSlides"]>[0]>;
type PatchDocumentInput = NonNullable<
	Parameters<OutputsApi["patchDocument"]>[0]
>;
type DocumentPatchOp = PatchDocumentInput["ops"][number];
type SetSheetRangeInput = NonNullable<
	Parameters<OutputsApi["setSheetRange"]>[0]
>;
type SheetCell = SetSheetRangeInput["cells"][number][number];

export interface OutputsWebMcpDeps {
	/** Test seam; production resolves the app singleton at execute time. */
	queryClient?: QueryClient;
}

interface OutputsWebMcpRuntime {
	osApi: (typeof import("@/lib/api"))["osApi"];
	outputDetailQueryOptions: (typeof import("@/lib/os-query-options"))["outputDetailQueryOptions"];
	osQueryKeys: (typeof import("@/lib/os-query-options"))["osQueryKeys"];
	osQueryClient: QueryClient;
}

/**
 * The app modules the tools call into, loaded at execute time. Static value
 * imports of `@/lib/api`, `@/lib/os-query-options`, or `@/router` would drag
 * `window.location` reads and the whole generated route tree into every test
 * environment that imports a component using this hook — the narrow router
 * mocks in output-detail.test.tsx and outputs-page.test.tsx cannot satisfy
 * that. `vi.mock` still intercepts these dynamic imports, so tests keep their
 * seams.
 */
let runtimePromise: Promise<OutputsWebMcpRuntime> | null = null;

const clientOptions = (options?: WebMcpToolExecuteOptions) =>
	options?.signal ? ([{ signal: options.signal }] as const) : ([] as const);

function loadRuntime(): Promise<OutputsWebMcpRuntime> {
	runtimePromise ??= Promise.all([
		import("@/lib/api"),
		import("@/lib/os-query-options"),
		import("@/router"),
	]).then(([api, queryOptions, router]) => ({
		osApi: api.osApi,
		outputDetailQueryOptions: queryOptions.outputDetailQueryOptions,
		osQueryKeys: queryOptions.osQueryKeys,
		osQueryClient: router.osQueryClient,
	}));
	return runtimePromise;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function outputDeepLink(id: string): string {
	return `/outputs/${id}`;
}

function isRevisionConflict(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return code === "CONFLICT" || /conflict/i.test(errorMessage(error));
}

/** Shared failure mapping for every CAS revision write. */
function revisionWriteError(error: unknown): WebMcpToolResult {
	if (isRevisionConflict(error)) {
		return webMcpError(
			`Revision conflict — someone saved a newer revision, so nothing was written. Re-read the output with read_output to get the fresh revision, reapply your edit, and revise again. (${errorMessage(error)})`,
		);
	}
	return toWebMcpFailure(error);
}

function requiredRevision(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 1
		? value
		: null;
}

const MISSING_EXPECTED_REVISION =
	"expectedRevision is required: call read_output and pass its `revision` value";

function nonNegativeInt(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: null;
}

/** Invalidate the two generated keys every successful output write refreshes. */
async function invalidateOutputQueries(
	runtime: OutputsWebMcpRuntime,
	deps: OutputsWebMcpDeps,
	outputId: string,
): Promise<void> {
	const queryClient = deps.queryClient ?? runtime.osQueryClient;
	await Promise.all([
		queryClient.invalidateQueries({
			queryKey: runtime.outputDetailQueryOptions(outputId).queryKey,
		}),
		queryClient.invalidateQueries({ queryKey: runtime.osQueryKeys.outputs() }),
	]);
}

/** Project the stable document block vocabulary to editable markdown. */
export function documentBlocksToMarkdown(
	blocks: readonly OsDocumentBlock[],
): string {
	return blocks
		.map((block) => {
			switch (block.type) {
				case "heading":
					return `${"#".repeat(block.level)} ${block.text}`;
				case "paragraph":
					return block.text;
				case "list":
					return block.items
						.map((item, index) =>
							block.ordered ? `${index + 1}. ${item}` : `- ${item}`,
						)
						.join("\n");
				case "code":
					return `\`\`\`${block.language ?? ""}\n${block.text}\n\`\`\``;
				case "quote":
					return block.text
						.split("\n")
						.map((line) => `> ${line}`)
						.join("\n");
			}
		})
		.join("\n\n");
}

const STRUCTURAL_LINE = /^(#{1,4}\s|```|>\s?|[-*]\s+|\d+[.)]\s+)/;
const BULLET_ITEM = /^[-*]\s+/;
const ORDERED_ITEM = /^\d+[.)]\s+/;

/**
 * Parse markdown back into the same block vocabulary
 * {@link documentBlocksToMarkdown} emits, mirroring the schema's bounds the
 * way `blocksFromRichText` does. Inline formatting stays literal text —
 * exactly how the editor's block projection stores it.
 */
export function markdownToDocumentBlocks(markdown: string): OsDocumentBlock[] {
	const blocks: OsDocumentBlock[] = [];
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	let index = 0;
	while (index < lines.length && blocks.length < 500) {
		const line = lines[index]!;
		if (line.trim() === "") {
			index += 1;
			continue;
		}
		const fence = line.match(/^```(\S*)\s*$/);
		if (fence) {
			index += 1;
			const code: string[] = [];
			while (index < lines.length && !/^```\s*$/.test(lines[index]!)) {
				code.push(lines[index]!);
				index += 1;
			}
			index += 1; // closing fence (or end of input)
			blocks.push({
				type: "code",
				...(fence[1] ? { language: fence[1].slice(0, 60) } : {}),
				text: code.join("\n").slice(0, 40_000),
			});
			continue;
		}
		const heading = line.match(/^(#{1,4})\s+(.*)$/);
		if (heading) {
			blocks.push({
				type: "heading",
				level: heading[1]!.length,
				text: heading[2]!.trim().slice(0, 2_000),
			});
			index += 1;
			continue;
		}
		if (/^>\s?/.test(line)) {
			const quote: string[] = [];
			while (index < lines.length && /^>\s?/.test(lines[index]!)) {
				quote.push(lines[index]!.replace(/^>\s?/, ""));
				index += 1;
			}
			blocks.push({ type: "quote", text: quote.join("\n").slice(0, 20_000) });
			continue;
		}
		if (BULLET_ITEM.test(line) || ORDERED_ITEM.test(line)) {
			const ordered = ORDERED_ITEM.test(line);
			const marker = ordered ? ORDERED_ITEM : BULLET_ITEM;
			const items: string[] = [];
			while (index < lines.length && marker.test(lines[index]!)) {
				items.push(lines[index]!.replace(marker, "").trim().slice(0, 2_000));
				index += 1;
			}
			blocks.push({ type: "list", ordered, items: items.slice(0, 200) });
			continue;
		}
		const paragraph: string[] = [line];
		index += 1;
		while (
			index < lines.length &&
			lines[index]!.trim() !== "" &&
			!STRUCTURAL_LINE.test(lines[index]!)
		) {
			paragraph.push(lines[index]!);
			index += 1;
		}
		blocks.push({
			type: "paragraph",
			text: paragraph.join("\n").slice(0, 20_000),
		});
	}
	return blocks;
}

/**
 * Convert patch_document's simplified block shape ({ kind, text/items, … })
 * into a real OsDocumentBlock, applying the exact truncation bounds
 * {@link markdownToDocumentBlocks} applies — the module's one
 * block-construction path, just fed structured fields instead of markdown
 * lines. Returns null for a shape that is not one of the five block kinds.
 */
function simplifiedBlockToDocumentBlock(
	value: unknown,
): OsDocumentBlock | null {
	if (typeof value !== "object" || value === null) return null;
	const block = value as Record<string, unknown>;
	const text = typeof block["text"] === "string" ? block["text"] : "";
	switch (block["kind"]) {
		case "heading": {
			if (text.trim() === "") return null;
			const rawLevel =
				typeof block["level"] === "number" ? Math.trunc(block["level"]) : 2;
			return {
				type: "heading",
				level: Math.min(Math.max(rawLevel, 1), 4),
				text: text.trim().slice(0, 2_000),
			};
		}
		case "paragraph":
			if (text === "") return null;
			return { type: "paragraph", text: text.slice(0, 20_000) };
		case "list": {
			const items = Array.isArray(block["items"])
				? block["items"].filter(
						(item): item is string => typeof item === "string",
					)
				: [];
			if (items.length === 0) return null;
			return {
				type: "list",
				ordered: block["ordered"] === true,
				items: items.slice(0, 200).map((item) => item.trim().slice(0, 2_000)),
			};
		}
		case "code": {
			const language = optionalString(block["language"]);
			return {
				type: "code",
				...(language ? { language: language.slice(0, 60) } : {}),
				text: text.slice(0, 40_000),
			};
		}
		case "quote":
			if (text === "") return null;
			return { type: "quote", text: text.slice(0, 20_000) };
		default:
			return null;
	}
}

/** Parse patch_document's ops into real contract ops; string on failure. */
function parseDocumentOps(value: unknown): DocumentPatchOp[] | string {
	if (!Array.isArray(value) || value.length === 0) {
		return "ops is required: a non-empty array of insert/replace/delete block operations";
	}
	if (value.length > MAX_PATCH_OPS) {
		return `ops has ${value.length} operations — apply at most ${MAX_PATCH_OPS} per call`;
	}
	const ops: DocumentPatchOp[] = [];
	for (const [opIndex, raw] of value.entries()) {
		if (typeof raw !== "object" || raw === null) {
			return `ops[${opIndex}] must be an object with an \`op\` field`;
		}
		const entry = raw as Record<string, unknown>;
		const index = nonNegativeInt(entry["index"]);
		if (index === null) {
			return `ops[${opIndex}].index must be a non-negative integer block index`;
		}
		const op = entry["op"];
		if (op === "delete") {
			ops.push({ op, index });
			continue;
		}
		if (op === "insert" || op === "replace") {
			const block = simplifiedBlockToDocumentBlock(entry["block"]);
			if (!block) {
				return `ops[${opIndex}].block must be a simplified block — { kind: "heading"|"paragraph"|"list"|"code"|"quote" } with its text (or items for a list)`;
			}
			ops.push({ op, index, block });
			continue;
		}
		return `ops[${opIndex}].op must be "insert", "replace", or "delete"`;
	}
	return ops;
}

/** Validate set_sheet_range's rectangle client-side; string on failure. */
function parseSheetCells(value: unknown): SheetCell[][] | string {
	if (!Array.isArray(value) || value.length === 0) {
		return "cells is required: a non-empty 2-D array — rows of string|number|boolean|null cells";
	}
	if (value.length > MAX_SHEET_RANGE_ROWS) {
		return `cells has ${value.length} rows — write at most ${MAX_SHEET_RANGE_ROWS} rows per call (split larger writes; the sheet itself caps at ${MAX_SHEET_ROWS} rows)`;
	}
	const cells: SheetCell[][] = [];
	for (const [rowIndex, row] of value.entries()) {
		if (!Array.isArray(row) || row.length === 0) {
			return `cells[${rowIndex}] must be a non-empty array of cells`;
		}
		if (row.length > MAX_SHEET_COLUMNS) {
			return `cells[${rowIndex}] has ${row.length} cells — a sheet holds at most ${MAX_SHEET_COLUMNS} columns`;
		}
		const parsed: SheetCell[] = [];
		for (const [cellIndex, cell] of row.entries()) {
			if (
				cell === null ||
				typeof cell === "number" ||
				typeof cell === "boolean"
			) {
				parsed.push(cell);
				continue;
			}
			if (typeof cell === "string") {
				if (cell.length > 4_000) {
					return `cells[${rowIndex}][${cellIndex}] is longer than the 4000-character cell cap`;
				}
				parsed.push(cell);
				continue;
			}
			return `cells[${rowIndex}][${cellIndex}] must be a string, number, boolean, or null`;
		}
		cells.push(parsed);
	}
	return cells;
}

/**
 * The agent-editable projection of one output's current revision body.
 * Presentations and sheets are projected with the indexes/coordinates the
 * patch verbs address (slide `index`; zero-based row/column origins), and a
 * sheet's rows are bounded to a preview so a large grid cannot flood a turn.
 */
function contentProjection(content: OsOutputContent): Record<string, unknown> {
	switch (content.kind) {
		case "document":
			return { contentMarkdown: documentBlocksToMarkdown(content.blocks) };
		case "presentation":
			return {
				slideCount: content.slides.length,
				slides: content.slides.map((slide, index) => ({
					index,
					title: slide.title,
					bullets: slide.bullets,
					...(slide.notes !== undefined ? { notes: slide.notes } : {}),
				})),
			};
		case "sheet":
			return {
				columns: content.columns,
				rowCount: content.rows.length,
				rows: content.rows.slice(0, SHEET_PREVIEW_ROWS),
				...(content.rows.length > SHEET_PREVIEW_ROWS
					? { rowsTruncated: true }
					: {}),
			};
		default:
			return { content };
	}
}

/**
 * Tool-facing description overlay for the CAS guard: it tells the browser
 * agent HOW to obtain the value (read_output), which the contract's own
 * description does not.
 */
const EXPECTED_REVISION_DESCRIPTION =
	"The saved revision number returned by read_output. A concurrent saved version makes this stale and the write fails as a conflict. This guard does not include unsaved workspace draft edits." as const;

const WORKSPACE_DRAFT_GUIDANCE =
	"For workspace documents, prefer the existing collaboration proposal tools discovered through Tedix Code Mode so the user can review the edit. This direct API writes a saved version; it does not merge the live shared draft. A shared draft with edits remains preserved and requires comparison with the updated version.";

/** Mirrors OsPresentationSlideOutlineSchema: the semantic slide the router lays out. */
const SLIDE_OUTLINE_SCHEMA = {
	type: "object",
	properties: {
		title: { type: "string", minLength: 1, maxLength: 300 },
		bullets: {
			type: "array",
			maxItems: 30,
			items: { type: "string", maxLength: 2000 },
			description: "Slide bullet lines, top to bottom.",
		},
		notes: {
			type: "string",
			maxLength: 10_000,
			description:
				"Speaker notes; a replace that omits it clears the slide's notes.",
		},
	},
	required: ["title"],
} as const;

/** The simplified block vocabulary patch_document accepts (kind + text/items). */
const DOCUMENT_BLOCK_SCHEMA = {
	oneOf: [
		{
			type: "object",
			properties: {
				kind: { const: "heading" },
				level: { type: "integer", minimum: 1, maximum: 4 },
				text: { type: "string", maxLength: 2000 },
			},
			required: ["kind", "text"],
		},
		{
			type: "object",
			properties: {
				kind: { const: "paragraph" },
				text: { type: "string", maxLength: 20_000 },
			},
			required: ["kind", "text"],
		},
		{
			type: "object",
			properties: {
				kind: { const: "list" },
				ordered: { type: "boolean" },
				items: {
					type: "array",
					minItems: 1,
					maxItems: 200,
					items: { type: "string", maxLength: 2000 },
				},
			},
			required: ["kind", "items"],
		},
		{
			type: "object",
			properties: {
				kind: { const: "code" },
				language: { type: "string", maxLength: 60 },
				text: { type: "string", maxLength: 40_000 },
			},
			required: ["kind", "text"],
		},
		{
			type: "object",
			properties: {
				kind: { const: "quote" },
				text: { type: "string", maxLength: 20_000 },
			},
			required: ["kind", "text"],
		},
	],
} as const;

// ── Derived CAS write schemas ────────────────────────────────────────────────
// Each derives its shared fields (outputId, expectedRevision, note — and
// set_sheet_range's whole rectangle) from the owning contract input, so caps
// and formats track the contract. Deliberate overlay on every one:
// expectedRevision is tool-REQUIRED while the contract keeps it optional (the
// unconditional-append path is not exposed to the browser agent), and the
// remapped fields (markdown `content`, the simplified op unions) stay
// hand-written extras because they are tool-surface projections, not contract
// shapes.

const outputsContract = osWorkspacesContract.outputs;

const REVISE_OUTPUT_SCHEMA = deriveToolSchema(
	contractInputSchema(outputsContract.revise),
	{
		// `content` is remapped: the contract takes OsOutputContent; the tool
		// takes markdown and converts via markdownToDocumentBlocks.
		pick: ["outputId", "expectedRevision", "note"],
		require: ["content", "expectedRevision"],
		override: {
			outputId: { description: "Document output id." },
			expectedRevision: { description: EXPECTED_REVISION_DESCRIPTION },
			note: { description: "Optional revision message describing the edit." },
		},
		extra: {
			content: {
				type: "string",
				maxLength: 200_000,
				description:
					"Full replacement body as markdown (headings #–####, paragraphs, -/1. lists, ``` code fences, > quotes). This replaces the whole document, so include unchanged sections.",
			},
		},
	},
);

const PATCH_DOCUMENT_SCHEMA = deriveToolSchema(
	contractInputSchema(outputsContract.patchDocument),
	{
		// `ops` is remapped: the tool accepts the simplified block vocabulary
		// ({ kind, text/items }) and converts via simplifiedBlockToDocumentBlock.
		pick: ["outputId", "expectedRevision", "note"],
		require: ["ops", "expectedRevision"],
		override: {
			outputId: { description: "Document output id." },
			expectedRevision: { description: EXPECTED_REVISION_DESCRIPTION },
			note: { description: "Optional revision message describing the edit." },
		},
		extra: {
			ops: {
				type: "array",
				minItems: 1,
				maxItems: MAX_PATCH_OPS,
				description:
					"Applied in order against the evolving block list: insert accepts indices 0..length (appending at length); replace and delete require an existing index.",
				items: {
					oneOf: [
						{
							type: "object",
							properties: {
								op: { const: "insert" },
								index: { type: "integer", minimum: 0 },
								block: DOCUMENT_BLOCK_SCHEMA,
							},
							required: ["op", "index", "block"],
						},
						{
							type: "object",
							properties: {
								op: { const: "replace" },
								index: { type: "integer", minimum: 0 },
								block: DOCUMENT_BLOCK_SCHEMA,
							},
							required: ["op", "index", "block"],
						},
						{
							type: "object",
							properties: {
								op: { const: "delete" },
								index: { type: "integer", minimum: 0 },
							},
							required: ["op", "index"],
						},
					],
				},
			},
		},
	},
);

const PATCH_SLIDES_SCHEMA = deriveToolSchema(
	contractInputSchema(outputsContract.patchSlides),
	{
		// `ops` mirrors OsPresentationPatchOpSchema by hand (SLIDE_OUTLINE_SCHEMA
		// is the tool's projection of the slide outline); parity tests guard it.
		pick: ["outputId", "expectedRevision", "note"],
		require: ["ops", "expectedRevision"],
		override: {
			outputId: { description: "Presentation output id." },
			expectedRevision: { description: EXPECTED_REVISION_DESCRIPTION },
			note: { description: "Optional revision message describing the edit." },
		},
		extra: {
			ops: {
				type: "array",
				minItems: 1,
				maxItems: MAX_PATCH_OPS,
				description:
					"Applied in order against the evolving slide list: insert accepts indices 0..length (appending at length); replace, delete, and move require existing indices.",
				items: {
					oneOf: [
						{
							type: "object",
							properties: {
								op: { const: "insert" },
								index: { type: "integer", minimum: 0 },
								slide: SLIDE_OUTLINE_SCHEMA,
							},
							required: ["op", "index", "slide"],
						},
						{
							type: "object",
							properties: {
								op: { const: "replace" },
								index: { type: "integer", minimum: 0 },
								slide: SLIDE_OUTLINE_SCHEMA,
							},
							required: ["op", "index", "slide"],
						},
						{
							type: "object",
							properties: {
								op: { const: "delete" },
								index: { type: "integer", minimum: 0 },
							},
							required: ["op", "index"],
						},
						{
							type: "object",
							properties: {
								op: { const: "move" },
								from: { type: "integer", minimum: 0 },
								to: { type: "integer", minimum: 0 },
							},
							required: ["op", "from", "to"],
						},
					],
				},
			},
		},
	},
);

const SET_SHEET_RANGE_SCHEMA = deriveToolSchema(
	contractInputSchema(outputsContract.setSheetRange),
	{
		// The whole rectangle is contract-shaped, so `cells` (row/column caps,
		// the 4000-char string cell cap) derives directly.
		pick: [
			"outputId",
			"startRow",
			"startColumn",
			"cells",
			"expectedRevision",
			"note",
		],
		require: ["expectedRevision"],
		override: {
			outputId: { description: "Sheet output id." },
			startRow: {
				description: "Zero-based row the rectangle's first row lands on.",
			},
			startColumn: {
				description:
					"Zero-based column the rectangle's first cell lands on; the rectangle must fit the sheet's current column count.",
			},
			cells: {
				description: `Rows of cell values, written top-to-bottom from (startRow, startColumn). Max ${MAX_SHEET_RANGE_ROWS} rows per call and ${MAX_SHEET_COLUMNS} cells per row; the sheet caps at ${MAX_SHEET_ROWS} rows.`,
			},
			expectedRevision: { description: EXPECTED_REVISION_DESCRIPTION },
			note: { description: "Optional revision message describing the edit." },
		},
	},
);

/** Build the Outputs-scope WebMCP tool set. Pure so tests can drive execute(). */
export function buildOutputsWebMcpTools(
	deps: OutputsWebMcpDeps = {},
): WebMcpToolDef[] {
	const listOutputs: WebMcpToolDef = {
		name: "list_outputs",
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		description:
			"List the organization's Tedix OS outputs — durable revisioned documents, sheets, presentations, and videos — as the compact rows the human sees in the Outputs library.",
		inputSchema: {
			type: "object",
			properties: {
				workspaceId: {
					type: "string",
					format: "uuid",
					description: "Filter to outputs grouped under one workspace.",
				},
				limit: {
					type: "integer",
					minimum: 1,
					maximum: MAX_LIST_LIMIT,
					description: `Rows to return (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}).`,
				},
			},
		},
		execute: async (args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const { osApi } = await loadRuntime();
				const rawLimit =
					typeof args["limit"] === "number"
						? args["limit"]
						: DEFAULT_LIST_LIMIT;
				const limit = Math.min(
					Math.max(Math.trunc(rawLimit), 1),
					MAX_LIST_LIMIT,
				);
				const input = {
					limit,
					...(optionalString(args["workspaceId"])
						? { workspaceId: args["workspaceId"] }
						: {}),
				} as OutputsListInput;
				const result = await osApi.osWorkspaces.outputs.list(
					input,
					...clientOptions(executeOptions),
				);
				return webMcpResult({
					items: result.items.map((output) => ({
						id: output.id,
						title: output.title,
						kind: output.kind,
						status: output.status,
						workspaceId: output.workspaceId,
						updatedAt: output.updatedAt,
						deepLink: outputDeepLink(output.id),
					})),
					truncated: result.truncated,
				});
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	};

	const readOutput: WebMcpToolDef = {
		name: "read_output",
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		description:
			"Read one Tedix OS output with its current revision: documents return an editable markdown projection, presentations their indexed slide outlines (title/bullets/notes), sheets their columns plus a bounded row preview with zero-based coordinates — pass the returned `revision` as `expectedRevision` when writing.",
		inputSchema: {
			type: "object",
			properties: {
				outputId: {
					type: "string",
					format: "uuid",
					description: "Output id.",
				},
			},
			required: ["outputId"],
		},
		execute: async (args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const outputId = optionalString(args["outputId"]);
				if (!outputId) return webMcpError("outputId is required");
				const { osApi } = await loadRuntime();
				const { output, currentRevision } =
					await osApi.osWorkspaces.outputs.get(
						{ outputId },
						...clientOptions(executeOptions),
					);
				return webMcpResult(
					{
						id: output.id,
						title: output.title,
						kind: output.kind,
						status: output.status,
						workspaceId: output.workspaceId,
						updatedAt: output.updatedAt,
						revision: currentRevision.revision,
						revisionNote: currentRevision.note,
						...contentProjection(currentRevision.content),
					},
					outputDeepLink(output.id),
				);
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	};

	const reviseOutput: WebMcpToolDef = {
		name: "revise_output",
		annotations: { readOnlyHint: false, untrustedContentHint: false },
		description: `Replace a document output's body with the given markdown as a new saved compare-and-swap revision; read_output first and pass its revision as expectedRevision. Markdown replacement may discard rich formatting. ${WORKSPACE_DRAFT_GUIDANCE}`,
		inputSchema: REVISE_OUTPUT_SCHEMA,
		execute: async (args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const outputId = optionalString(args["outputId"]);
				if (!outputId) return webMcpError("outputId is required");
				if (typeof args["content"] !== "string") {
					return webMcpError(
						"content is required and must be a markdown string",
					);
				}
				const expectedRevision = requiredRevision(args["expectedRevision"]);
				if (expectedRevision === null) {
					return webMcpError(MISSING_EXPECTED_REVISION);
				}
				const blocks = markdownToDocumentBlocks(args["content"]);
				// Same shape the visible editor saves: blocks stay the semantic
				// projection and richText is derived from them (normalizeDocumentContent).
				const content: OsOutputContent = {
					kind: "document",
					blocks,
					richText: richTextFromBlocks(blocks),
				};
				const note = optionalString(args["note"])?.trim();
				const runtime = await loadRuntime();
				const result = await runtime.osApi.osWorkspaces.outputs.revise(
					{
						outputId,
						content,
						expectedRevision,
						...(note ? { note } : {}),
					},
					...clientOptions(executeOptions),
				);
				await invalidateOutputQueries(runtime, deps, outputId);
				return webMcpResult(
					{ outputId, revision: result.revision.revision },
					outputDeepLink(outputId),
				);
			} catch (error) {
				return revisionWriteError(error);
			}
		},
	};

	const patchDocument: WebMcpToolDef = {
		name: "patch_document",
		annotations: { readOnlyHint: false, untrustedContentHint: false },
		description: `Edit a document output block-by-block with ordered insert/replace/delete operations as one saved compare-and-swap revision; read_output first and pass its revision as expectedRevision. ${WORKSPACE_DRAFT_GUIDANCE}`,
		inputSchema: PATCH_DOCUMENT_SCHEMA,
		execute: async (args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const outputId = optionalString(args["outputId"]);
				if (!outputId) return webMcpError("outputId is required");
				const expectedRevision = requiredRevision(args["expectedRevision"]);
				if (expectedRevision === null) {
					return webMcpError(MISSING_EXPECTED_REVISION);
				}
				const ops = parseDocumentOps(args["ops"]);
				if (typeof ops === "string") return webMcpError(ops);
				const note = optionalString(args["note"])?.trim();
				const runtime = await loadRuntime();
				const result = await runtime.osApi.osWorkspaces.outputs.patchDocument(
					{
						outputId,
						ops,
						expectedRevision,
						...(note ? { note } : {}),
					},
					...clientOptions(executeOptions),
				);
				await invalidateOutputQueries(runtime, deps, outputId);
				const content = result.revision.content;
				return webMcpResult(
					{
						outputId,
						revision: result.revision.revision,
						opsApplied: ops.length,
						...(content.kind === "document"
							? { blockCount: content.blocks.length }
							: {}),
					},
					outputDeepLink(outputId),
				);
			} catch (error) {
				return revisionWriteError(error);
			}
		},
	};

	const patchSlides: WebMcpToolDef = {
		name: "patch_slides",
		annotations: { readOnlyHint: false, untrustedContentHint: false },
		description:
			"Edit a presentation output slide-by-slide with ordered insert/replace/delete/move operations over the slide indexes read_output returns, as one saved compare-and-swap revision (this does not merge a live shared draft); pass read_output's `revision` as `expectedRevision`.",
		inputSchema: PATCH_SLIDES_SCHEMA,
		execute: async (args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const outputId = optionalString(args["outputId"]);
				if (!outputId) return webMcpError("outputId is required");
				const expectedRevision = requiredRevision(args["expectedRevision"]);
				if (expectedRevision === null) {
					return webMcpError(MISSING_EXPECTED_REVISION);
				}
				const rawOps = args["ops"];
				if (!Array.isArray(rawOps) || rawOps.length === 0) {
					return webMcpError(
						"ops is required: a non-empty array of insert/replace/delete/move slide operations",
					);
				}
				if (rawOps.length > MAX_PATCH_OPS) {
					return webMcpError(
						`ops has ${rawOps.length} operations — apply at most ${MAX_PATCH_OPS} per call`,
					);
				}
				const note = optionalString(args["note"])?.trim();
				const runtime = await loadRuntime();
				const result = await runtime.osApi.osWorkspaces.outputs.patchSlides(
					{
						outputId,
						// The op union is validated server-side against
						// OsPresentationPatchOpSchema; the inputSchema above mirrors it.
						ops: rawOps as PatchSlidesInput["ops"],
						expectedRevision,
						...(note ? { note } : {}),
					},
					...clientOptions(executeOptions),
				);
				await invalidateOutputQueries(runtime, deps, outputId);
				const content = result.revision.content;
				return webMcpResult(
					{
						outputId,
						revision: result.revision.revision,
						opsApplied: rawOps.length,
						...(content.kind === "presentation"
							? { slideCount: content.slides.length }
							: {}),
					},
					outputDeepLink(outputId),
				);
			} catch (error) {
				return revisionWriteError(error);
			}
		},
	};

	const setSheetRange: WebMcpToolDef = {
		name: "set_sheet_range",
		annotations: { readOnlyHint: false, untrustedContentHint: false },
		description:
			"Write a rectangle of cells into a sheet output at zero-based numeric coordinates (startRow, startColumn — no A1 notation) as one saved compare-and-swap revision (this does not merge a live shared draft); the rectangle must fit the sheet's existing columns (max 64), at most 200 rows per call within the 1000-row sheet cap, and pass read_output's `revision` as `expectedRevision`.",
		inputSchema: SET_SHEET_RANGE_SCHEMA,
		execute: async (args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const outputId = optionalString(args["outputId"]);
				if (!outputId) return webMcpError("outputId is required");
				const expectedRevision = requiredRevision(args["expectedRevision"]);
				if (expectedRevision === null) {
					return webMcpError(MISSING_EXPECTED_REVISION);
				}
				const startRow = nonNegativeInt(args["startRow"]);
				const startColumn = nonNegativeInt(args["startColumn"]);
				if (startRow === null || startColumn === null) {
					return webMcpError(
						"startRow and startColumn are required zero-based non-negative integers (numeric coordinates, not A1 notation)",
					);
				}
				const cells = parseSheetCells(args["cells"]);
				if (typeof cells === "string") return webMcpError(cells);
				const note = optionalString(args["note"])?.trim();
				const runtime = await loadRuntime();
				const result = await runtime.osApi.osWorkspaces.outputs.setSheetRange(
					{
						outputId,
						startRow,
						startColumn,
						cells,
						expectedRevision,
						...(note ? { note } : {}),
					},
					...clientOptions(executeOptions),
				);
				await invalidateOutputQueries(runtime, deps, outputId);
				const content = result.revision.content;
				return webMcpResult(
					{
						outputId,
						revision: result.revision.revision,
						rowsWritten: cells.length,
						...(content.kind === "sheet"
							? { rowCount: content.rows.length }
							: {}),
					},
					outputDeepLink(outputId),
				);
			} catch (error) {
				return revisionWriteError(error);
			}
		},
	};

	return [
		listOutputs,
		readOutput,
		reviseOutput,
		patchDocument,
		patchSlides,
		setSheetRange,
	];
}

/** Register the Outputs-scope WebMCP tools for the lifetime of an Outputs surface. */
export function useOutputsWebMcpTools(): void {
	// Invalidations resolve the app's one QueryClient (router context) at
	// execute time. Refreshing saved output queries does not replace edited live drafts.
	useWebMcpTools("outputs", () => buildOutputsWebMcpTools(), []);
}
