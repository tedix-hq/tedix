/**
 * Gated tool-call payload capture — R2-SQL-backed forensics write path.
 *
 * Pure, fire-and-forget addition. Complete NO-OP unless both
 * `MCP_PAYLOAD_STREAM_ENDPOINT` and `MCP_PAYLOAD_STREAM_TOKEN` are configured.
 * Captures the (redacted, truncated) input args + output body for each
 * `tool_call` / `prompt_get` event so an open-beta forensics layer can
 * reconstruct exact request/response payloads.
 *
 * Design invariants:
 * - Never throws, never blocks the tool response.
 * - Zero hot-path cost when unconfigured (early return before any work).
 * - Sensitive values are redacted before they ever leave the Worker.
 *
 * @module @tedix/mcp/payload-capture
 */

/**
 * Object keys whose values must be scrubbed before capture.
 * Matches common secret-bearing field names case-insensitively.
 */
const SENSITIVE_KEY_RE =
	/token|password|passwd|secret|api[_-]?key|apikey|authorization|\bauth\b|cookie|credential|bearer|client_secret|access[_-]?key|private[_-]?key|sk_/i;

const REDACTED = "[REDACTED]";

/**
 * Opt-in PII redaction. Default OFF: captured payloads are surfaced to the
 * org's own operators inspecting their own tool calls, so emails / account ids
 * in those payloads are first-party data, not a leak. Flip to `true` only when
 * captured payloads may be exposed beyond the owning org (e.g. shared
 * forensics). When true, `redactSecretValues` also redacts email addresses.
 */
const REDACT_PII = false;

/**
 * High-confidence secret VALUE patterns. Each is replaced with `[REDACTED]`
 * anywhere it appears inside a string — this catches secrets passed as values
 * under innocuous keys, or embedded in URLs / free text, which the key-name
 * scrub alone misses. Patterns are intentionally conservative (anchored on word
 * boundaries / length) to prefer false-negatives over mangling normal prose,
 * UUIDs, or ordinary identifiers.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
	// Bearer tokens (Authorization header value form).
	/Bearer\s+[A-Za-z0-9._-]+/gi,
	// JWTs: three base64url segments. Anchored on the `eyJ` header prefix.
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
	// Stripe-style / generic prefixed keys: sk_live_…, pk_test_…, rk_…, ak_…
	/\b(?:sk|pk|rk|ak)[_-](?:live|test)?[_-]?[A-Za-z0-9]{16,}/gi,
	// Cloudflare API tokens.
	/\bcfat[_-][A-Za-z0-9._-]{20,}/gi,
	// Cloudflare-style v1.0-… tokens.
	/\bv1\.0-[A-Za-z0-9-]{40,}/g,
	// GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_.
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
];

// URL basic-auth credentials: keep the scheme, redact `user:pass@`.
const URL_BASIC_AUTH_RE = /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi;

// Long opaque secrets: standalone base64url/hex runs >= 40 chars. Anchored on
// word boundaries. The 40-char floor already excludes UUIDs (<= 36 chars). A
// secondary entropy gate (must contain both a letter and a digit) rejects
// monotonous runs (e.g. "xxxx…") and long all-alpha words, so normal prose is
// left intact while high-entropy keys/hashes are caught.
const LONG_OPAQUE_SECRET_RE = /\b[A-Za-z0-9_-]{40,}\b/g;
const HAS_LETTER_RE = /[A-Za-z]/;
const HAS_DIGIT_RE = /[0-9]/;

// Email addresses — only redacted when REDACT_PII is true.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Redact high-confidence secret VALUES embedded anywhere in a string. Additive
 * to the key-name scrub: covers secrets passed under innocuous keys, in URLs,
 * or in free text. Conservative by design — prefers leaving normal prose / IDs
 * untouched over over-redaction. Never throws.
 */
export function redactSecretValues(s: string): string {
	let out = s;
	out = out.replace(URL_BASIC_AUTH_RE, `$1${REDACTED}@`);
	for (const re of SECRET_VALUE_PATTERNS) {
		out = out.replace(re, REDACTED);
	}
	// Long opaque run is the broadest pattern; run it last so already-redacted
	// markers stay intact. Only redact runs with mixed letter+digit entropy.
	out = out.replace(LONG_OPAQUE_SECRET_RE, (m) =>
		HAS_LETTER_RE.test(m) && HAS_DIGIT_RE.test(m) ? REDACTED : m,
	);
	if (REDACT_PII) {
		out = out.replace(EMAIL_RE, REDACTED);
	}
	return out;
}

/**
 * Truncate a UTF-8 string to at most `maxBytes` bytes, cutting on a char
 * boundary (never splits a multi-byte code point).
 */
function truncateToBytes(value: string, maxBytes: number): string {
	const encoder = new TextEncoder();
	const full = encoder.encode(value);
	if (full.length <= maxBytes) return value;

	// Walk back from maxBytes to a UTF-8 lead-byte boundary. Continuation
	// bytes are 0b10xxxxxx (0x80–0xBF); a boundary is any byte that is not a
	// continuation byte.
	let end = maxBytes;
	while (end > 0 && ((full[end] ?? 0) & 0xc0) === 0x80) {
		end--;
	}
	return new TextDecoder().decode(full.subarray(0, end));
}

