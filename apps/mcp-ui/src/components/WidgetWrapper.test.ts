import { describe, expect, it } from "vite-plus/test";
import { resolveStandaloneTheme, WidgetWrapper } from "./WidgetWrapper";

describe("WidgetWrapper", () => {
	it("exports the canonical MCP Apps wrapper", () => {
		expect(WidgetWrapper).toBeTypeOf("function");
	});

	it("accepts an explicit bounded standalone theme from an embedded host", () => {
		expect(resolveStandaloneTheme("?theme=dark", "light")).toBe("dark");
		expect(resolveStandaloneTheme("?theme=light", "dark")).toBe("light");
		expect(resolveStandaloneTheme("?theme=sepia", "dark")).toBe("dark");
	});
});
