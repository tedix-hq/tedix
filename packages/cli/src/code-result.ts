import { isRecord } from "@tedix/api-contract/utils/is-record";

/**
 * Normalize and pretty-print the result of a `tedix code` gateway call.
 *
 * After the CLI unwraps the MCP envelope, the gateway's `code` tool returns an
 * object shaped like `{ executionId, result }`. For discovery calls `result` is
 * frequently a JSON *string* (an escaped array/object). An oversized result is
 * truncated by the gateway; current Tedix gateways return the structured
 * `__tedix_truncated` envelope from tedi-codemode-core.
 *
 * These helpers pull out the inner value, parse JSON strings back into
 * structured data, and surface truncation as `truncated: true` plus a
 * `truncationHint` so consumers can fail loudly instead of parsing a clipped
 * string into a silent empty result.
 *
 * Kept pure (no network) like `format.ts`. `normalizeCodeResult` never throws;
 * a truly unexpected failure is logged fail-soft (matching the `console.error`
 * diagnostic convention in sibling files) and the raw value is passed through.
 * The envelope contract is mirrored (not imported) from tedi-codemode-core so
 * this module stays self-contained, like its siblings.
 */

// Inlined locally to keep this module self-contained (mirrors sibling files).
export interface NormalizedCodeResult {
	executionId?: string;
	/** Bounded canonical join keys returned by the gateway, when present. */
	resultIdentity?: unknown;
	/** Bounded inner Code Mode logs returned by the gateway, when present. */
	logs?: unknown;
	value: unknown;
	/** Set when the gateway truncated the result — `value` is NOT trustworthy. */
	truncated?: boolean;
	/** Estimated full result size in tokens, when the gateway reported it. */
	approxTokens?: number;
	truncationHint?: string;
}

/** Structured truncation envelope emitted by Tedix Code Mode gateways. */
function truncationEnvelope(value: unknown): {
	approxTokens?: number;
	hint: string;
	preview: string;
} | null {
	if (!isRecord(value)) return null;
	if (value.__tedix_truncated !== true) return null;
	if (typeof value.preview !== "string") return null;
	const approxTokens =
		typeof value.approxTokens === "number" &&
		Number.isFinite(value.approxTokens)
			? value.approxTokens
			: undefined;
	const hint =
		typeof value.guidance === "string" && value.guidance
			? value.guidance
			: "Result truncated by the Code Mode gateway. Narrow the projection, request fewer fields, or paginate.";
	return {
		...(approxTokens !== undefined ? { approxTokens } : {}),
		hint,
		preview: value.preview,
	};
}

export function normalizeCodeResult(raw: unknown): NormalizedCodeResult {
	try {
		let executionId: string | undefined;
		let candidate: unknown = raw;
		if (isRecord(raw) && "result" in raw) {
			candidate = raw.result;
			if (typeof raw.executionId === "string") executionId = raw.executionId;
		}

		let value: unknown = candidate;
		let truncated = false;
		let approxTokens: number | undefined;
		let truncationHint: string | undefined;

		const envelope = truncationEnvelope(candidate);
		if (envelope) {
			// Structural previews may be valid JSON but remain partial. Keep the
			// preview as a string so consumers holding `truncated: true` decide
			// what (if anything) to do with the partial payload.
			truncated = true;
			approxTokens = envelope.approxTokens;
			truncationHint = envelope.hint;
			value = envelope.preview;
		} else if (typeof candidate === "string") {
			try {
				value = JSON.parse(candidate);
			} catch {
				value = candidate;
			}
		}

		const out: NormalizedCodeResult = { value };
		if (executionId !== undefined) out.executionId = executionId;
		if (isRecord(raw) && "resultIdentity" in raw) {
			out.resultIdentity = raw.resultIdentity;
		}
		if (isRecord(raw) && "logs" in raw) out.logs = raw.logs;
		if (truncated) out.truncated = true;
		if (approxTokens !== undefined) out.approxTokens = approxTokens;
		if (truncationHint !== undefined) out.truncationHint = truncationHint;
		return out;
	} catch (error) {
		// Defensive: parsing untrusted gateway output must never crash the CLI.
		console.error("[code-result] failed to normalize code result:", error);
		return { value: raw };
	}
}

/**
 * Restore the gateway's execution envelope when an operator explicitly asks
 * for correlation metadata. The default remains the inner result value so
 * existing shell scripts and human output do not change.
 */
export function codeOutputValue(
	normalized: NormalizedCodeResult,
	includeMetadata: boolean,
): unknown {
	if (!includeMetadata) return normalized.value;
	return {
		...(normalized.executionId ? { executionId: normalized.executionId } : {}),
		result: normalized.value,
		...(normalized.resultIdentity !== undefined
			? { resultIdentity: normalized.resultIdentity }
			: {}),
		...(normalized.logs !== undefined ? { logs: normalized.logs } : {}),
		...(normalized.truncated ? { truncated: true } : {}),
		...(normalized.approxTokens !== undefined
			? { approxTokens: normalized.approxTokens }
			: {}),
	};
}

const UNKNOWN_CAPABILITY_PATTERNS = [
	/\bnot exposed in the current gateway catalog\b/i,
	/\b[A-Za-z_$][\w$]* is not defined\b/i,
	/\bunknown tool\b/i,
	/\btool\b[^\n]*\bnot found\b/i,
	/\b(?:namespace|tool)\b[^\n]*\b(?:missing|unknown|unavailable)\b/i,
	/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)? is not a function\b/i,
];

/** Add a gateway-native recovery path for likely namespace/tool mistakes. */
export function codeDiscoveryErrorMessage(
	message: string,
	target: { workspace?: string; organization?: string; url?: string } = {},
): string {
	if (
		(message.includes("discover.search") &&
			!target.workspace &&
			!target.organization &&
			!target.url) ||
		!UNKNOWN_CAPABILITY_PATTERNS.some((pattern) => pattern.test(message))
	) {
		return message;
	}
	const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
	const flags = [
		target.workspace ? `-w ${quote(target.workspace)}` : "",
		target.organization ? `--organization ${quote(target.organization)}` : "",
		target.url ? `--url ${quote(target.url)}` : "",
	]
		.filter(Boolean)
		.join(" ");
	return `${message}\n\nGateway capability not found. Discover the exact callable, then use it verbatim:\n  tedix${flags ? ` ${flags}` : ""} code 'async () => await discover.search({ query: "namespace or tool name", limit: 3, includeParameters: true })'`;
}

/**
 * Uniform, actionable message for a truncated Code Mode result — used by
 * consumers (e.g. `tedix work` board verbs) that must fail loudly instead of
 * parsing a clipped page into a silent empty result.
 */
export function truncationErrorMessage(
	normalized: Pick<NormalizedCodeResult, "approxTokens">,
): string {
	const size = normalized.approxTokens
		? ` (~${normalized.approxTokens.toLocaleString("en-US")} tokens)`
		: "";
	return `result truncated by gateway${size}: narrow the projection or paginate`;
}

function safeStringify(value: unknown, space?: number): string {
	try {
		const out = JSON.stringify(value, null, space);
		return out ?? String(value);
	} catch (error) {
		// Circular refs / BigInt etc. — degrade to a string instead of throwing.
		console.error("[code-result] failed to stringify code value:", error);
		return String(value);
	}
}

export function formatCodeValue(
	value: unknown,
	opts: { json: boolean },
): string {
	// A plain string prints raw in pretty mode (not JSON-quoted). In json mode
	// every value is emitted as parseable compact JSON.
	if (!opts.json && typeof value === "string") return value;
	return safeStringify(value, opts.json ? undefined : 2);
}
