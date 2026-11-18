import { readFileSync } from "node:fs";
import type { PluginContext } from "emdash/plugin";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import pageSearch, {
	armSearchBackfill,
	backfillSearch,
	runSearchBackfill,
	projectPageSearchText,
	searchCollections,
} from "../templates/tedix/src/plugins/tedix-page-search/index";

const mocks = vi.hoisted(() => ({
	aiRoute: vi.fn(),
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
vi.mock(
	"../templates/tedix/node_modules/emdash/dist/astro/middleware.mjs",
	() => ({
		withEmDashRuntime: async (run: (runtime: unknown) => Promise<void>) =>
			run({ handlePluginApiRoute: mocks.aiRoute }),
	}),
);
const schemas = JSON.parse(
	readFileSync(
		new URL("../templates/marketing/seed/seed.json", import.meta.url),
		"utf8",
	),
).blockTypes as Parameters<typeof projectPageSearchText>[1];
const settings = vi.fn();
const stateKey = "state:backfill-search";
const stateStore = new Map<string, { value: unknown; revision: string }>();
let revision = 0;
const tasks = new Set<string>();
const kv = {
	getVersioned: vi.fn(async (key: string) =>
		structuredClone(stateStore.get(key) ?? null),
	),
	compareAndSet: vi.fn(
		async (key: string, expected: string | null, value: unknown) => {
			if ((stateStore.get(key)?.revision ?? null) !== expected)
				return { applied: false };
			stateStore.set(key, {
				value: structuredClone(value),
				revision: String(++revision),
			});
			return { applied: true, revision: String(revision) };
		},
	),
};
const cron = {
	schedule: vi.fn(async (name: string) => {
		tasks.add(name);
	}),
	cancel: vi.fn(async (name: string) => {
		tasks.delete(name);
	}),
	list: vi.fn(async () => [...tasks].map((name) => ({ name }))),
};
const log = { error: vi.fn() };
const ctx = {
	settings: { get: settings },
	kv,
	cron,
	log,
} as unknown as PluginContext;
const tick = () =>
	pageSearch.hooks.cron.handler(
		{
			name: "backfill-search",
			scheduledAt: "2026-01-01T00:00:00Z",
		},
		ctx,
	);
const progress = () => stateStore.get(stateKey)?.value;

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
	stateStore.clear();
	tasks.clear();
	kv.getVersioned.mockImplementation(async (key) =>
		structuredClone(stateStore.get(key) ?? null),
	);
	kv.compareAndSet.mockImplementation(async (key, expected, value) => {
		if ((stateStore.get(key)?.revision ?? null) !== expected)
			return { applied: false };
		stateStore.set(key, {
			value: structuredClone(value),
			revision: String(++revision),
		});
		return { applied: true, revision: String(revision) };
	});
	cron.schedule.mockImplementation(async (name) => {
		tasks.add(name);
	});
	cron.cancel.mockImplementation(async (name) => {
		tasks.delete(name);
	});
	cron.list.mockImplementation(async () =>
		[...tasks].map((name) => ({ name })),
	);
	mocks.aiRoute.mockImplementation(
		async (_plugin, method, path, request: Request) => {
			if (path === "/config")
				return { success: true, data: { collections: ["posts"] } };
			if (method === "GET") return { success: true, data: null };
			const input = (await request.clone().json()) as { collections: string[] };
			return {
				success: true,
				data: { jobId: "new-job", done: false, collections: input.collections },
			};
		},
	);
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
	});
});

