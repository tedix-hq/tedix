import { readFileSync } from "node:fs";
import type { PluginContext } from "emdash/plugin";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import pageSearch, {
	backfillSearch,
	projectPageSearchText,
	searchCollections,
} from "../templates/tedix/src/plugins/tedix-page-search/index";

const mocks = vi.hoisted(() => ({
	getCollectionWithFields: vi.fn(),
	createField: vi.fn(),
	updateField: vi.fn(),
	listBlockTypes: vi.fn(),
	findMany: vi.fn(),
	update: vi.fn(),
	findById: vi.fn(),
	revision: vi.fn(),
	getSearchConfig: vi.fn(),
	rebuildIndex: vi.fn(),
	enableSearch: vi.fn(),
	getSearchableFields: vi.fn(),
}));
vi.mock("emdash", () => ({
	SchemaRegistry: class {
		getCollectionWithFields = mocks.getCollectionWithFields;
		createField = mocks.createField;
		updateField = mocks.updateField;
	},
	BlockTypeRegistry: class {
		listBlockTypes = mocks.listBlockTypes;
	},
	ContentRepository: class {
		findMany = mocks.findMany;
		update = mocks.update;
		findById = mocks.findById;
	},
	RevisionRepository: class {
		findById = mocks.revision;
	},
	FTSManager: class {
		getSearchConfig = mocks.getSearchConfig;
		rebuildIndex = mocks.rebuildIndex;
		enableSearch = mocks.enableSearch;
		getSearchableFields = mocks.getSearchableFields;
	},
}));
vi.mock("../templates/tedix/node_modules/emdash/dist/runtime.mjs", () => ({
	getDb: async () => ({}),
}));
const schemas = JSON.parse(
	readFileSync(
		new URL("../templates/marketing/seed/seed.json", import.meta.url),
		"utf8",
	),
).blockTypes as Parameters<typeof projectPageSearchText>[1];
const settings = vi.fn();
const ctx = { settings: { get: settings } } as unknown as PluginContext;
const save = (
	event: Parameters<
		(typeof pageSearch.hooks)["content:beforeSave"]["handler"]
	>[0],
) => pageSearch.hooks["content:beforeSave"].handler(event, ctx);
const collection = {
	slug: "pages",
	supports: ["search"],
	fields: [{ slug: "content", type: "blocks" }],
};
const block = (copy: string) => [
	{ _type: "marketing_hero", _version: 2, headline: copy },
];
beforeEach(() => {
	vi.resetAllMocks();
	settings.mockResolvedValue(undefined);
	mocks.getCollectionWithFields.mockResolvedValue(collection);
	mocks.listBlockTypes.mockResolvedValue(schemas);
	mocks.findMany.mockResolvedValue({ items: [], nextCursor: null });
	mocks.getSearchConfig.mockResolvedValue({
		enabled: true,
		weights: { title: 5 },
		tokenize: "unicode61",
	});
	mocks.getSearchableFields.mockResolvedValue(["title", "search_text"]);
});

describe("tedix-page-search native block projection", () => {
	const content = [
		{
			_type: "marketing_hero",
			_version: 1,
			_key: "hero-1",
			headline: "  Agents you can hold accountable. ",
			subheadline: "Proof before claims.",
			primary_cta_label: "Request access",
			primary_cta_url: "https://tedix.dev/contact",
		},
		{
			_type: "marketing_prose",
			_version: 1,
			_key: "prose-1",
			body: [
				{
					_type: "block",
					children: [{ _type: "span", text: "One  verified\n change." }],
					markDefs: [{ _type: "link", href: "https://example.com/internal" }],
				},
			],
		},
		{
			_type: "marketing_faq",
			_version: 1,
			_key: "faq-1",
			items: [
				{ question: "Who approves?", answer: "An independent reviewer." },
			],
		},
	];

	it("indexes visible block copy in order without URLs or block metadata", () => {
		expect(projectPageSearchText(content, schemas)).toBe(
			"Agents you can hold accountable.\nProof before claims.\nRequest access\nOne verified change.\nWho approves?\nAn independent reviewer.",
		);
	});

	it("indexes native image descriptions without media or tool metadata", () => {
		const nativeContent = [
			{
				_type: "marketing_hero",
				_version: 2,
				headline: "A visible headline",
				image: {
					id: "private-media-id",
					provider: "local",
					filename: "private-image.jpg",
					blurhash: "private-blurhash",
					meta: { storageKey: "private-storage-key" },
					alt: "A useful image description",
					caption: "A useful caption",
					completionEvidence: { toolName: "media_to_field_value" },
				},
			},
			{
				_type: "marketing_logo_strip",
				_version: 2,
				items: [
					{
						image: {
							id: "",
							provider: "external",
							src: "https://example.com/logo.svg",
							alt: "Partner logo",
						},
						href: "https://example.com",
					},
				],
			},
			{
				_type: "marketing_testimonials",
				_version: 2,
				items: [
					{
						avatar: { id: "avatar-id", alt: "Author portrait" },
						quote: "A visible testimonial",
					},
				],
			},
		];

		expect(projectPageSearchText(nativeContent, schemas)).toBe(
			"A visible headline\nA useful image description\nA useful caption\nPartner logo\nA visible testimonial\nAuthor portrait",
		);
	});

	it("updates the projection on a partial pages content save", async () => {
		const result = await save({
			collection: "pages",
			content: { content, search_text: "stale" },
			isNew: false,
		});
		expect(result).toEqual({
			content,
			search_text: projectPageSearchText(content, schemas),
		});
		expect(pageSearch.hooks["content:beforeSave"].errorPolicy).toBe("abort");
	});

	it("leaves unrelated fields and collections untouched and clears removed blocks", async () => {
		const hook = save;
		expect(
			await hook({
				collection: "pages",
				content: { title: "Updated" },
				isNew: false,
			}),
		).toBeUndefined();
		expect(
			await hook({ collection: "posts", content: { content }, isNew: false }),
		).toBeUndefined();
		expect(
			await hook({
				collection: "pages",
				content: { content: [] },
				isNew: false,
			}),
		).toEqual({ content: [], search_text: "" });
	});

	it("rejects malformed pages.content instead of keeping a stale index", async () => {
		await expect(
			save({
				collection: "pages",
				content: { content: null },
				isNew: false,
			}),
		).rejects.toThrow("pages.content must be an array");
		await expect(
			save({
				collection: "pages",
				content: { search_text: "manual edit" },
				isNew: false,
			}),
		).rejects.toThrow("pages.search_text is derived from native blocks");
	});
});

