import { describe, expect, it } from "vite-plus/test";
import { jsonTextSchema } from "./json-text-schema";

describe("jsonTextSchema", () => {
	it("returns the parser output", () => {
		const schema = jsonTextSchema((value) => JSON.parse(value) as unknown);
		expect(schema.parse('{"ok":true}')).toEqual({ ok: true });
	});

	it("turns parser failures into field errors", () => {
		const schema = jsonTextSchema(() => {
			throw new Error("Parameters must be a JSON object.");
		});
		const result = schema.safeParse("[]");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toBe(
				"Parameters must be a JSON object.",
			);
		}
	});
});
