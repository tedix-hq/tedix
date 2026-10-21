/**
 * Page tools: actions the host page offers the chat for one turn, such as
 * filling the Decision Deck card on screen.
 *
 * The browser registers them, sends their descriptors with a turn, and runs
 * them when the model asks. The runtime only relays: it offers the
 * descriptors to the model for that turn, emits a `page_tool_call` frame, and
 * waits for the browser to post the result back on the same signed session.
 * Nothing here grants a server privilege. Descriptors and results are
 * untrusted page data, bounded in count and size at every hop.
 */
import { wrapUntrustedInput } from "./untrusted-input";

export const PAGE_TOOL_LIMITS = {
	/** Tools one turn may offer. */
	maxTools: 12,
	nameMaxLength: 64,
	descriptionMaxLength: 1_000,
	/** Serialized input schema, per tool. */
	schemaMaxBytes: 4_000,
	/** Serialized result text the model receives. */
	resultMaxLength: 16_000,
} as const;

const PAGE_TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;
const PAGE_TOOL_CALL_ID = /^[a-zA-Z0-9_-]{8,128}$/;

export interface PageToolAnnotations {
	readOnlyHint?: boolean;
	consequentialHint?: boolean;
	untrustedContentHint?: boolean;
}

/** What the model sees about one page tool. Never an implementation. */
export interface PageToolDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations?: PageToolAnnotations;
	/** The person taps an inline confirm in the chat before it runs. */
	confirm?: boolean;
}

/** The runtime asks the page to run one offered tool. */
export type PageToolCallEvent = {
	kind: "page_tool_call";
	/** Minted by the runtime per call; also the call's idempotency key. */
	callId: string;
	name: string;
	args: Record<string, unknown>;
	confirm: boolean;
};

/** What the page posts back for one call. */
export interface PageToolResult {
	ok: boolean;
	/** Result text or error message, as the page tool returned it. */
	content: string;
}

export interface ResolvePageToolInput {
	clientRequestId: string;
	callId: string;
	result: PageToolResult;
}

function annotations(value: unknown): PageToolAnnotations | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Record<string, unknown>;
	const out: PageToolAnnotations = {};
	for (const key of [
		"readOnlyHint",
		"consequentialHint",
		"untrustedContentHint",
	] as const)
		if (typeof input[key] === "boolean") out[key] = input[key] as boolean;
	return Object.keys(out).length ? out : undefined;
}

/**
 * Keep only well-formed descriptors, bounded in count and size. Duplicate
 * names keep the first. Anything else is dropped, never repaired.
 */
export function normalizePageToolDescriptors(
	value: unknown,
): PageToolDescriptor[] {
	if (!Array.isArray(value)) return [];
	const out: PageToolDescriptor[] = [];
	const seen = new Set<string>();
	for (const raw of value) {
		if (out.length >= PAGE_TOOL_LIMITS.maxTools) break;
		if (!raw || typeof raw !== "object") continue;
		const input = raw as Record<string, unknown>;
		const name = input.name;
		if (typeof name !== "string" || !PAGE_TOOL_NAME.test(name)) continue;
		if (seen.has(name)) continue;
		if (typeof input.description !== "string" || !input.description.trim())
			continue;
		const schema = input.inputSchema;
		if (!schema || typeof schema !== "object" || Array.isArray(schema))
			continue;
		let serialized: string;
		try {
			serialized = JSON.stringify(schema);
		} catch {
			continue;
		}
		if (serialized.length > PAGE_TOOL_LIMITS.schemaMaxBytes) continue;
		if ((schema as Record<string, unknown>).type !== "object") continue;
		seen.add(name);
		const hints = annotations(input.annotations);
		out.push({
			name,
			description: input.description
				.trim()
				.slice(0, PAGE_TOOL_LIMITS.descriptionMaxLength),
			inputSchema: JSON.parse(serialized) as Record<string, unknown>,
			...(hints ? { annotations: hints } : {}),
			...(input.confirm === true ? { confirm: true } : {}),
		});
	}
	return out;
}

export function isPageToolCallId(value: unknown): value is string {
	return typeof value === "string" && PAGE_TOOL_CALL_ID.test(value);
}

/** Bound a page result; anything malformed becomes a failed call. */
export function normalizePageToolResult(value: unknown): PageToolResult {
	if (!value || typeof value !== "object")
		return { ok: false, content: "The page returned no result." };
	const input = value as Record<string, unknown>;
	const content =
		typeof input.content === "string"
			? input.content.slice(0, PAGE_TOOL_LIMITS.resultMaxLength)
			: "";
	return input.ok === true
		? { ok: true, content }
		: { ok: false, content: content || "The page tool failed." };
}

/**
 * What the model reads back from a page tool: an outcome plus the page text
 * fenced as untrusted data. Every model path that relays page tools (tedi
 * widget turns, Home turns) returns exactly this.
 */
export function pageToolModelOutput(result: PageToolResult) {
	return {
		ok: result.ok,
		source: "host_page",
		result: wrapUntrustedInput(result.content, "page_tool"),
	};
}

export function readPageToolCall(
	event: Record<string, unknown>,
): PageToolCallEvent | null {
	if (event.kind !== "page_tool_call") return null;
	if (!isPageToolCallId(event.callId)) return null;
	if (typeof event.name !== "string" || !PAGE_TOOL_NAME.test(event.name))
		return null;
	const args =
		event.args && typeof event.args === "object" && !Array.isArray(event.args)
			? (event.args as Record<string, unknown>)
			: {};
	return {
		kind: "page_tool_call",
		callId: event.callId,
		name: event.name,
		args,
		confirm: event.confirm === true,
	};
}
