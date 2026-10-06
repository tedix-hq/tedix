/**
 * Trace safety — the enforcement a trace writer MUST run before any raw prompt,
 * tool payload, or model output is committed to R2 / Artifacts
 * (`TraceBundle.bundleUri`). Raw traces are the highest-risk artifact class in
 * the system (`docs/cognition/harness.md` § Trace Safety Contract), so nothing raw is
 * written until this module has redacted it.
 *
 * BODY-NEUTRAL + PURE: no I/O, no SDK, no zod at runtime. Runtime writers call
 * the same functions so the redaction guarantee is identical across bodies.
 *
 * Grounded in the platform redaction model:
 *   - redact-at-write, per value, replacing with a reserved SENTINEL
 *   - a sensitive-KEY allowlist so token-accounting fields (`maxTokens`,
 *     `tokenCount`, …) are NOT redacted by a naive `/token$/` pattern
 *   - DUAL-PATH scrub: structured object keys AND embedded secrets in raw text
 *   - longest-first replacement of KNOWN secret values (the tedi's own tokens)
 *   - a sentinel guard (`assertNoSentinel`) so a redacted marker can never be
 *     read back as real data
 *   - FAIL-CLOSED: if redaction throws, the writer emits a failure marker, never
 *     the raw content
 *
 * Tedix-specific value scrubbers target the secret SHAPES that actually appear
 * in our traces: `Authorization: Bearer …`, Descope/JWT (`eyJ…`), `sk_`/`sk-`
 * API keys, the `DS`/`DSR`/`DS_AUTH`/`tedix_gateway_token*` cookies, AWS-style
 * signed-URL params, and inline `api_key=`/`secret:` assignments.
 */

/**
 * Local structural mirror of `@tedix/api-contract`'s `TraceSafetyPolicySchema`.
 * Defined here (not imported) so the lower-level `context-core` keeps zero deps
 * and the layering stays one-directional. The zod schema in api-contract is the
 * persistence/validation shape; these two MUST stay structurally aligned (kept
 * trivially in sync — the policy rarely changes; bump `id`+`version` together).
 */
export interface TraceSafetyPolicy {
	id: string;
	version: string;
	redactedSentinel: string;
	sensitiveKeyPatterns: string[];
	allowlistSuffixes: string[];
	valueScrubbers: Array<{ name: string; pattern: string }>;
	retention: { rawPayloadDays: number; summaryDays: number };
	orgScoped: true;
}

/** Reserved replacement token. Must never appear as legitimate trace data. */
export const TEDIX_REDACTED = "__TEDIX_REDACTED__";

/**
 * Internal scrubber set — the source of truth for value-shape redaction. Each
 * preserves a non-secret labelling prefix (capture group 1) when there is one,
 * so `Bearer xxx` → `Bearer __TEDIX_REDACTED__` stays diagnosable. The policy's
 * `valueScrubbers` is the persisted `{name, pattern}` projection of this list.
 */
