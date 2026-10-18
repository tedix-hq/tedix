import { describe, expect, it, vi } from "vite-plus/test";
import { getCatalogSitemapSlugs } from "./catalog-sitemap";

function listing(
	apps: { slug: string; connectorType?: string }[],
	total: number,
) {
	return { apps, total, pagination: { hasMore: true } };
}

describe("catalog sitemap", () => {
	it("fetches beyond the first concurrent window without unbounded fan-out", async () => {
		let active = 0;
		let peak = 0;
		const list = vi.fn(async ({ offset }: { offset: number }) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 1));
			active--;
			return listing([{ slug: `app-${offset}` }], 2100);
		});
		const slugs = await getCatalogSitemapSlugs(list);
		expect(slugs).toEqual(
			Array.from({ length: 11 }, (_, i) => `app-${i * 200}`),
		);
		expect(peak).toBe(8);
		expect(list).toHaveBeenCalledTimes(11);
	});

	it("rejects a later-page failure instead of returning a partial sitemap", async () => {
		const list = vi.fn(async ({ offset }: { offset: number }) => {
			if (offset === 400) throw new Error("catalog unavailable");
			return listing([{ slug: `app-${offset}` }], 600);
		});
		await expect(getCatalogSitemapSlugs(list)).rejects.toThrow(
			"catalog unavailable",
		);
	});

	it("excludes ecosystem entries and emits each public slug once", async () => {
		const list = vi.fn(async () =>
			listing(
				[
					{ slug: "public" },
					{ slug: "public" },
					{ slug: "" },
					{ slug: "ecosystem", connectorType: "FIRST_PARTY_ECOSYSTEM" },
				],
				4,
			),
		);
		await expect(getCatalogSitemapSlugs(list)).resolves.toEqual(["public"]);
	});
});