describe("schema-based native block search", () => {
	it("indexes feature and pricing repeater text with no undeclared metadata", () => {
		expect(
			projectPageSearchText(
				[
					{
						_type: "marketing_features",
						_version: 1,
						items: [
							{
								title: "Search within blocks",
								body: "Find the detail",
								secret: "private",
							},
						],
					},
					{
						_type: "marketing_pricing",
						_version: 1,
						plans: [
							{
								name: "Starter",
								price: "$19",
								period: "monthly",
								features: "Native search\nAI answers",
								highlighted: true,
							},
						],
					},
				],
				schemas,
			),
		).toBe(
			"Search within blocks\nFind the detail\nStarter\n$19\nmonthly\nNative search AI answers",
		);
	});
	it("uses declared types, not field names, and exact stored versions", () => {
		const custom = [
			{
				slug: "custom",
				versions: [
					{
						version: 1,
						fields: [
							{ slug: "href", type: "text" as const },
							{ slug: "destination", type: "url" as const },
						],
					},
					{ version: 2, fields: [{ slug: "newCopy", type: "text" as const }] },
				],
			},
		];
		expect(
			projectPageSearchText(
				[
					{
						_type: "custom",
						_version: 1,
						href: "Visible label",
						destination: "secret",
						newCopy: "wrong version",
						arbitrary: "private",
					},
				],
				custom,
			),
		).toBe("Visible label");
		expect(() =>
			projectPageSearchText([{ _type: "custom", _version: 3 }], custom),
		).toThrow("schema version");
	});
	it("joins marked Portable Text spans without inserting word breaks", () => {
		expect(
			projectPageSearchText(
				[
					{
						_type: "marketing_prose",
						_version: 1,
						body: [
							{
								_type: "block",
								children: [
									{ _type: "span", text: "price" },
									{ _type: "span", text: "less" },
								],
								markDefs: [{ secret: "hidden" }],
							},
						],
					},
				],
				schemas,
			),
		).toBe("priceless");
	});
	it("configures other collections and discovers all native block fields", async () => {
		settings.mockResolvedValue("services, pages,services");
		expect(await searchCollections(ctx)).toEqual(["services", "pages"]);
		mocks.getCollectionWithFields.mockResolvedValue({
			...collection,
			slug: "services",
			fields: [
				{ slug: "sections", type: "blocks" },
				{ slug: "footer", type: "blocks" },
			],
		});
		mocks.findById.mockResolvedValue({
			data: { footer: block("Live footer") },
			draftRevisionId: "pending",
		});
		mocks.revision.mockResolvedValue({
			data: { footer: block("Draft footer") },
		});
		expect(
			await save({
				collection: "services",
				id: "entry",
				isNew: false,
				content: { sections: block("New copy") },
			}),
		).toEqual({
			sections: block("New copy"),
			search_text: "New copy\nDraft footer",
		});
	});
	it("allows disabling projection without guessing a tenant", async () => {
		settings.mockResolvedValue("");
		expect(
			await save({
				collection: "pages",
				isNew: false,
				content: { content: block("Hello") },
			}),
		).toBeUndefined();
		expect(mocks.getCollectionWithFields).not.toHaveBeenCalled();
	});
});

