/**
 * Which of the agent's file writes apply at once. Creating or editing one
 * doc, sheet or deck in this workspace needs no decision: version history
 * and undo are the way back. Removing content, deleting, sharing, filing
 * Work and anything outside the workspace's own files waits for a person.
 */
import { removesContent } from "./approval-modes";

/** The exact binding methods that apply at once. */
const FILE_WRITES: Record<string, readonly string[]> = {
	outputs: ["create", "revise"],
	documents: ["replace", "edit"],
	sheets: ["replace", "edit"],
	presentations: ["replace", "edit"],
};

export function fileWriteAppliesAtOnce(
	binding: string,
	method: string,
	args: unknown[],
	/** `destructive`: anything beyond a bounded write to one file. */
	options: { destructive?: boolean } = {},
): boolean {
	if (options.destructive) return false;
	if (removesContent(args)) return false;
	return FILE_WRITES[binding]?.includes(method) ?? false;
}
