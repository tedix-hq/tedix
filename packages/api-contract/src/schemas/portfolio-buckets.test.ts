import { describe, expect, it } from "vite-plus/test";
import { PortfolioBucketsSchema } from "./organization";

describe("organization portfolio sections", () => {
	it("preserves order and labels independently from stable keys", () => {
		const buckets = [
			{ key: "research", label: "Recherche", description: "Longer projects" },
			{ key: "sales", label: "Ventes" },
		];
		expect(PortfolioBucketsSchema.parse(buckets)).toEqual(buckets);
		expect(PortfolioBucketsSchema.parse([])).toEqual([]);
	});
	it("rejects duplicate keys, invalid keys and empty names", () => {
		for (const buckets of [
			[
				{ key: "same", label: "One" },
				{ key: "same", label: "Two" },
			],
			[{ key: "Bad key", label: "Name" }],
			[{ key: "valid", label: " " }],
			Array.from({ length: 51 }, (_, i) => ({
				key: `key-${i}`,
				label: "Name",
			})),
		]) {
			expect(PortfolioBucketsSchema.safeParse(buckets).success).toBe(false);
		}
	});
});