describe("native search provisioning and published backfill", () => {
	it("requires POST before any provisioning or content writes", async () => {
		const route = {
			input: { collection: "pages" },
			request: {
				url: "https://example.com/backfill",
				method: "GET",
				headers: {},
			},
			requestMeta: { ip: null, userAgent: null, referer: null, geo: null },
		};
		const response = await pageSearch.routes.backfill.handler(route, ctx);
		expect(response).toBeInstanceOf(Response);
		expect((response as Response).status).toBe(405);
		expect(mocks.getCollectionWithFields).not.toHaveBeenCalled();
	});
	it("ships the searchable field and registers projection outside the tenant policy", () => {
		const seed = JSON.parse(
			readFileSync(
				new URL("../templates/marketing/seed/seed.json", import.meta.url),
				"utf8",
			),
		);
		expect(
			seed.collections.find((item: { slug: string }) => item.slug === "pages")
				.fields,
		).toContainEqual({
			slug: "search_text",
			label: "Generated search text",
			type: "text",
			searchable: true,
			widget: "derived-search-text",
		});
		const config = readFileSync(
			new URL("../templates/marketing/astro.config.mjs", import.meta.url),
			"utf8",
		);
		expect(config.indexOf('id: "tedix-page-search"')).toBeLessThan(
			config.indexOf('cmsDatabaseName === "tedix-landing"'),
		);
	});
	it("provisions text, covers all locales, preserves draft pointers, and rebuilds with existing weights", async () => {
		const entry = {
			id: "translated",
			data: { content: block("Published German copy") },
			version: 7,
			updatedAt: "timestamp",
			locale: "de",
			draftRevisionId: "pending",
		};
		mocks.findMany.mockResolvedValue({ items: [entry], nextCursor: null });
		expect(await backfillSearch(ctx, { collection: "pages" })).toEqual({
			collection: "pages",
			updated: 1,
			nextCursor: null,
			rebuilt: true,
		});
		expect(mocks.createField).toHaveBeenCalledWith("pages", {
			slug: "search_text",
			label: "Generated search text",
			type: "text",
			searchable: true,
			widget: "derived-search-text",
		});
		expect(mocks.findMany).toHaveBeenCalledWith("pages", {
			limit: 50,
			cursor: undefined,
			where: { status: "published" },
			orderBy: { field: "createdAt", direction: "asc" },
		});
		expect(mocks.update).toHaveBeenCalledWith(
			"pages",
			"translated",
			{ data: { search_text: "Published German copy" } },
			{ version: 7, updatedAt: "timestamp" },
		);
		expect(mocks.rebuildIndex).toHaveBeenCalledWith(
			"pages",
			["title", "search_text"],
			{ title: 5 },
			"unicode61",
		);
	});
	it("continues bounded pages and skips already correct projections", async () => {
		mocks.findMany.mockResolvedValue({
			items: [{ data: { content: block("Same"), search_text: "Same" } }],
			nextCursor: "next",
		});
		expect(
			await backfillSearch(ctx, { collection: "pages", cursor: "previous" }),
		).toMatchObject({ updated: 0, nextCursor: "next", rebuilt: false });
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.rebuildIndex).not.toHaveBeenCalled();
	});
	it("enables an absent index and repairs an existing field definition", async () => {
		mocks.getCollectionWithFields.mockResolvedValue({
			...collection,
			fields: [
				...collection.fields,
				{ slug: "search_text", type: "text", searchable: false },
			],
		});
		mocks.getSearchConfig.mockResolvedValue(null);
		await backfillSearch(ctx, { collection: "pages" });
		expect(mocks.updateField).toHaveBeenCalledWith("pages", "search_text", {
			searchable: true,
			widget: "derived-search-text",
		});
		expect(mocks.enableSearch).toHaveBeenCalledWith("pages");
	});
	it("stops on a concurrent edit instead of rebuilding stale values", async () => {
		mocks.findMany.mockResolvedValue({
			items: [
				{
					id: "raced",
					data: { content: block("Old") },
					version: 1,
					updatedAt: "before",
				},
			],
		});
		mocks.update.mockRejectedValue(new Error("conflict"));
		await expect(backfillSearch(ctx, { collection: "pages" })).rejects.toThrow(
			"conflict",
		);
		expect(mocks.rebuildIndex).not.toHaveBeenCalled();
	});
	it("rejects unconfigured collections and incompatible fields before content writes", async () => {
		await expect(
			backfillSearch(ctx, { collection: "private" }),
		).rejects.toThrow("not configured");
		mocks.getCollectionWithFields.mockResolvedValue({
			...collection,
			fields: [...collection.fields, { slug: "search_text", type: "json" }],
		});
		await expect(backfillSearch(ctx, { collection: "pages" })).rejects.toThrow(
			"derived text",
		);
		expect(mocks.update).not.toHaveBeenCalled();
		expect(pageSearch.routes.backfill.permission).toBe("settings:manage");
	});
});
