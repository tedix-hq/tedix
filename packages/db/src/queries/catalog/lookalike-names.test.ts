import { describe, expect, it } from "vite-plus/test";
import { isLookalikeCatalogName } from "./lookalike-names";

describe("isLookalikeCatalogName", () => {
	it("flags Latin names carrying Cyrillic or Greek lookalike letters", () => {
		expect(isLookalikeCatalogName("Mаke")).toBe(true);
		expect(isLookalikeCatalogName("Pipеwise CRM")).toBe(true);
		expect(isLookalikeCatalogName("C\u043Emp\u043Esi\u043E")).toBe(true);
		expect(isLookalikeCatalogName("Οpenrush")).toBe(true);
	});

	it("keeps single-script names, including fully Cyrillic or Greek ones", () => {
		expect(isLookalikeCatalogName("Make")).toBe(false);
		expect(isLookalikeCatalogName("Café Finder")).toBe(false);
		expect(isLookalikeCatalogName("Яндекс")).toBe(false);
		expect(isLookalikeCatalogName("Αθήνα")).toBe(false);
		expect(isLookalikeCatalogName("MAKE#")).toBe(false);
		expect(
			isLookalikeCatalogName(
				"Rozetka: \u0456\u043D\u0442\u0435\u0440\u043D\u0435\u0442 \u0433\u0456\u043F\u0435\u0440\u043C\u0430\u0440\u043A\u0435\u0442",
			),
		).toBe(false);
		expect(isLookalikeCatalogName(null)).toBe(false);
	});
});
