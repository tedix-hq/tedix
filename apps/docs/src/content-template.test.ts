/// <reference types="node" />
import { describe, expect, it, vi } from "vite-plus/test";
import type { z as Zod } from "zod";

type Fields = {
	status: Zod.ZodType;
	date: Zod.ZodType;
	visibility: Zod.ZodType;
	superseded_by: Zod.ZodType;
	resource_type: Zod.ZodType;
	topic: Zod.ZodType;
};
// Astro and Nimbus are installed in the build image, not the control Worker.
// Stand in for them, import the actual template, and inspect the custom fields
// it passes to Nimbus; the production build remains the integration check for
// Nimbus's base schema.
const captured = vi.hoisted(() => ({
	fields: undefined as unknown,
	strictFrontmatter: undefined as boolean | undefined,
}));
vi.mock("astro:content", () => ({
	defineCollection: (value: unknown) => value,
}));
vi.mock("astro/zod", async () => ({ z: (await import("zod")).z }));
vi.mock("@cloudflare/nimbus-docs/content", () => ({
	docsCollection(options: {
		schemaFields: unknown;
		strictFrontmatter?: boolean;
	}) {
		captured.fields = options.schemaFields;
		captured.strictFrontmatter = options.strictFrontmatter;
		return options;
	},
	partialsCollection: () => ({}),
}));
// A computed specifier keeps tsc from type-checking the template against
// packages this Worker does not install.
const templatePath = "../template/content.config";
await import(/* @vite-ignore */ templatePath);
const fields = captured.fields as Fields;

describe("Nimbus template collection", () => {
	it("keeps strict frontmatter on", () => {
		expect(captured.strictFrontmatter).not.toBe(false);
	});
});

describe("Nimbus template decision metadata", () => {
	it("accepts the failing production ADR's status and date", () => {
		// Frontmatter of the decision record whose build failure this guards.
		const source = "---\nstatus: active\ndate: 2026-07-13\n---\n";
		const status = source.match(/^status: (.+)$/m)?.[1];
		const date = source.match(/^date: (.+)$/m)?.[1];
		expect(fields.status.parse(status)).toBe("active");
		expect(fields.date.parse(date)).toBe("2026-07-13");
	});

	it.each(["proposed", "accepted", "active", "superseded"])(
		"accepts %s decisions",
		(status) => {
			expect(fields.status.parse(status)).toBe(status);
		},
	);

	it("allows optional metadata and YAML date objects", () => {
		expect(fields.status.parse(undefined)).toBeUndefined();
		expect(fields.date.parse(undefined)).toBeUndefined();
		const date = new Date("2026-07-13T00:00:00Z");
		expect(fields.date.parse(date)).toEqual(date);
	});

	it.each([
		"2026-02-30",
		"yesterday",
		"2026-13-01",
		0,
		null,
		new Date("invalid"),
	])("rejects malformed date %s", (date) => {
		expect(fields.date.safeParse(date).success).toBe(false);
	});

	it("validates superseded decision references", () => {
		expect(fields.superseded_by.parse("tedix-os.md")).toBe("tedix-os.md");
		expect(fields.superseded_by.safeParse("  ").success).toBe(false);
		expect(fields.superseded_by.safeParse(42).success).toBe(false);
	});

	it("rejects unknown lifecycle states and non-public visibility", () => {
		expect(fields.status.safeParse("actve").success).toBe(false);
		expect(fields.visibility.safeParse("private").success).toBe(false);
	});

	it("accepts curated resource metadata without inventing formats", () => {
		expect(fields.topic.parse("Getting started")).toBe("Getting started");
		expect(fields.topic.safeParse("   ").success).toBe(false);
		for (const type of [
			"guide",
			"tutorial",
			"reference",
			"troubleshooting",
			"learning-path",
			"video",
			"release-note",
		]) {
			expect(fields.resource_type.parse(type)).toBe(type);
		}
		expect(fields.resource_type.safeParse("podcast").success).toBe(false);
	});
});
