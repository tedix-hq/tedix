import { getByPath, setByPath, type StateStore } from "@json-render/core";
import { isRecord } from "@tedix/api-contract/utils/is-record";

/** Spec-selected input and status paths; no domain tool or card-kind knowledge. */
export async function runToolAction(
	params: Record<string, unknown>,
	store: StateStore,
	call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
	const name = params.tool;
	if (typeof name !== "string" || !name.trim())
		throw new Error("This action has no tool configured.");
	const path = typeof params.statusPath === "string" ? params.statusPath : null;
	const before = path ? getByPath(store.getSnapshot(), path) : null;
	if (before) return;
	const args = structuredClone(
		isRecord(params.arguments) ? params.arguments : {},
	);
	if (
		typeof params.textPath === "string" &&
		typeof params.textArgumentPath === "string"
	) {
		const text = getByPath(store.getSnapshot(), params.textPath);
		if (typeof text !== "string" || !text.trim())
			throw new Error("Write your answer or reason before continuing.");
		setByPath(args, params.textArgumentPath, text.trim());
	}
	if (path) store.set(path, "Saving…");
	try {
		const result = await call(
			`${typeof params.toolPrefix === "string" ? params.toolPrefix : ""}${name}`,
			args,
		);
		if (isRecord(result) && result.isError)
			throw new Error("The action could not be saved. Reload and try again.");
		if (path) store.set(path, "Saved. Reload to see the latest cards.");
	} catch (error) {
		if (path) store.set(path, before);
		throw error;
	}
}
