import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

type Field = {
	slug: string;
	type: string;
	validation?: { subFields?: Field[] };
};
type Version = { version: number; fields: Field[] };
type BlockType = { slug: string; currentVersion: number; versions: Version[] };

const seed = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL("../templates/marketing/seed/seed.json", import.meta.url),
		),
		"utf8",
	),
) as { blockTypes: BlockType[] };
const bySlug = new Map(seed.blockTypes.map((type) => [type.slug, type]));

function field(fields: Field[], slug: string): Field {
	const value = fields.find((candidate) => candidate.slug === slug);
	if (!value) throw new Error(`Missing field ${slug}`);
	return value;
}

describe("native marketing media schema", () => {
	it.each([
		["marketing_hero", "image_url", "image"],
		["marketing_cta", "image_url", "image"],
		["marketing_text_with_image", "image_url", "image"],
	] as const)(
		"keeps %s v1 and adds native media v2",
		(slug, legacy, native) => {
			const block = bySlug.get(slug);
			expect(block?.currentVersion).toBe(2);
			expect(block?.versions.map((version) => version.version)).toEqual([1, 2]);
			expect(field(block!.versions[0]!.fields, legacy).type).toBe("string");
			expect(
				block!.versions[1]!.fields.some(
					(candidate) => candidate.slug === legacy,
				),
			).toBe(false);
			expect(field(block!.versions[1]!.fields, native).type).toBe("image");
		},
	);

	it("supports native images inside logos and testimonial repeaters", () => {
		const logos = bySlug.get("marketing_logo_strip")!;
		const testimonials = bySlug.get("marketing_testimonials")!;
		for (const block of [logos, testimonials]) {
			expect(block.currentVersion).toBe(2);
			expect(block.versions.map((version) => version.version)).toEqual([1, 2]);
		}
		const rows = (block: BlockType, version: number) =>
			field(
				block.versions.find((item) => item.version === version)!.fields,
				"items",
			).validation!.subFields!;
		expect(field(rows(logos, 1), "url").type).toBe("string");
		expect(field(rows(logos, 1), "alt").type).toBe("string");
		expect(field(rows(logos, 2), "image").type).toBe("image");
		expect(
			rows(logos, 2).some((item) => item.slug === "url" || item.slug === "alt"),
		).toBe(false);
		expect(field(rows(testimonials, 1), "avatar").type).toBe("string");
		expect(field(rows(testimonials, 2), "avatar").type).toBe("image");
	});
});