describe("automatic native search cron", () => {
	it("arms on install and activation without postponing the task or exposing a route", async () => {
		const event = { pluginId: "tedix-page-search", version: "0.1.0" };
		await pageSearch.hooks["plugin:install"].handler(event, ctx);
		await pageSearch.hooks["plugin:activate"].handler(event, ctx);
		expect(cron.schedule).toHaveBeenCalledExactlyOnceWith("backfill-search", {
			schedule: "* * * * *",
		});
		expect(pageSearch).not.toHaveProperty("routes");
		expect(progress()).toMatchObject({
			collections: ["pages"],
			collectionIndex: 0,
			done: false,
		});
	});

	it("checkpoints a batch of 50, resumes its cursor, rebuilds and self-cancels after requesting the union", async () => {
		mocks.findMany.mockResolvedValueOnce({
			items: Array.from({ length: 50 }, (_, index) => ({
				id: String(index),
				data: { content: block(`Published ${index}`) },
				version: 1,
				updatedAt: "before",
			})),
			nextCursor: "second-page",
		});
		await tick();
		expect(mocks.update).toHaveBeenCalledTimes(50);
		expect(progress()).toMatchObject({ cursor: "second-page", done: false });
		expect(mocks.rebuildIndex).not.toHaveBeenCalled();
		expect(mocks.aiRoute).not.toHaveBeenCalled();
		expect(cron.cancel).not.toHaveBeenCalled();
		await tick();
		expect(mocks.findMany).toHaveBeenLastCalledWith(
			"pages",
			expect.objectContaining({
				cursor: "second-page",
				limit: 50,
				where: { status: "published" },
			}),
		);
		expect(mocks.rebuildIndex).toHaveBeenCalledTimes(1);
		const post = mocks.aiRoute.mock.calls.find((args) => args[1] === "POST");
		expect(post?.slice(0, 3)).toEqual(["ai-search", "POST", "/reindex"]);
		expect(await (post?.[3] as Request).clone().json()).toEqual({
			collections: ["posts", "pages"],
			onlyMissing: false,
		});
		expect(progress()).toMatchObject({ done: true });
		expect(cron.cancel).toHaveBeenCalledWith("backfill-search");
		await armSearchBackfill(ctx);
		expect(tasks.size).toBe(0);
		expect(cron.schedule).toHaveBeenCalledTimes(1);
	});

	it("retains the successful cursor on conflict and reads fresh revisions on the next tick", async () => {
		mocks.findMany.mockResolvedValueOnce({
			items: [],
			nextCursor: "checkpoint",
		});
		await tick();
		const saved = structuredClone(progress());
		mocks.findMany.mockResolvedValueOnce({
			items: [
				{
					id: "raced",
					data: { content: block("Before") },
					version: 1,
					updatedAt: "before",
				},
			],
			nextCursor: null,
		});
		mocks.update.mockRejectedValueOnce(new Error("revision conflict"));
		await tick();
		expect(progress()).toEqual(saved);
		expect(log.error).toHaveBeenCalled();
		expect(mocks.rebuildIndex).not.toHaveBeenCalled();
		expect(cron.cancel).not.toHaveBeenCalled();
		mocks.findMany.mockResolvedValueOnce({
			items: [
				{
					id: "raced",
					data: { content: block("After") },
					version: 2,
					updatedAt: "after",
					draftRevisionId: "pending",
				},
			],
			nextCursor: null,
		});
		await tick();
		expect(mocks.update).toHaveBeenLastCalledWith(
			"pages",
			"raced",
			{ data: { search_text: "After" } },
			{ version: 2, updatedAt: "after" },
		);
		expect(
			mocks.findMany.mock.calls
				.slice(1)
				.every((args) => args[1].cursor === "checkpoint"),
		).toBe(true);
		expect(mocks.revision).not.toHaveBeenCalled();
		expect(progress()).toMatchObject({ done: true });
	});

	it("walks all configured collections before starting AI reindex", async () => {
		settings.mockResolvedValue("services,pages");
		mocks.getCollectionWithFields.mockImplementation(async (slug) => ({
			...collection,
			slug,
		}));
		await tick();
		expect(progress()).toMatchObject({ collectionIndex: 1, done: false });
		expect(mocks.aiRoute).not.toHaveBeenCalled();
		await tick();
		expect(mocks.findMany.mock.calls.map((args) => args[0])).toEqual([
			"pages",
			"services",
		]);
		expect(progress()).toMatchObject({ done: true });
	});

	it("re-arms completed sites on schema versions and changed settings, including bundle adoption", async () => {
		await tick();
		expect(tasks.size).toBe(0);
		mocks.listBlockTypes.mockResolvedValue([
			...schemas,
			{ slug: "new", versions: [{ version: 1, fields: [] }] },
		]);
		await pageSearch.hooks["page:metadata"].handler({} as never, ctx);
		expect(tasks.has("backfill-search")).toBe(true);
		expect(progress()).toMatchObject({ collectionIndex: 0, done: false });
		settings.mockResolvedValue("services");
		await armSearchBackfill(ctx);
		expect(progress()).toMatchObject({
			collections: ["services"],
			collectionIndex: 0,
		});
	});

	it("keeps retrying when native AI reindex is busy or unavailable", async () => {
		mocks.aiRoute.mockResolvedValueOnce({
			success: true,
			data: { jobId: "running", done: false },
		});
		await tick();
		expect(cron.cancel).not.toHaveBeenCalled();
		expect(mocks.aiRoute).toHaveBeenCalledTimes(1);
		mocks.aiRoute.mockResolvedValueOnce({ success: false });
		await tick();
		expect(cron.cancel).not.toHaveBeenCalled();
		await tick();
		expect(progress()).toMatchObject({ done: true });
		expect(mocks.findMany).toHaveBeenCalledTimes(1);
		expect(mocks.rebuildIndex).toHaveBeenCalledTimes(1);
	});

	it("does not overwrite progress after the configuration changed during a batch", async () => {
		await armSearchBackfill(ctx);
		mocks.findMany.mockImplementationOnce(async () => {
			settings.mockResolvedValue("services");
			await armSearchBackfill(ctx);
			return { items: [], nextCursor: "obsolete" };
		});
		await runSearchBackfill(ctx);
		expect(progress()).toMatchObject({
			collections: ["services"],
			collectionIndex: 0,
		});
		expect(progress()).not.toHaveProperty("cursor");
		expect(cron.cancel).not.toHaveBeenCalled();
	});

	it("cancels a disabled empty selection without changing the AI selection", async () => {
		settings.mockResolvedValue("");
		await tick();
		expect(mocks.findMany).not.toHaveBeenCalled();
		expect(mocks.aiRoute).not.toHaveBeenCalled();
		expect(cron.cancel).toHaveBeenCalledWith("backfill-search");
	});
});
