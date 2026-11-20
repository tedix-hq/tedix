import { describe, expect, it } from "vite-plus/test";
import { catalogSeoDescription } from "./catalog-description";

describe("catalog SEO descriptions", () => {
	it("replaces a thin tagline with bounded capability text without splitting a word", () => {
		const description =
			"Request a taxi insurance quote for private and public hire drivers. Share driver and vehicle details, then follow the quote reference to the provider website to review coverage.";
		const result = catalogSeoDescription({
			seoDescription: "Online taxi insurance quotes",
			description,
			tools: [],
			storeListings: [],
		})!;
		expect(result.length).toBeGreaterThanOrEqual(120);
		expect(result.length).toBeLessThanOrEqual(160);
		expect(description.startsWith(result.slice(0, -1))).toBe(true);
		expect(description[result.length - 1]).toBe(" ");
	});

	it("uses tool and listing text when the main description is missing", () => {
		const result = catalogSeoDescription({
			tools: [
				{
					description:
						"Search the document library for reports and meeting notes.",
				},
			],
			storeListings: [
				{
					storeDescription:
						"Read matching passages and their source links to find the information you need.",
				},
			],
		});
		expect(result).toBe(
			"Search the document library for reports and meeting notes. Read matching passages and their source links to find the information you need.",
		);
	});

	it("retains useful publisher summaries and never pads records with unsupported claims", () => {
		const seoDescription =
			"Search the document library for reports and meeting notes. Read matching passages and their source links to find the information you need.";
		expect(
			catalogSeoDescription({
				seoDescription,
				description: "Documents",
				tools: [],
				storeListings: [],
			}),
		).toBe(seoDescription);
		expect(
			catalogSeoDescription({
				description: "Search documents",
				tools: [],
				storeListings: [],
			}),
		).toBe("Search documents");
		expect(catalogSeoDescription({ tools: [], storeListings: [] })).toBeNull();
	});
});
