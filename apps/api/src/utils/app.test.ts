import { describe, expect, it } from "vite-plus/test";
import { generateAppSlug, isReservedAppSlug, slugify } from "./app";

describe("isReservedAppSlug", () => {
	it("flags the platform-routing slugs (case-insensitive)", () => {
		for (const s of ["home", "kernel", "tedix-unified", "HOME", "Kernel"]) {
			expect(isReservedAppSlug(s)).toBe(true);
		}
	});

	it("allows ordinary tenant + provider slugs", () => {
		for (const s of [
			"firecrawl-tedix",
			"acme-admin-dashboard",
			"home-app",
			"my-kernel-tools",
			"globex-tedix",
		]) {
			expect(isReservedAppSlug(s)).toBe(false);
		}
	});

	it("a generated tenant slug for an app named after a reserved word is not reserved", () => {
		// org-prefixing keeps it clear of the reserved set
		expect(isReservedAppSlug(generateAppSlug("Home", "acme"))).toBe(false);
		expect(slugify("Home")).toBe("home");
	});
});
