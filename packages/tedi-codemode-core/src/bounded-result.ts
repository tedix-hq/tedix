/**
 * Detectable Code Mode result truncation shared by MCP and durable runtimes.
 * Code Mode 0.5.2 preserves oversized objects and arrays structurally. Tedix
 * still wraps partial results explicitly so CLI consumers cannot mistake a
 * valid, partial JSON value for a complete result. The preview remains a
 * string for the installed CLI envelope contract.
 *
 * @see docs/engineering/mcp/codemode.md
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

export function resolveMaxChars(options?: CodeModeTruncationOptions): number {
	return (
		options?.maxChars ??
		(options?.maxTokens ?? DEFAULT_CODEMODE_RESULT_MAX_TOKENS) * 4
	);
}

/**
 * Envelope returned in place of an over-budget result when the gateway kept
 * the full value: nothing is lost, the caller pages it back through
 * `discover.read_result({ handle, path?, offset?, limit? })`.
 */
export interface CodeModeResultHandle {
	/** Discriminant — never present on a passthrough result. */
	__tedix_result_handle: true;
	/** Opaque handle (the executionId that produced the result). */
	handle: string;
	originalType: TruncatedCodeModeResult["originalType"];
	/** Estimated size of the full serialized result. */
	approxTokens: number;
	/** Token budget the gateway applied to the model-facing result. */
	maxTokens: number;
	/** Length in characters of the compact JSON serialization. */
	total: number;
	/** Top-level keys when the result is an object. */
	keys?: string[];
	/** Element count when the result is an array. */
	length?: number;
	/** Clipped compact JSON of the full value; never parse it. */
	preview: string;
	/** ISO timestamp after which the handle no longer resolves. */
	expiresAt: string;
	guidance: string;
}

export function isCodeModeResultHandle(
	value: unknown,
): value is CodeModeResultHandle {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(value as Record<string, unknown>).__tedix_result_handle === true &&
		typeof (value as Record<string, unknown>).handle === "string"
	);
}

/** Compact JSON used for the stored result; `undefined` becomes `null`. */
export function serializeCodeModeResultForHandle(value: unknown): string {
	return JSON.stringify(value) ?? "null";
}

/** Build the handle envelope for a value whose serialization is `serialized`. */
export function buildCodeModeResultHandle(
	value: unknown,
	serialized: string,
	handle: { handle: string; expiresAt: string },
	options?: CodeModeTruncationOptions,
): CodeModeResultHandle {
	const maxChars = resolveMaxChars(options);
	const approxTokens = Math.ceil(serialized.length / 4);
	const maxTokens = Math.ceil(maxChars / 4);
	return {
		__tedix_result_handle: true,
		handle: handle.handle,
		originalType: originalTypeOf(value),
		approxTokens,
		maxTokens,
		total: serialized.length,
		...navigationHints(value),
		preview: serialized.slice(0, Math.ceil(maxChars / 4)),
		expiresAt: handle.expiresAt,
		guidance: `Result is ~${approxTokens.toLocaleString("en-US")} tokens (limit ${maxTokens.toLocaleString("en-US")}); the full value is kept until ${handle.expiresAt}. Read it with discover.read_result({ handle, path?, offset?, limit? }): path selects a nested value (e.g. "messages[0].content"), offset/limit page its compact JSON text. Narrow the projection to avoid handles on later turns.`,
	};
}

function navigationHints(value: unknown): { keys?: string[]; length?: number } {
	if (Array.isArray(value)) return { length: value.length };
	if (typeof value === "object" && value !== null) {
		return { keys: Object.keys(value).slice(0, 100) };
	}
	return {};
}

export interface CodeModeResultPageInput {
	path?: string;
	offset?: number;
	limit?: number;
}

/** One page of a stored result, as returned by `discover.read_result`. */
export interface CodeModeResultPage {
	handle: string;
	path?: string;
	/** Length in characters of the selected value's compact JSON. */
	total: number;
	offset: number;
	limit: number;
	keys?: string[];
	length?: number;
	/** The whole selected value when it fits in one page from offset 0. */
	value?: unknown;
	/** Otherwise a slice of the compact JSON text; concatenate slices then parse. */
	text?: string;
	/** Offset of the next page; absent when this page ends the text. */
	nextOffset?: number;
	complete: boolean;
}

function resolvePath(root: unknown, path: string): unknown {
	const segments = path
		.replaceAll(/\[(\d+)\]/g, ".$1")
		.split(".")
		.filter((segment) => segment.length > 0);
	let current: unknown = root;
	for (const segment of segments) {
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index) || index < 0 || index >= current.length) {
				throw new Error(
					`read_result path "${path}": index ${segment} is out of range (length ${current.length})`,
				);
			}
			current = current[index];
		} else if (typeof current === "object" && current !== null) {
			if (!Object.hasOwn(current, segment)) {
				throw new Error(
					`read_result path "${path}": no key "${segment}" (keys: ${Object.keys(current).slice(0, 20).join(", ")})`,
				);
			}
			current = (current as Record<string, unknown>)[segment];
		} else {
			throw new Error(
				`read_result path "${path}": cannot descend into a ${current === null ? "null" : typeof current} at "${segment}"`,
			);
		}
	}
	return current;
}

/**
 * Page a stored result. `path` selects a nested value; `offset`/`limit` page
 * the selected value's compact JSON text, capped at the result budget so a
 * page always fits where the original did not.
 */
export function readCodeModeResultPage(
	handle: string,
	serialized: string,
	input: CodeModeResultPageInput = {},
	options?: CodeModeTruncationOptions,
): CodeModeResultPage {
	const maxChars = resolveMaxChars(options);
	const root: unknown = JSON.parse(serialized);
	const selected =
		typeof input.path === "string" && input.path.length > 0
			? resolvePath(root, input.path)
			: root;
	const text = input.path
		? serializeCodeModeResultForHandle(selected)
		: serialized;
	const offset =
		Number.isInteger(input.offset) && (input.offset as number) > 0
			? Math.min(input.offset as number, text.length)
			: 0;
	const limit =
		Number.isInteger(input.limit) && (input.limit as number) > 0
			? Math.min(input.limit as number, maxChars)
			: maxChars;
	const base = {
		handle,
		...(input.path ? { path: input.path } : {}),
		total: text.length,
		offset,
		limit,
		...navigationHints(selected),
	};
	if (offset === 0 && text.length <= limit) {
		return { ...base, value: selected, complete: true };
	}
	const end = Math.min(offset + limit, text.length);
	return {
		...base,
		text: text.slice(offset, end),
		...(end < text.length ? { nextOffset: end } : {}),
		complete: end >= text.length,
	};
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
