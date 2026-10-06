import { describe, expect, it } from "vite-plus/test";
import {
	CODEMODE_TRUNCATION_MARKER,
	boundCodeModeLogs,
	projectCodeModeOutputForModel,
	isTruncatedCodeModeResult,
	shapeBoundedCodeModeResult,
	stringifyBoundedCodeModeResult,
	type TruncatedCodeModeResult,
} from "./bounded-result";

/** A structured page large enough to blow the default 24k-char budget. */
function oversizedPage(rows = 400): { data: Record<string, unknown>[] } {
	return {
		data: Array.from({ length: rows }, (_, i) => ({
			id: `item-${i}`,
			title: `work item ${i} with a moderately long descriptive title`,
			description: "long description body ".repeat(10),
			status: "accepted",
		})),
	};
}

describe("shapeBoundedCodeModeResult", () => {
	it("passes a within-budget structured result through by reference (byte-identical)", () => {
		const value = { data: [{ id: "a", title: "small" }] };
		expect(shapeBoundedCodeModeResult(value)).toBe(value);
	});

	it("measures structured values using the upstream compact JSON budget", () => {
		const value = { rows: Array.from({ length: 100 }, (_, id) => ({ id })) };
		const maxChars = JSON.stringify(value).length;
		expect(JSON.stringify(value, null, 2).length).toBeGreaterThan(maxChars);
		expect(shapeBoundedCodeModeResult(value, { maxChars })).toBe(value);
	});

	it("passes non-finite and nullish values through without false truncation", () => {
		for (const value of [NaN, Infinity, -Infinity, null, undefined]) {
			expect(shapeBoundedCodeModeResult(value)).toBe(value);
		}
	});

	it("passes a within-budget string through unchanged", () => {
		const value = "a perfectly ordinary string result";
		expect(shapeBoundedCodeModeResult(value)).toBe(value);
	});

	it("passes an unserializable value through unchanged", () => {
		const value = { big: 10n };
		expect(shapeBoundedCodeModeResult(value)).toBe(value);
	});

	it("wraps an oversized structured result in a detectable envelope, not a bare string", () => {
		const value = oversizedPage();
		const serialized = JSON.stringify(value);
		expect(serialized.length).toBeGreaterThan(24_000);

		const shaped = shapeBoundedCodeModeResult(value);
		expect(typeof shaped).not.toBe("string");
		expect(isTruncatedCodeModeResult(shaped)).toBe(true);
		const envelope = shaped as TruncatedCodeModeResult;
		expect(envelope.__tedix_truncated).toBe(true);
		expect(envelope.marker).toBe(CODEMODE_TRUNCATION_MARKER);
		expect(envelope.originalType).toBe("object");
		expect(envelope.maxTokens).toBe(6_000);
		expect(envelope.approxTokens).toBeGreaterThan(6_000);
		expect(envelope.guidance).toContain("truncated");
		// The upstream partial structure is retained as parseable compact JSON.
		expect(envelope.preview.length).toBeLessThanOrEqual(24_000);
		expect(envelope.preview).toContain(CODEMODE_TRUNCATION_MARKER);
		expect(Array.isArray(JSON.parse(envelope.preview).data)).toBe(true);
	});

	it("marks an oversized array with originalType array", () => {
		const shaped = shapeBoundedCodeModeResult(oversizedPage().data);
		expect(isTruncatedCodeModeResult(shaped)).toBe(true);
		expect((shaped as TruncatedCodeModeResult).originalType).toBe("array");
		expect(
			Array.isArray(JSON.parse((shaped as TruncatedCodeModeResult).preview)),
		).toBe(true);
	});

	it("wraps an oversized plain string too", () => {
		const shaped = shapeBoundedCodeModeResult("x".repeat(30_000));
		expect(isTruncatedCodeModeResult(shaped)).toBe(true);
		const envelope = shaped as TruncatedCodeModeResult;
		expect(envelope.originalType).toBe("string");
		expect(envelope.preview.length).toBeLessThanOrEqual(24_000);
	});

	it("preserves legitimate marker text inside a clipped string", () => {
		const prefix = `user text\n\n${CODEMODE_TRUNCATION_MARKER}\nResponse was ~99 tokens (limit: 1)`;
		const shaped = shapeBoundedCodeModeResult(prefix + "x".repeat(1_000), {
			maxChars: 200,
		}) as TruncatedCodeModeResult;
		expect(shaped.preview).toBe((prefix + "x".repeat(1_000)).slice(0, 200));
		expect(shaped.maxTokens).toBe(50);
	});

	it("reports the actual character budget without parsing upstream marker prose", () => {
		const value = "x".repeat(1_000);
		const shaped = shapeBoundedCodeModeResult(value, {
			maxChars: 400,
		}) as TruncatedCodeModeResult;
		expect(shaped.approxTokens).toBe(250);
		expect(shaped.maxTokens).toBe(100);
		expect(shaped.preview).toBe("x".repeat(400));
	});

	it("honors an explicit maxTokens override", () => {
		const value = { note: "n".repeat(1_000) };
		expect(shapeBoundedCodeModeResult(value)).toBe(value);
		const shaped = shapeBoundedCodeModeResult(value, { maxTokens: 100 });
		expect(isTruncatedCodeModeResult(shaped)).toBe(true);
		const envelope = shaped as TruncatedCodeModeResult;
		expect(envelope.maxTokens).toBe(100);
		expect(envelope.preview.length).toBeLessThanOrEqual(400);
	});
});

