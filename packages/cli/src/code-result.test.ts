import { describe, expect, test } from "bun:test";
import {
	codeDiscoveryErrorMessage,
	codeOutputValue,
	formatCodeValue,
	normalizeCodeResult,
	truncationErrorMessage,
} from "./code-result";

// The structured truncation envelope Tedix gateways emit
// (packages/tedi-codemode-core/src/bounded-result.ts).
const ENVELOPE = {
	__tedix_truncated: true,
	marker: "--- TRUNCATED ---",
	originalType: "object",
	approxTokens: 14_735,
	maxTokens: 6_000,
	guidance:
		"Result truncated by the Code Mode gateway: ~14,735 tokens (limit 6,000). Narrow the projection, request fewer fields, or paginate.",
	preview: '{"data":[{"a":1},{"a":2}',
};

describe("normalizeCodeResult: envelope extraction", () => {
	test("{executionId, result:2} → {executionId, value:2}", () => {
		expect(normalizeCodeResult({ executionId: "exec-1", result: 2 })).toEqual({
			executionId: "exec-1",
			value: 2,
		});
	});

	test("{executionId, result:'[{\"a\":1}]'} → parsed value [{a:1}]", () => {
		const out = normalizeCodeResult({
			executionId: "exec-2",
			result: '[{"a":1}]',
		});
		expect(out.executionId).toBe("exec-2");
		expect(out.value).toEqual([{ a: 1 }]);
		expect(out.truncationHint).toBeUndefined();
	});

	test("envelope without executionId omits the key", () => {
		const out = normalizeCodeResult({ result: 5 });
		expect(out).toEqual({ value: 5 });
		expect("executionId" in out).toBe(false);
	});

	test("non-string structured result passes through unparsed", () => {
		const out = normalizeCodeResult({
			executionId: "e",
			result: { a: 1 },
			resultIdentity: { runId: "run-1" },
			logs: [{ tool: "example.read" }],
		});
		expect(out.value).toEqual({ a: 1 });
		expect(out.executionId).toBe("e");
		expect(out.resultIdentity).toEqual({ runId: "run-1" });
		expect(out.logs).toEqual([{ tool: "example.read" }]);
	});

	test("non-envelope raw value is used as the candidate", () => {
		expect(normalizeCodeResult(42)).toEqual({ value: 42 });
		expect(normalizeCodeResult(null)).toEqual({ value: null });
	});
});

describe("codeOutputValue", () => {
	test("keeps default output byte-compatible with the inner value", () => {
		const normalized = normalizeCodeResult({
			executionId: "exec-1",
			result: { ok: true },
		});
		expect(codeOutputValue(normalized, false)).toEqual({ ok: true });
	});

	test("opt-in metadata restores the bounded gateway envelope", () => {
		const normalized = normalizeCodeResult({
			executionId: "exec-1",
			result: { ok: true },
			resultIdentity: { runId: "run-1" },
			logs: ["called example.read"],
		});
		expect(codeOutputValue(normalized, true)).toEqual({
			executionId: "exec-1",
			result: { ok: true },
			resultIdentity: { runId: "run-1" },
			logs: ["called example.read"],
		});
	});
});

describe("codeDiscoveryErrorMessage", () => {
	test("adds discover-first recovery for an unknown namespace", () => {
		const message = codeDiscoveryErrorMessage(
			"ReferenceError: google_gmail_tedix is not defined",
		);
		expect(message).toContain("discover.search");
		expect(message).toContain("use it verbatim");
	});

	test("does not duplicate gateway guidance", () => {
		const original =
			'Tool "send_mail" not found. Run discover.search({ query: "send mail" })';
		expect(codeDiscoveryErrorMessage(original)).toBe(original);
	});

	test("does not decorate unrelated execution failures", () => {
		const original = "Execution timed out";
		expect(codeDiscoveryErrorMessage(original)).toBe(original);
	});
});

