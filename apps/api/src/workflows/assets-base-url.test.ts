import { describe, expect, it } from "vite-plus/test";
import { assetsBaseUrl } from "./assets-base-url";

describe("assetsBaseUrl", () => {
	it("returns the configured origin without a trailing slash", () => {
		expect(assetsBaseUrl({ ASSETS_URL: "https://assets.example.com/" })).toBe(
			"https://assets.example.com",
		);
		expect(assetsBaseUrl({ ASSETS_URL: "https://assets.example.com" })).toBe(
			"https://assets.example.com",
		);
	});

	it("fails closed when the origin is unset or blank", () => {
		expect(() => assetsBaseUrl({})).toThrow("ASSETS_URL is not configured");
		expect(() => assetsBaseUrl({ ASSETS_URL: "  " })).toThrow(
			"ASSETS_URL is not configured",
		);
	});
});
