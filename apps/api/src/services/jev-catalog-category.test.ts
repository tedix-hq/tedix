import { describe, expect, it } from "vite-plus/test";
import { categoryEnum } from "@tedix/db/schema/catalog";
import {
	catalogCategoryRequest,
	selectedCatalogCategory,
} from "./jev-catalog-category";

const result = (choice: string) => ({
	model: "jev-1.13.0",
	usage: { input_tokens: 120, output_tokens: 20 },
	answers: {
		category: {
			type: "choice" as const,
			choice,
			probabilities: { [choice]: 1 },
			confidence: 1,
		},
	},
});
describe("catalog Jev classification", () => {
	it("uses the canonical categories and an explicit no-match option", () => {
		const request = catalogCategoryRequest({
			name: "Ledger",
			description: "Invoice reconciliation and cash-flow reporting",
		})!;
		expect(Object.keys(request.questions.category.criteria)).toEqual([
			...categoryEnum,
			"NONE",
		]);
		expect(request.state.description).toContain("reconciliation");
	});
	it("leaves classification unset on NONE, unavailable, or unknown category", () => {
		expect(selectedCatalogCategory(result("NONE"))).toBeNull();
		expect(selectedCatalogCategory(null)).toBeNull();
		expect(selectedCatalogCategory(result("INVENTED"))).toBeNull();
	});
});
