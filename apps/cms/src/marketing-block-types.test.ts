import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

interface MarketingSeed {
	blockTypes: Array<{ slug: string; versions: Array<{ version: number }> }>;
	collections: Array<{
		slug: string;
		fields: Array<{
			slug: string;
			type: string;
			validation?: { allowedTypes?: string[] };
		}>;
	}>;
}

const marketing = new URL("../templates/marketing/", import.meta.url);
const readMarketing = (path: string) =>
	readFileSync(new URL(path, marketing), "utf8");

describe("marketing starter native block types", () => {
	test("the generated Page union and renderer cover every seeded block version", () => {
		const seed = JSON.parse(readMarketing("seed/seed.json")) as MarketingSeed;
		const contentField = seed.collections
			.find((collection) => collection.slug === "pages")
			?.fields.find(
				(field) => field.slug === "content" && field.type === "blocks",
			);
		const allowedTypes = contentField?.validation?.allowedTypes;
		expect(allowedTypes?.length).toBeGreaterThan(0);

		const generated = readMarketing("emdash-env.d.ts");
		const generatedVersions = [
			...generated.matchAll(
				/export interface PageContent\w+V(\d+)Block \{\s+_type: "([^"]+)";/g,
			),
		].map(([, version, slug]) => `${slug}@${version}`);
		const seededVersions = seed.blockTypes
			.filter((blockType) => allowedTypes?.includes(blockType.slug))
			.flatMap((blockType) =>
				blockType.versions.map(
					(version) => `${blockType.slug}@${version.version}`,
				),
			);
		expect(generatedVersions.toSorted()).toEqual(seededVersions.toSorted());

		const renderer = readMarketing("src/components/MarketingBlocks.astro");
		const renderedTypes = [
			...renderer.matchAll(/^\s+(marketing_[a-z_]+): [A-Za-z]+,/gm),
		].map(([, slug]) => slug);
		expect(renderedTypes.toSorted()).toEqual(allowedTypes?.toSorted());
	});
});