interface Scrubber {
	name: string;
	re: RegExp;
	replace: string;
}
const SCRUBBERS: readonly Scrubber[] = [
	// Authorization: Bearer <token>  (keep "Bearer ")
	{
		name: "bearer",
		re: /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
		replace: `$1${TEDIX_REDACTED}`,
	},
	// JWT / Descope session token (eyJ........)
	{
		name: "jwt",
		re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
		replace: TEDIX_REDACTED,
	},
	// sk_live_… (Stripe) / sk-ant-… (Anthropic) / sk-… (OpenAI) provider API keys.
	// Allow `_` and `-` inside the body so `sk_live_…`/`sk-ant-api03-…` match fully.
	{
		name: "sk_key",
		re: /\bsk[_-][A-Za-z0-9_-]{16,}/g,
		replace: TEDIX_REDACTED,
	},
	// Tedix auth cookies (keep the cookie NAME, drop the value)
	{
		name: "tedix_cookie",
		re: /\b(DS|DSR|DS_AUTH|tedix_gateway_token[A-Za-z0-9_]*)=[^;\s"']+/g,
		replace: `$1=${TEDIX_REDACTED}`,
	},
	// AWS / signed-URL credential params (keep "?sig=" / "&token=")
	{
		name: "signed_url",
		re: /([?&](?:X-Amz-Signature|X-Amz-Credential|Signature|sig|token|access_token)=)[^&\s"']+/gi,
		replace: `$1${TEDIX_REDACTED}`,
	},
	// Inline assignments: api_key=…, secret: …, password=… (keep the label)
	{
		name: "inline_secret",
		re: /\b(api[_-]?key|secret|password|access[_-]?token)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{8,}/gi,
		replace: `$1$2${TEDIX_REDACTED}`,
	},
];

/** Key-name patterns whose VALUES are redacted. */
const SENSITIVE_KEY_RE: readonly RegExp[] = [
	/token$/i,
	/password/i,
	/secret/i,
	/api.?key/i,
	/encrypt.?key/i,
	/private.?key/i,
	/authorization/i,
	/cookie/i,
	/credential/i,
];

/** Key suffixes exempt from key-redaction for token-accounting fields. */
const ALLOWLIST_SUFFIXES: readonly string[] = [
	"maxtokens",
	"maxoutputtokens",
	"maxinputtokens",
	"maxcompletiontokens",
	"contexttokens",
	"totaltokens",
	"tokencount",
	"tokenlimit",
	"tokenbudget",
];

/**
 * The canonical policy. `id` is referenced by `HarnessVersion.traceSafetyPolicyId`
 * / `TraceBundle.traceSafetyPolicyId`. Bump `version` + `id` when the scrubber
 * set changes so a stored bundle records exactly which redaction ran.
 */
export const DEFAULT_TRACE_SAFETY_POLICY: TraceSafetyPolicy = {
	id: "trace_policy_v1",
	version: "1",
	redactedSentinel: TEDIX_REDACTED,
	sensitiveKeyPatterns: SENSITIVE_KEY_RE.map((r) => r.source),
	allowlistSuffixes: [...ALLOWLIST_SUFFIXES],
	valueScrubbers: SCRUBBERS.map((s) => ({
		name: s.name,
		pattern: s.re.source,
	})),
	retention: { rawPayloadDays: 14, summaryDays: 365 },
	orgScoped: true,
};

export function traceSafetyPolicyId(
	policy: TraceSafetyPolicy = DEFAULT_TRACE_SAFETY_POLICY,
): string {
	return policy.id;
}

function isAllowlistedKey(key: string): boolean {
	const lower = key.toLowerCase();
	return ALLOWLIST_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** True when a key's VALUE should be redacted wholesale (not allowlisted). */
export function isSensitiveKey(key: string): boolean {
	if (isAllowlistedKey(key)) return false;
	return SENSITIVE_KEY_RE.some((re) => re.test(key));
}

/**
 * Scrub embedded secret SHAPES out of free text (and string values). Idempotent:
 * re-running over already-redacted text is a no-op (the sentinel survives).
 */
export function scrubText(text: string): string {
	let out = text;
	for (const s of SCRUBBERS) {
		// `re` is global; reset lastIndex defensively (shared RegExp objects).
		s.re.lastIndex = 0;
		out = out.replace(s.re, s.replace);
	}
	return out;
}

/**
 * Longest-first replacement of KNOWN secret VALUES (e.g. the tedi's own gateway
 * token / access key, passed by the writer). Longest-first prevents a shorter
 * secret that is a substring of a longer one from leaving a partial leak.
 */
export function scrubKnownSecrets(
	text: string,
	secrets: readonly string[],
): string {
	const real = [...new Set(secrets.filter((s) => s && s.length >= 6))].sort(
		(a, b) => b.length - a.length,
	);
	let out = text;
	for (const secret of real) out = out.split(secret).join(TEDIX_REDACTED);
	return out;
}

/**
 * Deep, dual-path redaction of an arbitrary value:
 *   - object: redact the VALUE at any sensitive key (→ sentinel, unless
 *     allowlisted); recurse into the rest
 *   - array: recurse element-wise
 *   - string: scrub embedded secret shapes (`scrubText`) + any known secrets
 *   - other primitives: pass through
 * Cycles are broken with a seen-set. The input is never mutated.
 */
export function redactValue<T>(
	value: T,
	knownSecrets: readonly string[] = [],
): T {
	const seen = new WeakSet<object>();
	const walk = (v: unknown): unknown => {
		if (typeof v === "string") {
			const scrubbed = knownSecrets.length
				? scrubKnownSecrets(v, knownSecrets)
				: v;
			return scrubText(scrubbed);
		}
		if (v === null || typeof v !== "object") return v;
		if (seen.has(v)) return TEDIX_REDACTED;
		seen.add(v);
		if (Array.isArray(v)) return v.map(walk);
		const out: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
			out[key] = isSensitiveKey(key) ? TEDIX_REDACTED : walk(val);
		}
		return out;
	};
	return walk(value) as T;
}

/**
 * Guard: throw if the reserved sentinel appears anywhere in `value` (deep).
 * Use before treating trace content as REAL data (e.g. on re-ingest) so a
 * redacted marker can never be mistaken for a genuine value.
 */
export function assertNoSentinel(value: unknown, path = ""): void {
	if (typeof value === "string") {
		if (value.includes(TEDIX_REDACTED))
			throw new Error(
				`Reserved redaction sentinel found at ${path || "<root>"} — not valid trace data`,
			);
		return;
	}
	if (value === null || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i += 1) {
			assertNoSentinel(value[i], `${path}[${i}]`);
		}
		return;
	}
	for (const [k, v] of Object.entries(value))
		assertNoSentinel(v, path ? `${path}.${k}` : k);
}

/** A redacted bundle file: original name + redacted content (or a failure marker). */
export interface RedactedFile {
	name: string;
	content: string;
	/** True when redaction threw and the writer must NOT emit the raw content. */
	redactionFailed: boolean;
}

/**
 * FAIL-CLOSED redaction of one bundle file. `content` may be a string (`.md` /
 * `.jsonl`) or a JSON-serialisable object (`.json`). On ANY error the file is
 * replaced with a failure marker — the raw content is never returned. This is
 * the single entry point a writer should use per file.
 */
export function redactBundleFile(
	name: string,
	content: unknown,
	knownSecrets: readonly string[] = [],
): RedactedFile {
	try {
		if (typeof content === "string") {
			const scrubbed = knownSecrets.length
				? scrubKnownSecrets(content, knownSecrets)
				: content;
			return { name, content: scrubText(scrubbed), redactionFailed: false };
		}
		const redacted = redactValue(content, knownSecrets);
		return {
			name,
			content: JSON.stringify(redacted, null, 2),
			redactionFailed: false,
		};
	} catch (err) {
		// Fail-closed: emit a marker, never the unredacted payload.
		return {
			name,
			content: JSON.stringify({
				redactionFailed: true,
				sentinel: TEDIX_REDACTED,
				reason: err instanceof Error ? err.message : String(err),
			}),
			redactionFailed: true,
		};
	}
}
