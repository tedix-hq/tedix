import { z } from "zod";
import {
	OsDocumentPatchOpSchema,
	OsOutputContentSchema,
	type OsOutputContent,
} from "../schemas/os-workspaces";
import { normalizeOsOutputInput } from "./os-document";

export function applyDocumentBlockPatch(
	content: Extract<OsOutputContent, { kind: "document" }>,
	operations: unknown,
): Extract<OsOutputContent, { kind: "document" }> {
	const ops = z
		.array(OsDocumentPatchOpSchema)
		.min(1)
		.max(100)
		.parse(operations);
	const blocks = [...content.blocks];
	for (const [position, op] of ops.entries()) {
		const limit = op.op === "insert" ? blocks.length : blocks.length - 1;
		if (op.index > limit) {
			throw new Error(
				`ops[${position}]: ${op.op} index ${op.index} is out of range (the list holds ${blocks.length} blocks at that step)`,
			);
		}
		if (op.op === "insert") blocks.splice(op.index, 0, op.block);
		else if (op.op === "replace") blocks[op.index] = op.block;
		else blocks.splice(op.index, 1);
	}
	// Blocks rebuild rich text; keep the independently authorized file reference.
	const result = OsOutputContentSchema.parse(
		normalizeOsOutputInput({
			kind: "document",
			...(content.file ? { file: content.file } : {}),
			blocks,
		}),
	);
	if (result.kind !== "document") throw new Error("Expected document content");
	return result;
}
