/**
 * Which of the agent's file writes apply at once. Creating or editing one
 * doc, sheet or deck in this workspace needs no decision: version history
 * and undo are the way back. Removing content, deleting, sharing, filing
 * Work and anything outside the workspace's own files waits for a person.
 */

/** The exact binding methods that apply at once. */
const FILE_WRITES: Record<string, readonly string[]> = {
	outputs: ["create", "revise"],
	documents: ["replace", "edit"],
	sheets: ["replace", "edit"],
	presentations: ["replace", "edit"],
};

/** An edit that removes blocks or slides always asks. */
function removesSomething(args: unknown[]): boolean {
	const input = args[0];
	if (!input || typeof input !== "object") return false;
	const ops = (input as { ops?: unknown }).ops;
	if (!Array.isArray(ops)) return false;
	return ops.some((op) => {
		const name =
			op && typeof op === "object" ? (op as { op?: unknown }).op : null;
		return typeof name === "string" && /delete|remove|archive/i.test(name);
	});
}

export function fileWriteAppliesAtOnce(
	binding: string,
	method: string,
	args: unknown[],
	/** `destructive`: anything beyond a bounded write to one file. */
	options: { destructive?: boolean } = {},
): boolean {
	if (options.destructive) return false;
	if (removesSomething(args)) return false;
	return FILE_WRITES[binding]?.includes(method) ?? false;
}