describe("isTruncatedCodeModeResult", () => {
	it("rejects lookalikes without the discriminant or preview", () => {
		expect(isTruncatedCodeModeResult({ truncated: true })).toBe(false);
		expect(isTruncatedCodeModeResult({ __tedix_truncated: true })).toBe(false);
		expect(isTruncatedCodeModeResult("--- TRUNCATED ---")).toBe(false);
		expect(isTruncatedCodeModeResult(null)).toBe(false);
	});
});

describe("stringifyBoundedCodeModeResult", () => {
	it("serializes a small output byte-identically to JSON.stringify(value, null, 2)", () => {
		const output = { executionId: "e-1", result: { ok: true } };
		expect(stringifyBoundedCodeModeResult(output)).toBe(
			JSON.stringify(output, null, 2),
		);
	});

	it("never re-clips an output whose inner result is an already-shaped envelope", () => {
		const inner = shapeBoundedCodeModeResult(oversizedPage());
		expect(isTruncatedCodeModeResult(inner)).toBe(true);
		const output = { executionId: "e-2", result: inner };
		const text = stringifyBoundedCodeModeResult(output);
		// The full envelope (including the whole preview) survives serialization.
		expect(text).toBe(JSON.stringify(output, null, 2));
		expect(JSON.parse(text).result.__tedix_truncated).toBe(true);
	});

	it("still bounds a pathological output (e.g. megabyte sandbox logs) detectably", () => {
		const output = {
			executionId: "e-3",
			result: null,
			logs: Array.from(
				{ length: 2_000 },
				(_, i) => `log line ${i} ${"x".repeat(500)}`,
			),
		};
		const text = stringifyBoundedCodeModeResult(output);
		expect(text.length).toBeLessThan(120_000);
		expect(text).toContain("__tedix_truncated");
	});
});

describe("model output projection", () => {
	it("bounds logs while retaining raw audit evidence and operational fields", () => {
		const logs = Array.from({ length: 200 }, () => "x".repeat(500));
		const output = {
			status: "paused",
			executionId: "e-1",
			pending: [{ seq: 1, method: "write", args: { id: "a" } }],
			calls: [{ result: "audit-only" }],
			logs,
		};
		const projected = projectCodeModeOutputForModel(output);
		expect(projected.type).toBe("json");
		expect(projected.value).toMatchObject({
			status: "paused",
			executionId: "e-1",
			pending: output.pending,
		});
		expect(projected.value).not.toHaveProperty("calls");
		expect(JSON.stringify(projected.value)).not.toContain("audit-only");
		expect(
			JSON.stringify((projected.value as Record<string, unknown>).logs).length,
		).toBeLessThanOrEqual(24_000);
		expect(output.calls).toEqual([{ result: "audit-only" }]);
		expect(output.logs).toBe(logs);
		expect(JSON.stringify(logs).length).toBeGreaterThan(24_000);
	});

	it("serializes BigInt and missing output without failing a completed run", () => {
		expect(projectCodeModeOutputForModel({ result: { count: 42n } })).toEqual({
			type: "json",
			value: { result: { count: "42" } },
		});
		expect(projectCodeModeOutputForModel(undefined)).toEqual({
			type: "json",
			value: null,
		});
	});

	it("returns an explicit serialization error when preparing output invokes a throwing getter", () => {
		const output = {
			get result() {
				throw new Error("result unavailable");
			},
		};
		expect(projectCodeModeOutputForModel(output)).toMatchObject({
			type: "json",
			value: { error: expect.stringContaining("could not be serialized") },
		});
	});

	it("returns an explicit serialization error for cyclic results", () => {
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(projectCodeModeOutputForModel({ result: cyclic })).toMatchObject({
			type: "json",
			value: { error: expect.stringContaining("could not be serialized") },
		});
	});

	it("bounds MCP logs and retains the string array contract", () => {
		const logs = Array.from({ length: 200 }, () => '\"'.repeat(500));
		const bounded = boundCodeModeLogs(logs);
		expect(bounded.every((entry) => typeof entry === "string")).toBe(true);
		expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(24_000);
		expect(JSON.stringify(bounded)).toContain(CODEMODE_TRUNCATION_MARKER);
		const small = ["ok"];
		expect(boundCodeModeLogs(small)).toBe(small);
	});
});