describe("normalizeCodeResult: structured truncation envelope", () => {
	test("envelope → truncated flag, guidance hint, preview surfaced as the value", () => {
		const out = normalizeCodeResult({
			executionId: "exec-9",
			result: ENVELOPE,
		});
		expect(out.executionId).toBe("exec-9");
		expect(out.truncated).toBe(true);
		expect(out.approxTokens).toBe(14_735);
		expect(out.truncationHint).toBe(ENVELOPE.guidance);
		expect(out.value).toBe(ENVELOPE.preview);
	});

	test("envelope without guidance/approxTokens still yields a usable hint", () => {
		const out = normalizeCodeResult({
			result: { __tedix_truncated: true, preview: "clipped" },
		});
		expect(out.truncated).toBe(true);
		expect(out.approxTokens).toBeUndefined();
		expect(out.truncationHint).toContain("truncated");
		expect(out.value).toBe("clipped");
	});

	test("an ordinary record with truncated-ish keys is NOT mistaken for the envelope", () => {
		const value = { truncated: true, preview: "just data" };
		const out = normalizeCodeResult({ result: value });
		expect(out.truncated).toBeUndefined();
		expect(out.value).toEqual(value);
	});
});

describe("truncationErrorMessage", () => {
	test("includes the approximate size when known", () => {
		expect(truncationErrorMessage({ approxTokens: 9_999 })).toBe(
			"result truncated by gateway (~9,999 tokens): narrow the projection or paginate",
		);
	});

	test("omits the size when unknown", () => {
		expect(truncationErrorMessage({})).toBe(
			"result truncated by gateway: narrow the projection or paginate",
		);
	});
});

describe("normalizeCodeResult: plain string passthrough", () => {
	test("plain non-JSON string passes through unchanged", () => {
		const out = normalizeCodeResult({
			executionId: "e",
			result: "hello world",
		});
		expect(out.value).toBe("hello world");
		expect(out.truncationHint).toBeUndefined();
	});

	test("top-level non-JSON string passes through", () => {
		const out = normalizeCodeResult("just some text");
		expect(out.value).toBe("just some text");
		expect(out.executionId).toBeUndefined();
	});

	test("never throws on hostile input", () => {
		expect(() => normalizeCodeResult(undefined)).not.toThrow();
		expect(() => normalizeCodeResult([1, 2, 3])).not.toThrow();
		expect(normalizeCodeResult([1, 2, 3]).value).toEqual([1, 2, 3]);
	});
});

describe("formatCodeValue", () => {
	test("json=true → compact JSON", () => {
		expect(formatCodeValue([{ a: 1 }], { json: true })).toBe('[{"a":1}]');
	});

	test("json=false → 2-space pretty JSON", () => {
		expect(formatCodeValue([{ a: 1 }], { json: false })).toBe(
			JSON.stringify([{ a: 1 }], null, 2),
		);
		expect(formatCodeValue([{ a: 1 }], { json: false })).toContain("\n");
	});

	test("plain string prints raw (not JSON-quoted) in pretty mode", () => {
		expect(formatCodeValue("plain text", { json: false })).toBe("plain text");
	});

	test("plain string is JSON-quoted in json mode", () => {
		expect(formatCodeValue("plain text", { json: true })).toBe('"plain text"');
	});

	test("number renders without quotes in both modes", () => {
		expect(formatCodeValue(2, { json: false })).toBe("2");
		expect(formatCodeValue(2, { json: true })).toBe("2");
	});

	test("fail-soft on circular value (does not throw, returns a string)", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(typeof formatCodeValue(circular, { json: true })).toBe("string");
	});
});

test("discovery recovery preserves the selected target and shell-quotes values", () => {
	const hint = codeDiscoveryErrorMessage("missing is not defined", {
		workspace: "team's",
		organization: "org_tedix",
		url: "https://connect.mcp.tedix.dev/mcp",
	});
	expect(hint).toContain("-w 'team'\\''s'");
	expect(hint).toContain("--organization 'org_tedix'");
	expect(hint).toContain("--url 'https://connect.mcp.tedix.dev/mcp'");
});
