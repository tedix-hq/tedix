import { OS_DOCUMENT_MAX_BLOCKS } from "./os-output-limits";
import { z } from "zod";
import {
	OsDocumentBlockSchema,
	OsDocumentPatchOpSchema,
	OsOutputContentSchema,
	type OsDocumentBlock,
	type OsOutputContent,
	type OsRichTextNode,
} from "../schemas/os-workspaces";
import { blocksFromRichText, normalizeOsOutputInput } from "./os-document";

type Segment =
	| { block: OsDocumentBlock; nodes?: OsRichTextNode[] }
	| { block: null; nodes: OsRichTextNode[] };

function blockNodes(block: OsDocumentBlock): OsRichTextNode[] {
	const normalized = normalizeOsOutputInput({
		kind: "document",
		blocks: [block],
	});
	if (normalized.kind !== "document" || !normalized.richText)
		throw new Error("Expected document rich text");
	return normalized.richText.content;
}

export function applyDocumentBlockPatch(
	content: Extract<OsOutputContent, { kind: "document" }>,
	operations: unknown,
): Extract<OsOutputContent, { kind: "document" }> {
	const ops = z
		.array(OsDocumentPatchOpSchema)
		.min(1)
		.max(100)
		.parse(operations);
	const segments: Segment[] = content.richText
		? content.richText.content.map((node) => {
				const projected = blocksFromRichText({ type: "doc", content: [node] });
				if (projected.length > 1)
					throw new Error("Cannot safely map document blocks to rich text");
				return {
					block: projected[0]
						? OsDocumentBlockSchema.parse(projected[0])
						: null,
					nodes: [node],
				};
			})
		: content.blocks.map((block) => ({ block }));
	const blocks = segments.filter((segment) => segment.block !== null);
	const blockSchema = z.array(OsDocumentBlockSchema);
	if (
		content.richText &&
		JSON.stringify(blockSchema.parse(content.blocks)) !==
			JSON.stringify(blocks.map((segment) => segment.block))
	) {
		throw new Error(
			"Cannot safely patch document blocks: the rich text projection does not match the stored blocks",
		);
	}
	// Markdown can expand one block into several nodes; keep indices logical until all ops finish.
	for (const [position, op] of ops.entries()) {
		const limit = op.op === "insert" ? blocks.length : blocks.length - 1;
		if (op.index > limit) {
			throw new Error(
				`ops[${position}]: ${op.op} index ${op.index} is out of range (the list holds ${blocks.length} blocks at that step)`,
			);
		}
		const segmentIndex =
			op.index === blocks.length
				? segments.length
				: segments.indexOf(blocks[op.index]!);
		if (
			op.op === "replace" &&
			JSON.stringify(op.block) === JSON.stringify(blocks[op.index]!.block)
		)
			continue;
		if (op.op === "delete") {
			segments.splice(segmentIndex, 1);
			blocks.splice(op.index, 1);
		} else {
			const segment: Segment = { block: op.block };
			const remove = op.op === "replace" ? 1 : 0;
			segments.splice(segmentIndex, remove, segment);
			blocks.splice(op.index, remove, segment);
		}
	}
	// Normalize only edited groups: untouched rich nodes may carry more than blocks can express.
	const richText = {
		type: "doc" as const,
		content: segments.flatMap((segment) =>
			segment.block === null
				? segment.nodes
				: (segment.nodes ?? blockNodes(segment.block)),
		),
	};
	const projected = richText.content.flatMap((node) =>
		blocksFromRichText({ type: "doc", content: [node] }),
	);
	if (projected.length > OS_DOCUMENT_MAX_BLOCKS)
		throw new Error(
			`Document block patch exceeds ${OS_DOCUMENT_MAX_BLOCKS} projected blocks`,
		);
	const result = OsOutputContentSchema.parse({
		...content,
		richText,
		blocks: projected,
	});
	if (result.kind !== "document") throw new Error("Expected document content");
	return result;
}
