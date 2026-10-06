import { describe, expect, it } from "vite-plus/test";
import { normalizeItems, toItemInsert } from "./item-normalization";

describe("item normalization", () => {
	it("keeps a source listing identity stable across imports", () => {
		const [item] = normalizeItems([
			{
				title: "Electric hatchback",
				url: "https://cars.example/details/12345678",
				images: ["https://cars.example/car.jpg"],
			},
		]);
		expect(item).toMatchObject({
			sku: "12345678",
			image: "https://cars.example/car.jpg",
		});
		const first = toItemInsert(
			item!,
			"app",
			"automotive",
			"https://cars.example",
		);
		const second = toItemInsert(
			item!,
			"app",
			"automotive",
			"https://cars.example",
		);
		expect(first.id).toBe("12345678");
		expect(second.id).toBe(first.id);
		expect(first.metadata.sourceUrl).toBe(
			"https://cars.example/details/12345678",
		);
	});

	it("keeps distinct nonnumeric source URLs distinct and repeatable", () => {
		const rows = normalizeItems([
			{ title: "One", url: "https://store.example/one" },
			{ title: "Two", url: "https://store.example/two" },
		]);
		expect(rows[0]!.sku).not.toBe(rows[1]!.sku);
		expect(
			normalizeItems([
				{ title: "Renamed", url: "https://store.example/one" },
			])[0]!.sku,
		).toBe(rows[0]!.sku);
	});

	it("preserves automotive search metadata and serializable storage values", () => {
		const row = toItemInsert(
			{
				title: "Car",
				sku: "car-1",
				make: "BMW",
				year: "2024",
				fuel: "Elektro",
				images: ["https://cars.example/car.jpg"],
				price: 32000,
				seller: { name: "Dealer", verified: true },
				metadata: { stock: "ready" },
			},
			"app",
			"automotive",
			"https://cars.example",
		);
		expect(row).toMatchObject({
			id: "car-1",
			image: "https://cars.example/car.jpg",
			priceAmount: 32000,
			priceCurrency: "EUR",
			sellerVerified: "true",
			metadata: {
				make: "BMW",
				year: "2024",
				fuelType: "electric",
				stock: "ready",
				sourceUrl: "https://cars.example",
			},
		});
		expect(JSON.parse(JSON.stringify(row)).metadata).toEqual(row.metadata);
	});

	it("records the listing URL instead of a site label from agent extraction", () => {
		const row = toItemInsert(
			{ title: "Listing", url: "https://store.example/item/123456" },
			"app",
			"ecommerce",
			"Example Store",
		);
		expect(row.metadata.sourceUrl).toBe("https://store.example/item/123456");
	});

	it("uses a valid import source URL when the item has no listing URL", () => {
		const row = toItemInsert(
			{ title: "Imported item" },
			"app",
			"ecommerce",
			"https://feed.example/catalog.json",
		);
		expect(row.metadata.sourceUrl).toBe("https://feed.example/catalog.json");
	});

	it("omits sourceUrl when neither source is a valid public-web scheme URL", () => {
		for (const sourceUrl of [
			"Example Store",
			"javascript:alert(1)",
			"file:///etc/passwd",
			"https://user:secret@example.com/catalog",
		]) {
			const row = toItemInsert(
				{ title: "No source", url: "data:text/html,example" },
				"app",
				"ecommerce",
				sourceUrl,
			);
			expect(row.metadata).not.toHaveProperty("sourceUrl");
		}
	});
});
