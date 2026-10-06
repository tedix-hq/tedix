import { describe, expect, it } from "vite-plus/test";
import type { LayoutItemSchemaType as LayoutItem } from "@tedix/api-contract/schemas/layout";
import {
	filterAndSortItems,
	getBestPrice,
	getDeliveryDays,
	hasFreeShipping,
	isInStock,
} from "./items";

const items: LayoutItem[] = [
	{
		id: "structured",
		title: "Structured",
		price: { amount: 20, currency: "EUR" },
		rating: { value: 4.8 },
		shipping: { free: true, maxDays: 3 },
		stock: { status: "in_stock" },
	},
	{
		id: "offer",
		title: "Offer",
		price: { amount: 10, currency: "EUR" },
		rating: { value: 3.5 },
		offers: [
			{
				merchantName: "Shop",
				price: 10,
				currency: "EUR",
				shippingCost: 0,
				deliveryDays: 1,
				stockStatus: "in_stock",
			},
		],
	},
	{
		id: "legacy-metadata",
		title: "Legacy metadata only",
		metadata: { freeShipping: true, inStock: true, deliveryDays: 0 },
	},
];

describe("comparison item selectors", () => {
	it("uses structured item and offer fields, never metadata compatibility", () => {
		expect(hasFreeShipping(items[0]!)).toBe(true);
		expect(hasFreeShipping(items[1]!)).toBe(true);
		expect(hasFreeShipping(items[2]!)).toBe(false);
		expect(isInStock(items[2]!)).toBe(false);
	});

	it("filters without mutating relevance order", () => {
		const result = filterAndSortItems(items, { topRated: true }, "relevance");
		expect(result.map((item) => item.id)).toEqual(["structured"]);
		expect(items.map((item) => item.id)).toEqual([
			"structured",
			"offer",
			"legacy-metadata",
		]);
	});

	it("sorts missing prices and delivery last", () => {
		expect(
			filterAndSortItems(items, {}, "price").map((item) => item.id),
		).toEqual(["offer", "structured", "legacy-metadata"]);
		expect(
			filterAndSortItems(items, {}, "delivery").map((item) => item.id),
		).toEqual(["offer", "structured", "legacy-metadata"]);
		expect(getDeliveryDays(items[2]!)).toBe(Number.POSITIVE_INFINITY);
	});

	it("computes best price without treating missing prices as zero", () => {
		expect(getBestPrice(items)).toBe(10);
		expect(getBestPrice([items[2]!])).toBeNull();
	});
});
