import type { WebMcpToolDef } from "@tedix/webmcp-core/model-context";

/**
 * The page's own tools that the quick chat may run for the person, such as
 * the Decision Deck's card actions. Unlike browser WebMCP registration this
 * does not depend on the browser offering an agent surface: the quick chat
 * widget reads this list at each turn and runs a tool only when the chat
 * model asks for one. Identity of the person and server authority are
 * unchanged; every tool acts through the same controls the person uses.
 */
export interface PageChatTool extends WebMcpToolDef {
	/** The person taps an inline confirm in the chat before it runs. */
	confirm?: boolean;
	/** Plain words for the chat's activity row, e.g. "filled the answer". */
	describe?: (args: Record<string, unknown>) => string | null;
	/** Snapshot before running; returns how to put the page back, if possible. */
	prepareUndo?: (args: Record<string, unknown>) => (() => unknown) | null;
}

/** Per-tool additions a scope gives its WebMCP tools for the chat. */
export type PageChatToolExtras = Pick<
	PageChatTool,
	"confirm" | "describe" | "prepareUndo"
>;

const scopes = new Map<string, PageChatTool[]>();
const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) listener();
}

/** Register a scope; returns a dispose that removes only this registration. */
export function registerPageChatTools(
	scope: string,
	tools: PageChatTool[],
): () => void {
	scopes.set(scope, tools);
	notify();
	return () => {
		if (scopes.get(scope) !== tools) return;
		scopes.delete(scope);
		notify();
	};
}

/** Every live page tool; the first registration of a name wins. */
export function listPageChatTools(): PageChatTool[] {
	const seen = new Set<string>();
	const out: PageChatTool[] = [];
	for (const tools of scopes.values())
		for (const tool of tools) {
			if (seen.has(tool.name)) continue;
			seen.add(tool.name);
			out.push(tool);
		}
	return out;
}

export function subscribePageChatTools(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
