import { describe, expect, it } from "vite-plus/test";
import { TEMPLATE_SNAPSHOTS } from "./template-snapshot";
import { normalizeCmsTemplateSlug } from "./template-policy";

describe("native site scaffolds", () => {
	it.each(["native-marketing", "marketing"] as const)(
		"keeps %s sample content in drafts without fabricated claims",
		(slug) => {
			const seed = JSON.parse(TEMPLATE_SNAPSHOTS[slug]!["seed/seed.json"]!) as {
				content: Record<string, { status: string; data: { title: string } }[]>;
			};
			const entries = Object.values(seed.content).flat();
			expect(entries.length).toBeGreaterThan(0);
			for (const entry of entries) {
				expect(entry.status).toBe("draft");
				expect(entry.data.title).toMatch(/^Example:/);
			}
			const content = JSON.stringify(seed.content);
			expect(content).not.toMatch(
				/Sarah Chen|Streamline|Marcus Johnson|Volt Labs|Elena Rodriguez|Nexus|80%|SOC 2|end-to-end encryption|0ms|∞|load instantly|marketing_testimonials|marketing_stats/,
			);
		},
	);
	it.each([
		["starter", "pages"],
		["blog", "posts"],
		["portfolio", "projects"],
		["native-marketing", "pages"],
	] as const)(
		"ships %s with its native seed and complete presentation",
		(slug, collection) => {
			const snapshot = TEMPLATE_SNAPSHOTS[normalizeCmsTemplateSlug(slug)]!;
			const seed = JSON.parse(snapshot["seed/seed.json"]!) as {
				collections: { slug: string }[];
			};
			expect(seed.collections.some((entry) => entry.slug === collection)).toBe(
				true,
			);
			expect(JSON.parse(snapshot["package.json"]!).emdash.seed).toBe(
				"seed/seed.json",
			);
			expect(snapshot["src/layouts/Base.astro"]).toContain("EmDashHead");
			expect(snapshot["src/pages/index.astro"]).toBeTruthy();
			expect(snapshot["cms.config.mjs"]).toContain(
				"siteBuilderAuthBridgeEntrypoint",
			);
		},
	);
	it("keeps native portfolio source distinct from the existing tenant scaffolds", () => {
		expect(TEMPLATE_SNAPSHOTS.portfolio!["src/pages/index.astro"]).toContain(
			'"projects"',
		);
		expect(TEMPLATE_SNAPSHOTS.portfolio!["src/pages/index.astro"]).not.toBe(
			TEMPLATE_SNAPSHOTS.tedix!["src/pages/index.astro"],
		);
	});
});
