import { describe, expect, it } from "vite-plus/test";
import { BrowserHostnamePatternSchema, ToolPolicySchema } from "./tedi";

describe("tedi browser hostname policy", () => {
	it("normalizes exact and leading-wildcard hostnames", () => {
		expect(BrowserHostnamePatternSchema.parse("  API.Example.COM ")).toBe(
			"api.example.com",
		);
		expect(BrowserHostnamePatternSchema.parse("*.Example.com")).toBe(
			"*.example.com",
		);
	});

	it("rejects URL-shaped and embedded wildcard patterns", () => {
		expect(
			BrowserHostnamePatternSchema.safeParse("https://example.com").success,
		).toBe(false);
		expect(
			BrowserHostnamePatternSchema.safeParse("api.*.example.com").success,
		).toBe(false);
	});

	it("keeps the unrestricted default and parses a bounded policy", () => {
		expect(ToolPolicySchema.parse({}).browserEgress).toBeUndefined();
		expect(
			ToolPolicySchema.parse({
				browserEgress: {
					allowedHostnames: ["docs.cloudflare.com"],
					deniedHostnames: ["admin.example.com"],
				},
			}).browserEgress,
		).toEqual({
			allowedHostnames: ["docs.cloudflare.com"],
			deniedHostnames: ["admin.example.com"],
		});
	});
});
