import { describe, expect, it } from "vite-plus/test";
import { isSupportedCatalogR2Path } from "./catalog-sync-source";

describe("isSupportedCatalogR2Path", () => {
	it("accepts only the active Claude registry namespace", () => {
		expect(isSupportedCatalogR2Path("catalog/claude")).toBe(true);
		expect(
			isSupportedCatalogR2Path("catalog/claude/registry_servers.json"),
		).toBe(true);
		expect(isSupportedCatalogR2Path("catalog/legacy/apps.json")).toBe(false);
		expect(isSupportedCatalogR2Path("catalog/claude-old/apps.json")).toBe(
			false,
		);
	});
});
