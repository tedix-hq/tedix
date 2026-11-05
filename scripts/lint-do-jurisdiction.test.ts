import { describe, expect, it } from "bun:test";
import { findBypasses, maskSource } from "./lint-do-jurisdiction.ts";

describe("findBypasses", () => {
	it("flags every namespace addressing method", () => {
		const source = [
			"env.A.idFromName(name);",
			"env.B.idFromString(id);",
			"env.C.newUniqueId();",
			"env.D.getByName(name);",
			"env.E.jurisdiction('eu');",
		].join("\n");
		expect(findBypasses(source).map((f) => f.method)).toEqual([
			"idFromName",
			"idFromString",
			"newUniqueId",
			"getByName",
			"jurisdiction",
		]);
	});

	it("flags bracket-notation access", () => {
		const source = 'ns["idFromName"](name); ns["getByName"](name);';
		expect(findBypasses(source).map((f) => f.method)).toEqual([
			'["idFromName"]',
			'["getByName"]',
		]);
	});

	it("ignores comments, strings, and generated code in literals", () => {
		const source = [
			"// env.A.idFromName(name) explains addressing",
			"/* env.B.getByName(name) */",
			'const note = "kernel.idFromName(organizationId)";',
			"const code = `ns.getByName(${JSON.stringify('x')})`;",
			'source.includes("idFromName");',
		].join("\n");
		expect(findBypasses(source)).toEqual([]);
	});

	it("allows non-DO methods with different names", () => {
		const source = [
			"env.KV.get(key);",
			"env.R2.get(key);",
			"map.get(name);",
			"stub.fetch(request);",
			"durableObjectStubByName(env.NS, env, name);",
			"durableObjectIdFromName(env.NS, env, name);",
		].join("\n");
		expect(findBypasses(source)).toEqual([]);
	});

	it("flags a call inside a template interpolation", () => {
		const source = "const url = `x/${ns.idFromName(name).toString()}`;";
		expect(findBypasses(source).map((f) => f.method)).toEqual(["idFromName"]);
	});

	it("reports the source line", () => {
		const source = "const a = 1;\nconst b = 2;\nns.idFromName(name);";
		expect(findBypasses(source)[0]?.line).toBe(3);
	});
});

describe("maskSource", () => {
	it("preserves offsets and newlines", () => {
		const source = "const s = `a\nb`;\n// comment\nlet x = 1;";
		const masked = maskSource(source, true);
		expect(masked.length).toBe(source.length);
		expect(masked.split("\n").length).toBe(source.split("\n").length);
	});
});
