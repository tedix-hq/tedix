import { describe, expect, it } from "vite-plus/test";
import { codeModeLiteral } from "./code-mode-literal";

const evaluate = (literal: string) => new Function(`return ${literal}`)();

describe("codeModeLiteral", () => {
	it("matches JSON.stringify for ordinary inputs", () => {
		for (const value of [
			null,
			0,
			-1.5,
			true,
			"plain",
			["a", 1, null],
			{ candidates: [{ text: "x", quote: "y" }], limit: 100 },
			"org_00000000-0000-4000-8000-000000000001",
		])
			expect(codeModeLiteral(value)).toBe(JSON.stringify(value));
	});

	it("round-trips nested objects and hostile strings through evaluation", () => {
		const value = {
			nested: { list: [1, "two", { three: null }], empty: {} },
			script: "</script><script>alert(1)</script>",
			separators: "a\u2028b\u2029c",
			quotes: `"double" 'single' \`back\``,
			backslashes: "C:\\path\\to\\file \\u2028 literal",
			unicode: "héllo 😀 \0 \t\n\r",
			template: "${process.exit(1)}",
		};
		const literal = codeModeLiteral(value);
		expect(literal).not.toContain("\u2028");
		expect(literal).not.toContain("\u2029");
		expect(literal).not.toContain("</");
		expect(evaluate(literal)).toEqual(value);
	});

	it("keeps the literal a single expression inside a template body", async () => {
		const literal = codeModeLiteral({ runId: "run-1\u2028" });
		const body = `return (async () => { const detail = await home(${literal}); return detail; })()`;
		expect(body.split(/\r?\n|\u2028|\u2029/)).toHaveLength(1);
		await expect(
			new Function("home", body)(async (input: unknown) => input),
		).resolves.toEqual({ runId: "run-1\u2028" });
	});

	it("rejects values without a JSON literal", () => {
		expect(() => codeModeLiteral(undefined)).toThrow(/undefined has no JSON/);
		expect(() => codeModeLiteral(() => 1)).toThrow(/function has no JSON/);
		expect(() => codeModeLiteral(Symbol("s"))).toThrow(/symbol has no JSON/);
		expect(() => codeModeLiteral(10n)).toThrow(/BigInt/);
		expect(() => codeModeLiteral({ big: 10n })).toThrow(TypeError);
	});
});
