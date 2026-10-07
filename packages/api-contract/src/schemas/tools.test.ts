import { describe, expect, it } from "vite-plus/test";
import {
	isToolExcludedFromSkillCoverage,
	parseToolSkillCoverageMetadata,
	TEDIX_TOOL_SKILL_COVERAGE_META_KEY,
	ToolMetaSchema,
} from "./tools";

describe("tool skill coverage metadata", () => {
	it("recognizes excluded tools", () => {
		const meta = {
			[TEDIX_TOOL_SKILL_COVERAGE_META_KEY]: {
				status: "excluded",
				category: "internal-contract",
				reason: "oRPC route is tagged internal.",
			},
		};

		expect(isToolExcludedFromSkillCoverage(meta)).toBe(true);
		expect(parseToolSkillCoverageMetadata(meta)?.category).toBe(
			"internal-contract",
		);
	});

	it("keeps tools auditable by default", () => {
		expect(isToolExcludedFromSkillCoverage(null)).toBe(false);
		expect(
			isToolExcludedFromSkillCoverage({
				[TEDIX_TOOL_SKILL_COVERAGE_META_KEY]: { status: "required" },
			}),
		).toBe(false);
	});

	it("validates the metadata shape inside tool meta", () => {
		expect(
			ToolMetaSchema.safeParse({
				[TEDIX_TOOL_SKILL_COVERAGE_META_KEY]: { status: "nope" },
			}).success,
		).toBe(false);
	});
});

import {
	CatalogueTransportConfigSchema,
	CatalogueSearchInputSchema,
	CatalogueDescribeInputSchema,
} from "./tools";
describe("configured native catalog inputs", () => {
	it("accepts only the two closed operations and server provenance", () => {
		expect(
			CatalogueTransportConfigSchema.parse({
				transport: "catalog",
				endpoint: "catalog/search",
				_aggregateNamespace: "fictional",
			}).endpoint,
		).toBe("catalog/search");
		for (const extra of [
			{ endpoint: "apps/list" },
			{ code: "async()=>1" },
			{ module: "evil" },
			{ baseUrl: "https://example.test" },
			{ _asyncTask: true },
			{ staticParams: {} },
		]) {
			expect(
				CatalogueTransportConfigSchema.safeParse({
					transport: "catalog",
					endpoint: "catalog/search",
					...extra,
				}).success,
			).toBe(false);
		}
	});
	it("bounds paging and refuses executable or unknown input", () => {
		expect(
			CatalogueSearchInputSchema.parse({
				query: "tasks",
				limit: 100,
				offset: Number.MAX_SAFE_INTEGER,
				includeParameters: true,
			}),
		).toMatchObject({ limit: 100 });
		for (const input of [
			{ limit: 101 },
			{ limit: 0 },
			{ offset: -1 },
			{ offset: Number.MAX_SAFE_INTEGER + 1 },
			{ query: 3 },
			{ includeParameters: "true" },
			{ code: "async()=>1" },
			{ scope: "platform:admin" },
		])
			expect(CatalogueSearchInputSchema.safeParse(input).success).toBe(false);
		expect(
			CatalogueDescribeInputSchema.parse({ callable: "work.list_work_items" })
				.callable,
		).toBe("work.list_work_items");
		for (const callable of [
			"list_work_items",
			"work.list();",
			"https://example.test",
			"work.a.b",
		])
			expect(CatalogueDescribeInputSchema.safeParse({ callable }).success).toBe(
				false,
			);
	});
});

import {
	CatalogueSearchInputJsonSchema,
	catalogueInputDeclarationMatches,
} from "./tools";
it("binds configured declarations to the closed parser and ignores only key order", () => {
	expect(
		catalogueInputDeclarationMatches(
			"catalog/search",
			Object.fromEntries(
				Object.entries(CatalogueSearchInputJsonSchema).reverse(),
			),
		),
	).toBe(true);
	expect(
		catalogueInputDeclarationMatches("catalog/search", {
			...CatalogueSearchInputJsonSchema,
			additionalProperties: true,
		}),
	).toBe(false);
	expect(
		catalogueInputDeclarationMatches("catalog/search", {
			...CatalogueSearchInputJsonSchema,
			properties: { code: { type: "string" } },
		}),
	).toBe(false);
	expect(
		catalogueInputDeclarationMatches(
			"catalog/describe",
			CatalogueSearchInputJsonSchema,
		),
	).toBe(false);
});

it("nativeDirect is a literal server opt-in, never a string or false compatibility flag", () => {
	for (const value of [false, "true", 1, null])
		expect(
			CatalogueTransportConfigSchema.safeParse({
				transport: "catalog",
				endpoint: "catalog/search",
				nativeDirect: value,
			}).success,
		).toBe(false);
	expect(
		CatalogueTransportConfigSchema.parse({
			transport: "catalog",
			endpoint: "catalog/search",
			nativeDirect: true,
		}).nativeDirect,
	).toBe(true);
});
