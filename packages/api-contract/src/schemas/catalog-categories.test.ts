import { describe, expect, it } from "vite-plus/test";
import { GetCategoriesOutputSchema } from "./catalog";

describe("catalog category output", () => {
	it("accepts the display label returned by merged category counts", () => {
		expect(
			GetCategoriesOutputSchema.parse([
				{ name: "BUSINESS", label: "Business", count: 1 },
			]),
		).toEqual([{ name: "BUSINESS", label: "Business", count: 1 }]);
	});
});
