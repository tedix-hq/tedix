/**
 * Detectable Code Mode result truncation shared by MCP and durable runtimes.
 * Code Mode 0.5.2 preserves oversized objects and arrays structurally. Tedix
 * still wraps partial results explicitly so CLI consumers cannot mistake a
 * valid, partial JSON value for a complete result. The preview remains a
 * string for the installed CLI envelope contract.
 *
 * @see docs/mcp/codemode.md
 */

import { truncateResult } from "@cloudflare/codemode";

/** Stable Tedix envelope marker, also used by upstream partial values. */
export const CODEMODE_TRUNCATION_MARKER = "--- TRUNCATED ---";

/**
 * The dep's `DEFAULT_MAX_TOKENS`. Char budget = maxTokens * 4, applied to the
 * compact `JSON.stringify(value)` serialization (24,000 chars by default).
 */
export const DEFAULT_CODEMODE_RESULT_MAX_TOKENS = 6_000;

export interface CodeModeTruncationOptions {
	/** Char cap on the compact serialization. Defaults to `maxTokens * 4`. */
	maxChars?: number;
	/** Token budget deriving the default `maxChars`. Defaults to 6,000. */
	maxTokens?: number;
}

/** Structured envelope emitted in place of a silently truncated result. */
export interface TruncatedCodeModeResult {
	/** Discriminant — never present on a passthrough result. */
	__tedix_truncated: true;
	marker: typeof CODEMODE_TRUNCATION_MARKER;
	/** Shape of the original result before serialization + clipping. */
	originalType: "array" | "bigint" | "boolean" | "number" | "object" | "string";
	/** Estimated size of the full serialized result, when parseable. */
	approxTokens?: number;
	/** Token budget the gateway applied. */
	maxTokens?: number;
	/** Model/human-actionable next step. */
	guidance: string;
	/** Compact JSON of the partial structured value, or clipped original text. */
	preview: string;
}

export function isTruncatedCodeModeResult(
	value: unknown,
): value is TruncatedCodeModeResult {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(value as Record<string, unknown>).__tedix_truncated === true &&
		typeof (value as Record<string, unknown>).preview === "string"
	);
}

function originalTypeOf(
	value: unknown,
): TruncatedCodeModeResult["originalType"] {
	if (Array.isArray(value)) return "array";
	const t = typeof value;
	return t === "string" ||
		t === "number" ||
		t === "boolean" ||
		t === "bigint" ||
		t === "object"
		? t
		: "object";
}

export function buildCodeModeTruncationGuidance(sizes: {
	approxTokens?: number;
	maxTokens?: number;
}): string {
	const approx = sizes.approxTokens
		? `~${sizes.approxTokens.toLocaleString("en-US")} tokens`
		: "over the budget";
	const limit = sizes.maxTokens
		? ` (limit ${sizes.maxTokens.toLocaleString("en-US")})`
		: "";
	return `Result truncated by the Code Mode gateway: ${approx}${limit}. Narrow the projection, request fewer fields, or paginate.`;
}

/**
 * Bound a Code Mode result for the model without silent type degradation.
 *
 * Within budget → the input is returned unchanged (byte-identical
 * passthrough). Over budget → a {@link TruncatedCodeModeResult} envelope is
 * returned around the partial value.
 */
export function shapeBoundedCodeModeResult(
	value: unknown,
	options?: CodeModeTruncationOptions,
): unknown {
	const shaped = truncateResult(value, options);
	// Upstream returns the same reference for complete or unserializable values.
	if (Object.is(shaped, value)) return value;
	const serialized = typeof value === "string" ? value : JSON.stringify(value);
	const sizes = {
		approxTokens: Math.ceil((serialized?.length ?? 0) / 4),
		maxTokens: Math.ceil(resolveMaxChars(options) / 4),
	};
	return {
		__tedix_truncated: true,
		marker: CODEMODE_TRUNCATION_MARKER,
		originalType: originalTypeOf(value),
		...sizes,
		guidance: buildCodeModeTruncationGuidance(sizes),
		// String fallback appends a marker after the budget; do not parse its prose.
		preview:
			typeof shaped === "string"
				? shaped.slice(0, resolveMaxChars(options))
				: JSON.stringify(shaped),
	} satisfies TruncatedCodeModeResult;
}

function resolveMaxChars(options?: CodeModeTruncationOptions): number {
	return (
		options?.maxChars ??
		(options?.maxTokens ?? DEFAULT_CODEMODE_RESULT_MAX_TOKENS) * 4
	);
}

/**
 * Serialize an outer Code Mode output (e.g. `{ executionId, result, logs }`)
 * for `content[0].text`. The inner `result` is expected to be already bounded
 * via {@link shapeBoundedCodeModeResult}, so the outer serialization gets a
 * padded budget (2x + envelope headroom) — enough that an already-shaped
 * envelope is never re-clipped (JSON-escaping the preview inflates it), while
 * still bounding pathological cases such as megabyte sandbox logs.
 */
export function stringifyBoundedCodeModeResult(
	value: unknown,
	options?: CodeModeTruncationOptions,
): string {
	if (typeof value === "string") return value;
	const text = JSON.stringify(value, null, 2) ?? "undefined";
	const paddedChars = resolveMaxChars(options) * 2 + 4_000;
	if (text.length <= paddedChars) return text;
	const shaped = shapeBoundedCodeModeResult(text, { maxChars: paddedChars });
	return typeof shaped === "string"
		? shaped
		: (JSON.stringify(shaped, null, 2) ?? "undefined");
}

/** Bound model-facing logs without changing the raw execution/audit record. */
export function boundCodeModeLogs(
	logs: string[],
	options?: CodeModeTruncationOptions,
): string[] {
	const bounded = truncateResult(logs, options);
	return Array.isArray(bounded)
		? (bounded as string[])
		: [String(bounded).slice(0, resolveMaxChars(options))];
}

export type CodeModeJSONValue =
	| null
	| boolean
	| number
	| string
	| CodeModeJSONValue[]
	| { [key: string]: CodeModeJSONValue };

/**
 * Model projection for custom tools that do not use upstream's private
 * toModelOutput helper. Apply the runtime's redaction projection first.
 * Audit calls stay in the tool result but do not reenter model context.
 */
export function projectCodeModeOutputForModel(
	output: unknown,
	options?: CodeModeTruncationOptions,
): { type: "json"; value: CodeModeJSONValue } {
	try {
		let projected = output;
		if (
			typeof output === "object" &&
			output !== null &&
			!Array.isArray(output)
		) {
			const { calls: _calls, ...rest } = output as Record<string, unknown>;
			if (Array.isArray(rest.logs))
				rest.logs = truncateResult(rest.logs, options);
			projected = rest;
		}
		const serialized = JSON.stringify(projected, (_key, value) =>
			typeof value === "bigint" ? value.toString() : value,
		);
		return {
			type: "json",
			value: serialized === undefined ? null : JSON.parse(serialized),
		};
	} catch (error) {
		return {
			type: "json",
			value: {
				error: `Result could not be serialized for the model: ${error instanceof Error ? error.message : String(error)}`,
			},
		};
	}
}
