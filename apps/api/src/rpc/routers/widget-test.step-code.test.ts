import { describe, expect, it } from "vite-plus/test";
import { buildStepCode, pythonString } from "./widget-test";

const HOSTILE = `x\\")\nimport os; os.system("id") #{__import__('os')}'`;

describe("pythonString", () => {
	it("round-trips hostile text as one quoted literal", () => {
		const literal = pythonString(HOSTILE);
		expect(literal.startsWith('"')).toBe(true);
		expect(literal.endsWith('"')).toBe(true);
		expect(literal).not.toContain("\n");
		expect(JSON.parse(literal)).toBe(HOSTILE);
	});
});

describe("buildStepCode", () => {
	it("never splices caller text outside a string literal", () => {
		const steps = [
			{ action: "click", text: HOSTILE, index: 0 },
			{ action: "click", selector: HOSTILE, index: 0 },
			{ action: "type", selector: HOSTILE, text: HOSTILE },
			{ action: "press", key: HOSTILE },
			{ action: "waitFor", selector: HOSTILE, state: "visible", timeout: 500 },
			{ action: "assert", selector: HOSTILE, visible: true, text: HOSTILE },
			{ action: "assert", selector: HOSTILE, count: 2 },
			{ action: "scroll", selector: HOSTILE, x: 0, y: 300 },
		] as const;
		for (const step of steps) {
			const code = buildStepCode(step);
			// The hostile newline must stay escaped, so no injected statement line.
			expect(
				code.split("\n").some((line) => line.startsWith("import os")),
			).toBe(false);
			// Raw text appears only inside its JSON-encoded literal.
			expect(code.replaceAll(pythonString(HOSTILE), "")).not.toContain(
				"__import__",
			);
		}
	});

	it("binds asserted text to variables instead of f-string interpolation", () => {
		const code = buildStepCode({
			action: "assert",
			selector: ".a",
			text: "{secret}",
		});
		expect(code).toContain('expected_text = "{secret}"');
		expect(code).toContain("f\"Expected text '{expected_text}' in {sel}");
	});
});
