/**
 * Trace-safety redaction regression. Raw traces are the highest-risk artifact
 * class, so this guards the load-bearing guarantees: sensitive KEYS redacted but
 * token-accounting allowlisted; embedded secret SHAPES (Bearer/JWT/sk_/cookie/
 * signed-URL/inline) scrubbed from both free text and string values; known
 * secrets removed longest-first; the sentinel guard; and FAIL-CLOSED file
 * redaction (a throw must never leak raw content).
 * Run: `bun run src/trace-safety.test.ts`.
 */
import assert from "node:assert/strict";
import {
	DEFAULT_TRACE_SAFETY_POLICY,
	TEDIX_REDACTED,
	assertNoSentinel,
	isSensitiveKey,
	redactBundleFile,
	redactValue,
	scrubKnownSecrets,
	scrubText,
	traceSafetyPolicyId,
} from "./trace-safety";

const R = TEDIX_REDACTED;

// ── policy identity ───────────────────────────────────────────────────────────
assert.equal(traceSafetyPolicyId(), "trace_policy_v1");
assert.equal(DEFAULT_TRACE_SAFETY_POLICY.orgScoped, true);
assert.ok(DEFAULT_TRACE_SAFETY_POLICY.allowlistSuffixes.includes("maxtokens"));

// ── sensitive KEY detection + allowlist ──────────────────────────────────────
assert.equal(isSensitiveKey("authToken"), true);
assert.equal(isSensitiveKey("apiKey"), true);
assert.equal(isSensitiveKey("password"), true);
assert.equal(isSensitiveKey("Authorization"), true);
assert.equal(isSensitiveKey("set-cookie"), true);
assert.equal(isSensitiveKey("privateKey"), true);
// allowlist: token-accounting fields are NOT secrets
assert.equal(isSensitiveKey("maxTokens"), false);
assert.equal(isSensitiveKey("totalTokens"), false);
assert.equal(isSensitiveKey("tokenCount"), false);
// plain fields untouched
assert.equal(isSensitiveKey("model"), false);
assert.equal(isSensitiveKey("content"), false);

// ── structured redaction: sensitive values → sentinel, allowlist + plain kept ─
{
	const redacted = redactValue({
		model: "tedi-system1",
		maxTokens: 4096,
		apiKey: "sk_live_abcdef0123456789",
		nested: { authorization: "Bearer xyz", totalTokens: 12 },
		messages: [{ role: "user", token: "should-redact" }],
	}) as Record<string, unknown>;
	assert.equal(redacted.model, "tedi-system1");
	assert.equal(redacted.maxTokens, 4096, "allowlisted key value preserved");
	assert.equal(redacted.apiKey, R, "sensitive key value redacted");
	const nested = redacted.nested as Record<string, unknown>;
	assert.equal(nested.authorization, R);
	assert.equal(nested.totalTokens, 12);
	const msg0 = (redacted.messages as Array<Record<string, unknown>>)[0]!;
	assert.equal(msg0.role, "user");
	assert.equal(msg0.token, R, "sensitive key inside array element redacted");
}

// ── value-shape scrubbing in FREE TEXT (dual-path) ───────────────────────────
assert.equal(
	scrubText("call with Authorization: Bearer abc.def-123 please"),
	`call with Authorization: Bearer ${R} please`,
	"bearer token scrubbed, label kept",
);
assert.ok(
	scrubText("jwt eyJhbGc.eyJzdWIi.sig-part here").includes(R),
	"JWT scrubbed",
);
assert.equal(
	scrubText("key=sk_live_0123456789abcdef done"),
	`key=${R} done`,
	"sk_ key scrubbed",
);
assert.equal(
	scrubText("Cookie: DS=secretsession; other=ok"),
	`Cookie: DS=${R}; other=ok`,
	"DS cookie value scrubbed, name kept, other kept",
);
assert.equal(
	scrubText("https://r2/x?X-Amz-Signature=deadbeef&z=1"),
	`https://r2/x?X-Amz-Signature=${R}&z=1`,
	"signed-url param scrubbed, other params kept",
);
assert.equal(
	scrubText('config api_key="supersecretvalue"'),
	`config api_key="${R}"`,
	"inline api_key assignment scrubbed, label + quotes kept",
);
// false-positive guard: token-accounting prose must NOT be scrubbed
assert.equal(
	scrubText("maxTokens: 4096 and tokenCount=12"),
	"maxTokens: 4096 and tokenCount=12",
);

// ── string VALUES inside objects get the same text scrub ─────────────────────
{
	const out = redactValue({ note: "use Bearer abc123 to auth" }) as Record<
		string,
		string
	>;
	assert.equal(out.note, `use Bearer ${R} to auth`);
}

// ── known-secret longest-first replacement ───────────────────────────────────
assert.equal(
	scrubKnownSecrets("tok=ABCDEF and ABCDEFGHIJ longer", [
		"ABCDEF",
		"ABCDEFGHIJ",
	]),
	`tok=${R} and ${R} longer`,
	"longest-first prevents partial leak of the longer secret",
);
assert.equal(
	scrubKnownSecrets("nothing here", ["zz"]),
	"nothing here",
	"short secrets ignored",
);

// ── idempotent: re-scrub is a no-op ──────────────────────────────────────────
{
	const once = scrubText("Bearer abc.def");
	assert.equal(
		scrubText(once),
		once,
		"re-scrubbing already-redacted text is stable",
	);
}

// ── sentinel guard ───────────────────────────────────────────────────────────
assert.doesNotThrow(() => assertNoSentinel({ a: "fine", b: [1, "ok"] }));
assert.throws(
	() => assertNoSentinel({ a: { b: `leaked ${R}` } }),
	/sentinel/i,
	"sentinel present as data must throw",
);

// ── redactBundleFile: string + object happy path ─────────────────────────────
{
	const md = redactBundleFile("output.md", "reply (Bearer zzz.yyy)");
	assert.equal(md.redactionFailed, false);
	assert.ok(md.content.includes(R) && !md.content.includes("zzz.yyy"));

	const json = redactBundleFile("manifest.json", {
		model: "m",
		secret: "s3cretvalue",
	});
	assert.equal(json.redactionFailed, false);
	const parsed = JSON.parse(json.content);
	assert.equal(parsed.model, "m");
	assert.equal(parsed.secret, R);
}

// ── redactBundleFile FAIL-CLOSED: a throw yields a marker, never raw ─────────
{
	// A BigInt is not JSON-serialisable → JSON.stringify throws inside redaction.
	const poison = { evil: BigInt(1), secretText: "Bearer rawtoken.here" };
	const file = redactBundleFile("prompt.json", poison);
	assert.equal(file.redactionFailed, true, "redaction failure flagged");
	assert.ok(
		!file.content.includes("rawtoken"),
		"raw secret NEVER emitted on failure",
	);
	const parsed = JSON.parse(file.content);
	assert.equal(parsed.redactionFailed, true);
}

console.log("trace-safety.test.ts: all assertions passed");
