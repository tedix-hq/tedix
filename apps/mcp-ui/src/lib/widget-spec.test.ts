import { describe, expect, it } from "vite-plus/test";
import { parseWidgetDataParam, parseWidgetSpecParam } from "./widget-spec";

function encode(value: unknown): string {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	return btoa(String.fromCharCode(...bytes));
}

function spec(text: string) {
	return {
		root: "title",
		elements: { title: { type: "Text", props: { text }, children: [] } },
	};
}

describe("widget query payload encoding", () => {
	it.each(["Órdenes que necesitan atención", "状態 🚗", "Plain ASCII"])(
		"preserves UTF-8 copy: %s",
		(title) => {
			const value = spec(title);
			const encoded = encode(value)
				.replaceAll("+", "-")
				.replaceAll("/", "_")
				.replace(/=+$/, "");
			expect(parseWidgetSpecParam(encoded).spec).toEqual(value);
		},
	);
	it("accepts URI-encoded standard base64", () => {
		const value = spec("Órdenes 🚗");
		expect(
			parseWidgetSpecParam(encodeURIComponent(encode(value))).spec,
		).toEqual(value);
	});
	it("preserves Unicode in the shared data query decoder", () => {
		const value = { reason: "Necesita atención" };
		expect(parseWidgetDataParam(encode(value)).data).toEqual(value);
	});
	it.each(["not!base64", "%ZZ", btoa("not JSON"), btoa(' {"text":"\xff"}')])(
		"reports malformed input: %s",
		(value) => {
			const result = parseWidgetSpecParam(value);
			expect(result.spec).toBeNull();
			expect(result.issues.some((issue) => issue.level === "error")).toBe(true);
		},
	);
});
