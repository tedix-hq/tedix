import { describe, expect, it } from "vite-plus/test";
import { autoMapFields, VERTICAL_FIELD_MAPPINGS } from "./field-mapping-config";

describe("vertical field mappings", () => {
	it("keeps common extraction fields in the canonical vertical engine", () => {
		const mapped = autoMapFields({
			externalId: "vehicle-1",
			title: "Roadster",
			subtitle: "Launch edition",
			description: "Electric convertible",
			url: "https://example.test/vehicle-1",
			imageUrl: "https://example.test/vehicle-1.jpg",
			priceNegotiable: true,
			rating: 4.8,
			reviewCount: 14,
			badge: "featured",
			availability: "in_stock",
			transmission: "automatic",
			powerKw: 220,
			powerPs: 299,
			doors: 2,
			previousOwners: 1,
			inspectionDate: "2027-08",
		});

		expect(mapped).toMatchObject({
			sku: "vehicle-1",
			title: "Roadster",
			subtitle: "Launch edition",
			description: "Electric convertible",
			url: "https://example.test/vehicle-1",
			image: "https://example.test/vehicle-1.jpg",
			priceNegotiable: true,
			rating: 4.8,
			reviewCount: 14,
			badge: "featured",
			availability: "in_stock",
			transmissionType: "automatic",
			powerKw: 220,
			powerPs: 299,
			doors: 2,
			previousOwners: 1,
			inspectionDate: "2027-08",
		});
	});

	it("treats postalCode as a current automotive source alias", () => {
		expect(autoMapFields({ title: "Roadster", postalCode: "84076" })).toEqual(
			expect.objectContaining({
				location: expect.objectContaining({ zipCode: "84076" }),
			}),
		);
	});

	it("makes common aliases available to every vertical and preserves overrides", () => {
		for (const mappings of Object.values(VERTICAL_FIELD_MAPPINGS)) {
			expect(mappings.image).toEqual(["image", "imageUrl"]);
			expect(mappings["location.zipCode"]).toContain("postalCode");
		}

		expect(
			autoMapFields(
				{ price: 10, customPrice: 12 },
				{ ...VERTICAL_FIELD_MAPPINGS.automotive, price: ["customPrice"] },
			).price,
		).toBe(12);
	});
});
