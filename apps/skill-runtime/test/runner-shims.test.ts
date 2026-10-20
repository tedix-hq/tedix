import { describe, expect, test } from "bun:test";
import { WORKFLOW_FETCH_GATE_MODULE } from "../src/runner-sandbox";

// Evaluate the captured intrinsics and shims without installing the global gate.
const shimSource = WORKFLOW_FETCH_GATE_MODULE.slice(
	WORKFLOW_FETCH_GATE_MODULE.indexOf("const NativePromise"),
	WORKFLOW_FETCH_GATE_MODULE.indexOf("const platformFetch"),
).replace(/\bexport /g, "");
const shims = new Function(
	`${shimSource}; return { workflowString, sliceWorkflowString, stringifyWorkflowJson, digestWorkflowHex, deepFreezeWorkflowValue, freezeWorkflowValue };`,
)();

describe("workflow sandbox shims", () => {
	test("converts primitive values and slices with native string semantics", () => {
		expect(shims.workflowString(null)).toBe("null");
		expect(shims.workflowString(undefined)).toBe("undefined");
		expect(shims.workflowString(Symbol("step"))).toBe("Symbol(step)");
		expect(shims.sliceWorkflowString("workflow", -4)).toBe("flow");
		expect(shims.sliceWorkflowString("workflow", 1, 4)).toBe("ork");
	});

	test("stringifies with replacers and rejects circular JSON", () => {
		expect(shims.stringifyWorkflowJson({ keep: 1, omit: undefined })).toBe(
			'{"keep":1}',
		);
		expect(
			shims.stringifyWorkflowJson(
				{ value: 2 },
				(_key: string, value: unknown) =>
					typeof value === "number" ? value * 3 : value,
			),
		).toBe('{"value":6}');
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => shims.stringifyWorkflowJson(circular)).toThrow(TypeError);
	});

	test("returns lowercase SHA-256 hex for empty and UTF-8 input", async () => {
		expect(await shims.digestWorkflowHex("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
		expect(await shims.digestWorkflowHex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		expect(await shims.digestWorkflowHex("é")).toBe(
			"4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c",
		);
	});

	test("deep freezes cycles and symbol properties, and clones public values", () => {
		const symbol = Symbol("nested");
		const value = {
			nested: [{ count: 1 }],
			[symbol]: { count: 2 },
			self: null as unknown,
		};
		value.self = value;
		expect(shims.deepFreezeWorkflowValue(value, new Set())).toBe(value);
		expect(Object.isFrozen(value)).toBe(true);
		expect(Object.isFrozen(value.nested)).toBe(true);
		expect(Object.isFrozen(value.nested[0])).toBe(true);
		expect(Object.isFrozen(value[symbol])).toBe(true);
		expect(shims.deepFreezeWorkflowValue(null, new Set())).toBeNull();
		const original = { nested: { count: 1 } };
		const frozen = shims.freezeWorkflowValue(original);
		expect(frozen).toEqual(original);
		expect(frozen).not.toBe(original);
		expect(Object.isFrozen(frozen.nested)).toBe(true);
		expect(Object.isFrozen(original.nested)).toBe(false);
	});
});
