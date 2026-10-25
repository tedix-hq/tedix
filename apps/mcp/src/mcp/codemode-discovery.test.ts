import { describe, expect, it } from "vite-plus/test";
import type {
	CatalogToolEntry,
	CatalogPageEntry,
} from "./codemode-catalog-entries";
import {
	editDistance,
	enrichToolNotFoundError,
	enrichUnmountedNamespaceError,
	nearestCatalogNamespaces,
	normalizeDiscoverySearchInput,
	normalizeSearchTerms,
	paginateCatalog,
	paginateCatalogEntries,
	projectCatalogMeta,
	scoreCatalogSearch,
	suggestedCatalogQueries,
} from "./codemode-discovery";

function entry(
	namespace: string,
	tool: string,
	overrides: Partial<CatalogToolEntry> = {},
): CatalogToolEntry {
	return {
		callable: `${namespace}.${tool}`,
		namespace,
		tool,
		name: tool,
		displayName: tool,
		description: `Description for ${tool}`,
		...overrides,
	};
}

function pageEntry(namespace: string, tool: string): CatalogPageEntry {
	return { namespace, tool, meta: entry(namespace, tool) };
}

describe("Code Mode discovery helpers", () => {
	it("normalizes search input and search terms", () => {
		expect(normalizeDiscoverySearchInput("  find skills  ")).toEqual({
			includeParameters: false,
			includeOutputSchema: false,
			includeMetadata: false,
			limit: 25,
			offset: 0,
			query: "find skills",
			namespace: "",
			organization: "",
		});
		expect(
			normalizeDiscoverySearchInput({
				query: "  list tools ",
				includeParameters: true,
				limit: 2.8,
				offset: -3,
				namespace: "  tools ",
			}),
		).toEqual({
			includeParameters: true,
			includeOutputSchema: false,
			includeMetadata: false,
			limit: 2,
			offset: 0,
			query: "list tools",
			namespace: "tools",
			organization: "",
		});
		expect(
			normalizeDiscoverySearchInput({ includeMetadata: true }).includeMetadata,
		).toBe(true);
		expect(normalizeSearchTerms("List, tools list")).toEqual(["list", "tools"]);
	});

	it.each([{ q: "tools" }, { name: "tools", org: "alpha" }])(
		"rejects unknown keys: %j",
		(input) => {
			expect(() => normalizeDiscoverySearchInput(input)).toThrow(
				/discover.search: unknown argument/,
			);
			for (const key of Object.keys(input)) {
				expect(() => normalizeDiscoverySearchInput(input)).toThrow(`"${key}"`);
			}
			expect(() => normalizeDiscoverySearchInput(input)).toThrow(
				"use { query, namespace, organization, limit, offset, includeParameters, includeOutputSchema, includeMetadata }",
			);
		},
	);

	it.each([
		{ query: 1 },
		{ namespace: [] },
		{ organization: false },
		{ limit: "5" },
		{ offset: null },
		{ includeParameters: 1 },
		{ includeOutputSchema: "true" },
		{ includeMetadata: null },
		{ limit: NaN },
		{ offset: Infinity },
		42,
		null,
		[],
	])("rejects mistyped arguments: %j", (input) => {
		expect(() => normalizeDiscoverySearchInput(input)).toThrow(
			/discover.search:.*; use \{ query, namespace, organization,/,
		);
	});

	it("paginates stable entries without skipping or repeating rows", () => {
		const entries = [
			pageEntry("alpha", "one"),
			pageEntry("alpha", "two"),
			pageEntry("beta", "one"),
			pageEntry("beta", "two"),
		];
		const pages = [0, 2].map((offset) =>
			paginateCatalogEntries(entries, 2, offset, false, false),
		);
		expect(
			pages.flatMap((page) =>
				page.results.map((row) => (row as CatalogToolEntry).callable),
			),
		).toEqual(["alpha.one", "alpha.two", "beta.one", "beta.two"]);
		expect(pages[0]?.meta.pagination).toEqual({
			limit: 2,
			offset: 0,
			total: 4,
		});
		expect(pages[1]?.meta.pagination).toEqual({
			limit: 2,
			offset: 2,
			total: 4,
		});
	});

	it("sorts catalog pagination consistently before applying offsets", () => {
		const catalog = {
			zeta: { later: entry("zeta", "later") },
			alpha: { first: entry("alpha", "first") },
			beta: { middle: entry("beta", "middle") },
		};
		const result = paginateCatalog(catalog, 2, 1, false, false);
		expect(
			result.results.map((row) => (row as CatalogToolEntry).callable),
		).toEqual(["beta.middle", "zeta.later"]);
	});

	it("projects schemas and compacts long descriptions", () => {
		const meta = entry("tools", "search", {
			description: `${"word ".repeat(100)}\n\nPaid tool: use credits`,
			parameters: { type: "object" },
			outputSchema: { type: "string" },
		});
		const compact = projectCatalogMeta(meta, false, false) as Record<
			string,
			unknown
		>;
		expect(compact.parameters).toBeUndefined();
		expect(compact.outputSchema).toBeUndefined();
		expect(compact.descriptionTruncated).toBe(true);
		expect(compact.description).toContain("Paid tool: use credits");
		expect(projectCatalogMeta(meta, true, true, true)).toMatchObject(meta);
	});

	it("calculates edit distance and ranks exact and multi-term names", () => {
		expect(editDistance("kitten", "sitting")).toBe(3);
		expect(editDistance("same", "same")).toBe(0);

		const exact = entry("tools", "list_skills");
		const partial = entry("tools", "list_skill_metadata");
		expect(
			scoreCatalogSearch(["list", "skills"], "tools", "list_skills", exact)!
				.score,
		).toBeGreaterThan(
			scoreCatalogSearch(
				["list", "skills"],
				"tools",
				"list_skill_metadata",
				partial,
			)!.score,
		);
		const moreTerms = scoreCatalogSearch(
			["list", "skills", "metadata"],
			"tools",
			"list_skills_metadata",
			entry("tools", "list_skills_metadata"),
		)!;
		const fewerTerms = scoreCatalogSearch(
			["list", "skills", "metadata"],
			"tools",
			"list_skills",
			exact,
		)!;
		expect(moreTerms.matchedTerms).toHaveLength(3);
		expect(moreTerms.score).toBeGreaterThan(fewerTerms.score);
	});

	it("indexes schemas once per entry across catalog-scale ranking and suggestions", () => {
		const tools: Record<string, CatalogToolEntry> = {};
		const serializations = new Uint8Array(13_000);
		for (let i = 0; i < serializations.length; i++) {
			const name = `assign_work_executor_${i}`;
			tools[name] = entry("work", name, {
				description: "Assign work executor. ".repeat(300),
				parameters: {
					toJSON() {
						serializations[i] = serializations[i]! + 1;
						return { type: "object", description: "schema ".repeat(400) };
					},
				},
			});
		}
		// Ranking and nearest-namespace hints traverse the same request catalog.
		// Count schema walks instead of timing a machine-dependent CPU budget.
		for (const query of ["assign work executor", "work executor"]) {
			const terms = normalizeSearchTerms(query);
			for (const [name, meta] of Object.entries(tools)) {
				expect(scoreCatalogSearch(terms, "work", name, meta)).not.toBeNull();
			}
			expect(nearestCatalogNamespaces(query, { work: tools })[0]).toMatchObject(
				{
					namespace: "work",
					tools: serializations.length,
				},
			);
		}
		expect([...serializations].every((count) => count === 1)).toBe(true);
	});

	it("finds nearest namespaces and useful query suggestions", () => {
		const catalog = {
			skills: {
				list_skills: entry("skills", "list_skills"),
			},
			billing: {
				get_invoice: entry("billing", "get_invoice"),
			},
		};
		expect(nearestCatalogNamespaces("skils", catalog)[0]?.namespace).toBe(
			"skills",
		);
		expect(
			suggestedCatalogQueries(["skills", "missing", "extra"], catalog),
		).toEqual(["skills", "skills missing extra"]);
	});

	it("enriches missing tool and namespace errors", () => {
		const toolError = enrichToolNotFoundError('Tool "list_skils" not found', [
			"skills.list_skills",
			"billing.get_invoice",
		]);
		expect(toolError).toContain("Closest callables: skills.list_skills");
		expect(toolError).toContain('discover.search({ query: "list skils" })');

		const namespaceError = enrichUnmountedNamespaceError(
			"skills is not defined",
			new Set(["skills"]),
			new Set(),
			new Set(["skills"]),
		);
		expect(namespaceError).toContain('Namespace "skills" is unavailable');
		expect(namespaceError).toContain("Use discover.search");
		expect(
			enrichUnmountedNamespaceError(
				"unknown is not defined",
				new Set(["skills"]),
				new Set(),
				null,
			),
		).toBe("unknown is not defined");
	});
});
