/**
 * Malformed tool-call repair
 *
 * The Pi model bridge repairs malformed arguments before parsing and validating
 * the tool input. Repair preserves the provider call identity and never calls
 * another model or spends unattributed inference tokens.
 *
 * Unrepairable by design:
 *   - `NoSuchToolError` — a name we do not serve is a routing problem, not a
 *     formatting one. Returning null surfaces it.
 *   - input that parses to a non-object — nothing to hand a tool schema.
 */

import type { LanguageModelV4ToolCall } from "@ai-sdk/provider";

/** Preserve the provider SDK call identity and argument contract directly. */
type RepairableToolCall = LanguageModelV4ToolCall;

/** Strip a ```json … ``` (or bare ```) fence the model wrapped arguments in. */
function stripCodeFence(text: string): string {
	const fence = /^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?\s*```\s*$/;
	const match = fence.exec(text);
	return match?.[1] ?? text;
}

/**
 * Trim commentary that follows a complete JSON object or array, by scanning to
 * the balanced closing bracket while respecting string literals and escapes.
 * Returns undefined when the text does not open with `{` or `[`.
 */
function takeBalancedJson(text: string): string | undefined {
	const start = text.search(/[[{]/);
	if (start === -1) return undefined;
	const open = text[start];
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			if (inString) escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === open) depth++;
		else if (ch === close) {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return undefined;
}

/**
 * Recover an arguments object from text the model emitted, tolerating code
 * fences, trailing prose, and double encoding (a JSON string whose value is
 * itself JSON). Bounded to a few unwrap rounds so malformed input cannot spin.
 */
function parseArgumentsText(text: string): Record<string, unknown> | undefined {
	let current: unknown = stripCodeFence(text).trim();
	for (let round = 0; round < 3; round++) {
		if (typeof current !== "string") break;
		const candidate = takeBalancedJson(current) ?? current;
		try {
			current = JSON.parse(candidate);
		} catch {
			return undefined;
		}
	}
	return current !== null &&
		typeof current === "object" &&
		!Array.isArray(current)
		? (current as Record<string, unknown>)
		: undefined;
}

/**
 * Unwrap a single-key envelope the model added around the real arguments —
 * `{ input: {...} }`, `{ arguments: {...} }`, or the tool's own name. Only
 * unwraps when the inner value is a plain object, so a tool that genuinely
 * takes a one-object field is left alone unless the key is an envelope name.
 */
function unwrapEnvelope(
	args: Record<string, unknown>,
	toolName: string,
): Record<string, unknown> {
	const keys = Object.keys(args);
	const key = keys.length === 1 ? keys[0] : undefined;
	if (key === undefined) return args;
	const envelopeKeys = new Set([
		"input",
		"arguments",
		"args",
		"parameters",
		toolName,
	]);
	if (!envelopeKeys.has(key)) return args;
	const inner = args[key];
	return inner !== null && typeof inner === "object" && !Array.isArray(inner)
		? (inner as Record<string, unknown>)
		: args;
}

/**
 * Repair a tool call's input, or return undefined when nothing structural is
 * wrong with it. Exported separately from the SDK-shaped handler so it can be
 * tested without constructing SDK error objects.
 */
export function repairToolCallInput(
	toolName: string,
	input: unknown,
): Record<string, unknown> | undefined {
	const parsed =
		typeof input === "string"
			? parseArgumentsText(input)
			: input !== null && typeof input === "object" && !Array.isArray(input)
				? (input as Record<string, unknown>)
				: undefined;
	if (!parsed) return undefined;
	const unwrapped = unwrapEnvelope(parsed, toolName);
	// Nothing changed and the input was already an object — no repair to make.
	if (unwrapped === parsed && typeof input !== "string") return undefined;
	return unwrapped;
}

/**
 * Deterministic repair through the provider SDK tool-call contract.
 * Only the error name is read; no model call or second execution path is added.
 */
export async function repairMalformedToolCall(options: {
	toolCall: RepairableToolCall;
	error: { name?: string };
}): Promise<RepairableToolCall | null> {
	// A tool we do not serve cannot be repaired into one we do.
	if (options.error?.name === "AI_NoSuchToolError") return null;
	const repaired = repairToolCallInput(
		options.toolCall.toolName,
		options.toolCall.input,
	);
	if (!repaired) return null;
	return { ...options.toolCall, input: JSON.stringify(repaired) };
}
