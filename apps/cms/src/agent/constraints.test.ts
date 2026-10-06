import { describe, expect, it } from "vite-plus/test";

import { TEMPLATE_SNAPSHOT_PATHS_BY_TEMPLATE } from "../template-snapshot";

import { isPathEditable, isPathLocked } from "./constraints";
import {
	lockedFilesForTemplate,
	normalizeCmsTemplateSlug,
} from "../template-policy";

describe("template-aware CMS constraints", () => {
	it("keeps the default Tedix theme surface editable", () => {
		expect(isPathEditable("src/layouts/Custom.astro", "tedix")).toBe(true);
		expect(isPathEditable("src/styles/tokens.css", "tedix")).toBe(true);
		expect(isPathEditable("src/layouts/Base.astro", "tedix")).toBe(true);
	});

	it("leaves marketing presentation site-owned while preserving infrastructure", () => {
		for (const path of [
			"src/layouts/BaseMarketing.astro",
			"src/styles/tokens.css",
			"src/components/blocks/Hero.astro",
			"src/components/blocks/future/NewBlock.astro",
		]) {
			expect(isPathLocked(path, "marketing"), path).toBe(false);
			expect(isPathEditable(path, "marketing"), path).toBe(true);
		}
		expect(isPathLocked("src/lib/platform-branding.ts", "marketing")).toBe(
			true,
		);
		expect(isPathEditable("src/theme-source.json", "marketing")).toBe(true);
		expect(isPathEditable("src/i18n/strings.ts", "marketing")).toBe(true);
		expect(isPathEditable("src/pages/[slug].astro", "marketing")).toBe(true);
		expect(isPathLocked("src/pages/[slug].astro", "marketing")).toBe(false);
	});

	it("rejects unknown template metadata before choosing a policy", () => {
		expect(() => normalizeCmsTemplateSlug("unknown")).toThrow(
			"Unknown CMS template",
		);
		expect(normalizeCmsTemplateSlug(" portfolio ")).toBe("portfolio");
		expect(normalizeCmsTemplateSlug(undefined)).toBe("tedix");
	});

	it("keeps generated snapshots in parity with the template policy", () => {
		const marketingPaths = TEMPLATE_SNAPSHOT_PATHS_BY_TEMPLATE.marketing;
		const tedixPaths = TEMPLATE_SNAPSHOT_PATHS_BY_TEMPLATE.tedix;
		for (const path of [
			"src/layouts/BaseMarketing.astro",
			"src/lib/platform-branding.ts",
			"src/styles/tokens.css",
			"src/components/blocks/Hero.astro",
			"src/components/blocks/TextWithImage.astro",
			"src/components/blocks/Features.astro",
			"src/components/blocks/Stats.astro",
			"src/components/blocks/CTABand.astro",
			"src/components/blocks/LogoStrip.astro",
			"src/components/blocks/FAQ.astro",
			"src/components/blocks/Pricing.astro",
			"src/components/blocks/Testimonials.astro",
			"src/components/blocks/value-utils.ts",
		]) {
			expect(marketingPaths, path).toContain(path);
			expect(tedixPaths, path).not.toContain(path);
		}
		expect(marketingPaths).not.toContain("src/components/blocks/types.ts");
		expect(marketingPaths).toContain("src/pages/[slug].astro");
		expect(marketingPaths).toContain("src/pages/kontakt.astro");
	});

	it("rejects traversal and ambiguous paths before directory checks", () => {
		for (const path of [
			"src/pages/../worker.ts",
			"src/pages//index.astro",
			"./src/pages/index.astro",
			"",
		]) {
			expect(isPathEditable(path, "marketing"), path).toBe(false);
		}
	});

	it("does not carry the removed Tailwind v3 config phantom", () => {
		expect(lockedFilesForTemplate("tedix")).not.toContain("tailwind.config.ts");
		expect(lockedFilesForTemplate("marketing")).not.toContain(
			"tailwind.config.ts",
		);
	});
});
