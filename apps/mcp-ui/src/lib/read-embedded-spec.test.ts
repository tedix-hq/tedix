// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vite-plus/test";
import { readEmbeddedData, widgetRenderData } from "./read-embedded-spec";
afterEach(() => {
	document.body.innerHTML = "";
});
describe("JSON widget hydration", () => {
	it.each(
		[[1, 2], "hello", 42, false, null, { rows: [1] }].map((value) => [value]),
	)("preserves %j and explicitly adapts renderer state", (value) => {
		const tag = document.createElement("script");
		tag.id = "tedix-tool-data";
		tag.type = "application/json";
		tag.textContent = JSON.stringify(value);
		document.body.appendChild(tag);
		expect(readEmbeddedData()).toEqual(value);
		expect(widgetRenderData(readEmbeddedData())).toEqual(
			value !== null && typeof value === "object" && !Array.isArray(value)
				? value
				: { value },
		);
	});
	it("distinguishes missing data from JSON null", () => {
		expect(readEmbeddedData()).toBeUndefined();
		expect(widgetRenderData(readEmbeddedData())).toBeNull();
		expect(widgetRenderData(null)).toEqual({ value: null });
	});
});
