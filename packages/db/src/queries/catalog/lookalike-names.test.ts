import { describe, expect, it } from "vite-plus/test";
import { isLookalikeCatalogName } from "./lookalike-names";

describe("isLookalikeCatalogName", () => {
	it("flags Latin names carrying Cyrillic or Greek lookalike letters", () => {
		expect(isLookalikeCatalogName("Mаke")).toBe(true);
		expect(isLookalikeCatalogName("Pipеwise CRM")).toBe(true);
		expect(isLookalikeCatalogName("Οpenrush")).toBe(true);
	});

	it("keeps single-script names, including fully Cyrillic or Greek ones", () => {
		expect(isLookalikeCatalogName("Make")).toBe(false);
		expect(isLookalikeCatalogName("Café Finder")).toBe(false);
		expect(isLookalikeCatalogName("Яндекс")).toBe(false);
		expect(isLookalikeCatalogName("Αθήνα")).toBe(false);
		expect(isLookalikeCatalogName("MAKE#")).toBe(false);
		expect(isLookalikeCatalogName(null)).toBe(false);
	});
});