/**
 * JSON-stringify `value` with sensitive keys redacted, returning the
 * redacted JSON (truncated to `maxBytes`), the original (pre-truncation)
 * UTF-8 byte length, and whether truncation occurred.
 *
 * Non-serializable input (circular refs, BigInt, etc.) degrades gracefully
 * to the literal "[unserializable]".
 */
export function redactAndTruncate(
	value: unknown,
	maxBytes = 16384,
): { json: string; bytes: number; truncated: boolean } {
	let json: string;
	try {
		json =
			JSON.stringify(value, (key, val) => {
				if (key && SENSITIVE_KEY_RE.test(key)) return REDACTED;
				// Value-level scrub of string leaves (secrets under innocuous keys,
				// in URLs, or in free text). Non-strings pass through untouched.
				return typeof val === "string" ? redactSecretValues(val) : val;
			}) ?? "null";
	} catch {
		json = "[unserializable]";
	}

	// `bytes` reports the original serialized UTF-8 length (pre value-level
	// redaction) so capture sizing reflects how big the real payload was.
	const bytes = new TextEncoder().encode(json).length;

	// Final post-pass over the serialized string: catches secrets that survived
	// inside nested/stringified JSON (a string value that is itself JSON gets
	// re-escaped, so per-leaf redaction can miss the inner secret).
	json = redactSecretValues(json);

	// Truncation is computed against the final redacted string so the emitted
	// `json` never exceeds `maxBytes`.
	if (new TextEncoder().encode(json).length <= maxBytes) {
		return { json, bytes, truncated: false };
	}
	return { json: truncateToBytes(json, maxBytes), bytes, truncated: true };
}

/**
 * Flat forensics record. All fields are always present so the downstream
 * R2-SQL schema is stable (no optional columns).
 */
export interface PayloadCaptureRecord {
	traceId: string;
	executionId: string;
	appId: string;
	appSlug: string;
	organizationId: string;
	toolName: string;
	eventType: "tool_call" | "prompt_get";
	success: 1 | 0;
	errorCode: string;
	durationMs: number;
	timestamp: string;
	userId: string;
	tediId: string;
	authType: string;
	inputArgs: string;
	inputBytes: number;
	outputBody: string;
	outputBytes: number;
	truncated: 1 | 0;
}

/**
 * Minimal env surface this module reads. The payload stream secrets are
 * intentionally absent from generated CloudflareEnv when the feature is off, so
 * keep the parameter as a plain object and read optional keys defensively.
 */
type PayloadCaptureEnv = object;

type PayloadCaptureEnvKey =
	| "MCP_PAYLOAD_STREAM_ENDPOINT"
	| "MCP_PAYLOAD_STREAM_TOKEN"
	| "MCP_PAYLOAD_CAPTURE_DEFAULT";

function readPayloadCaptureEnv(
	env: PayloadCaptureEnv,
	key: PayloadCaptureEnvKey,
): string | undefined {
	const value = (env as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

/**
 * Resolve per-org/app payload-capture consent (P1.6 consent gate).
 * `true`/`false` on the app's `mcpConfig.capturePayloads` is authoritative;
 * `undefined` falls back to the platform default (`MCP_PAYLOAD_CAPTURE_DEFAULT`,
 * default on). Metrics/audit are never gated by this — only payload bodies.
 */
export function payloadCaptureAllowed(
	env: PayloadCaptureEnv,
	capturePayloads: boolean | undefined,
): boolean {
	if (capturePayloads === true) return true;
	if (capturePayloads === false) return false;
	return readPayloadCaptureEnv(env, "MCP_PAYLOAD_CAPTURE_DEFAULT") !== "off";
}

/** Minimal ctx surface — `waitUntil` is used when available. */
interface PayloadCaptureCtx {
	waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Fire-and-forget POST of a single forensics record to the configured
 * payload stream endpoint.
 *
 * NO-OP unless both endpoint and token are set and the app/org consents
 * (`capturePayloads`: per-app override, else platform default). Never throws,
 * never blocks. The record is wrapped in a one-element array to match the batch
 * ingest contract of the R2-SQL stream sink.
 */
export function capturePayloadRecord(
	env: PayloadCaptureEnv,
	ctx: PayloadCaptureCtx | undefined,
	record: PayloadCaptureRecord,
	capturePayloads?: boolean,
): void {
	const endpoint = readPayloadCaptureEnv(env, "MCP_PAYLOAD_STREAM_ENDPOINT");
	const token = readPayloadCaptureEnv(env, "MCP_PAYLOAD_STREAM_TOKEN");
	if (!endpoint || !token) return;
	// P1.6 consent gate: skip payload bodies for non-consenting orgs/apps.
	if (!payloadCaptureAllowed(env, capturePayloads)) return;

	const send = fetch(endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify([record]),
	})
		.then(() => undefined)
		.catch(() => undefined);

	if (ctx?.waitUntil) {
		ctx.waitUntil(send);
	} else {
		void send;
	}
}
