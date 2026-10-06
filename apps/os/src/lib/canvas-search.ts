import { optionalUuidSearchParam } from "@/lib/os-route-loaders";

export type CanvasDocSelection =
	| { type: "gadget"; id: string }
	| { type: "output"; id: string; linkedGadgetId?: string };

export type CanvasMobilePane = "resources" | "work" | "chat" | "workpiece";

export type CanvasWorkpieceMode =
	| "workpiece"
	| "source"
	| "runs"
	| "connections"
	| "activity";

export type CanvasSearch = {
	/** Durable Home conversation selected in the Workspace chat pane. */
	conversation?: string;
	workpiece?: string;
	/** The open tab set as doc keys, comma-joined; the selected one is `workpiece`. */
	workpieces?: string;
	view?: CanvasWorkpieceMode;
	pane?: CanvasMobilePane;
	focus?: true;
};

const CANVAS_MOBILE_PANES = new Set<CanvasMobilePane>([
	"resources",
	"work",
	"chat",
	"workpiece",
]);

const CANVAS_WORKPIECE_MODES = new Set<CanvasWorkpieceMode>([
	"workpiece",
	"source",
	"runs",
	"connections",
	"activity",
]);

/** The collab room key and stable URL value: `gadget:<id>` / `output:<id>`. */
export function canvasDocKey(doc: CanvasDocSelection): string {
	return `${doc.type}:${doc.id}`;
}

export function canvasDocFromSearch(value: unknown): CanvasDocSelection | null {
	if (typeof value !== "string") return null;
	const separator = value.indexOf(":");
	if (separator <= 0 || separator !== value.lastIndexOf(":")) return null;
	const type = value.slice(0, separator);
	const id = optionalUuidSearchParam(value.slice(separator + 1));
	if ((type !== "gadget" && type !== "output") || !id) return null;
	return { type, id };
}

function enumSearchParam<T extends string>(
	value: unknown,
	allowed: ReadonlySet<T>,
): T | undefined {
	return typeof value === "string" && allowed.has(value as T)
		? (value as T)
		: undefined;
}

/**
 * The Canvas URL accepts only bounded enums and UUID-backed resource keys.
 * Arbitrary labels, editor content, chat text, and capability data never enter
 * the address bar.
 */
/**
 * A URL can carry at most this many open tabs. Enough for any real comparison
 * set; small enough that a shared link stays a link rather than a payload.
 */
export const CANVAS_MAX_URL_WORKPIECES = 6;

export function canvasConversationFromSearch(
	value: unknown,
): string | undefined {
	if (typeof value !== "string" || value.length > 96) return undefined;
	if (value === "home:main") return value;
	// Embedded conversations use UUIDs; retain their identity during host handoff.
	// This is URL validation only, not conversation access authorization.
	if (optionalUuidSearchParam(value)) return value;
	return /^home:os:[0-9a-f-]{1,64}$/i.test(value) ? value : undefined;
}

/**
 * Parse the open tab set from the `workpieces` search value. Per-element
 * validation on purpose: one stale or mangled entry in a shared link drops
 * THAT entry, not the whole set. Deduped by key, bounded, order preserved.
 */
export function canvasDocsFromSearch(value: unknown): CanvasDocSelection[] {
	if (typeof value !== "string" || value === "") return [];
	const seen = new Set<string>();
	const docs: CanvasDocSelection[] = [];
	for (const part of value.split(",")) {
		const doc = canvasDocFromSearch(part.trim());
		if (!doc) continue;
		const key = canvasDocKey(doc);
		if (seen.has(key)) continue;
		seen.add(key);
		docs.push(doc);
		if (docs.length >= CANVAS_MAX_URL_WORKPIECES) break;
	}
	return docs;
}

/**
 * Encode the open tab set for the URL. A single tab travels as `workpiece`
 * alone -- today's URLs stay byte-identical -- so `workpieces` appears only
 * when there is genuinely a set to share.
 */
export function canvasDocsSearchValue(
	docs: readonly CanvasDocSelection[],
): string | undefined {
	if (docs.length <= 1) return undefined;
	return docs
		.slice(0, CANVAS_MAX_URL_WORKPIECES)
		.map((doc) => canvasDocKey(doc))
		.join(",");
}

export type ChatSearch = {
	/** Durable Home conversation open on `/chat`; absent = the new-thread state. */
	conversation?: string;
};

/**
 * `/chat` carries only the conversation id. Nothing else about the Chat
 * surface is addressable, and the id is validated so an arbitrary string can
 * never become the active thread.
 */
export function validateChatSearch(
	search: Record<string, unknown>,
): ChatSearch {
	const conversation = canvasConversationFromSearch(search.conversation);
	return conversation ? { conversation } : {};
}

export function validateWorkspaceSearch(
	search: Record<string, unknown>,
): CanvasSearch {
	const workpiece = canvasDocFromSearch(search.workpiece);
	const workpieces = canvasDocsFromSearch(search.workpieces);
	const focus =
		search.focus === true || search.focus === "true" || search.focus === "1";
	return {
		conversation: canvasConversationFromSearch(search.conversation),
		workpiece: workpiece ? canvasDocKey(workpiece) : undefined,
		workpieces: canvasDocsSearchValue(workpieces),
		view: enumSearchParam(search.view, CANVAS_WORKPIECE_MODES),
		pane: enumSearchParam(search.pane, CANVAS_MOBILE_PANES),
		focus: focus ? true : undefined,
	};
}

export function canvasModeIsValidForDoc(
	mode: CanvasWorkpieceMode,
	doc: CanvasDocSelection,
): boolean {
	return (mode !== "source" && mode !== "runs") || doc.type === "gadget";
}
