import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDialect } from "emdash/db/sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { PUT as setMenuItems } from "../templates/tedix/node_modules/emdash/dist/astro/routes/api/menus/_name_/items.mjs";
// @ts-expect-error The installed runtime chunk has no declarations.
import { n as EmDashRuntime } from "../templates/tedix/node_modules/emdash/dist/emdash-runtime-BlybX9Ui.mjs";
// @ts-expect-error The installed menu chunk has no declarations.
import { d as menus } from "../templates/tedix/node_modules/emdash/dist/menus-6RHNq4ZK.mjs";
vi.mock("virtual:emdash/config", () => ({ default: {} }));
vi.mock("virtual:emdash/seed", () => ({
	seed: {
		version: "1",
		settings: {},
		blockTypes: [
			{
				slug: "hero",
				label: "Hero",
				currentVersion: 2,
				versions: [
					{
						version: 1,
						fields: [
							{
								slug: "headline",
								label: "Headline",
								type: "string",
								required: true,
							},
						],
					},
					{
						version: 2,
						fields: [
							{
								slug: "headline",
								label: "Headline",
								type: "string",
								required: true,
							},
							{ slug: "subtitle", label: "Subtitle", type: "string" },
						],
					},
				],
			},
		],
		collections: [
			{
				slug: "pages",
				label: "Pages",
				supports: ["drafts", "revisions"],
				fields: [
					{ slug: "title", label: "Title", type: "string" },
					{
						slug: "content",
						label: "Content",
						type: "blocks",
						validation: { allowedTypes: ["hero"] },
					},
				],
			},
		],
	},
	userSeed: null,
}));
let runtime: InstanceType<typeof EmDashRuntime>;
let directory: string;
let counter = 0;
const block = () => ({
	_type: "hero",
	_version: 2,
	_key: "hero",
	headline: "Live",
});
async function draft() {
	const result = await runtime.handleContentCreate("pages", {
		slug: "home",
		data: { title: "Live", content: [block()] },
	});
	expect(result.success, JSON.stringify(result)).toBe(true);
	const edited = await runtime.handleContentUpdate(
		"pages",
		result.data.item.id,
		{ data: { title: "Draft title" }, _rev: result.data._rev },
	);
	expect(edited.success, JSON.stringify(edited)).toBe(true);
	expect(edited.data.item.draftRevisionId).not.toBeNull();
	return edited.data;
}
async function page(id: string) {
	return runtime.db
		.selectFrom("ec_pages")
		.selectAll()
		.where("id", "=", id)
		.executeTakeFirst();
}
async function corrupt(revisionId: string, content: unknown) {
	await runtime.db
		.updateTable("revisions")
		.set({ data: JSON.stringify({ title: "Historical", content }) })
		.where("id", "=", revisionId)
		.execute();
}
async function menuRequest(items: unknown[], role = 50, locale = "en") {
	const invalidations: unknown[] = [];
	const response = await setMenuItems({
		params: { name: "primary" },
		request: new Request(
			`https://acme.cms.tedix.dev/_emdash/api/menus/primary/items?locale=${locale}`,
			{
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					"X-EmDash-Request": "1",
				},
				body: JSON.stringify({ items }),
			},
		),
		locals: { emdash: runtime, user: { id: "editor", role } },
		cache: {
			enabled: true,
			invalidate: async (options: unknown) => {
				invalidations.push(options);
			},
		},
	} as unknown as Parameters<typeof setMenuItems>[0]);
	return { response, invalidations };
}
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "tedix-native-integrity-"));
	const url = `file:${join(directory, "site.db")}`;
	runtime = await EmDashRuntime.create({
		config: {
			database: {
				entrypoint: `integrity-${++counter}`,
				config: { url },
				type: "sqlite",
			},
		},
		plugins: [],
		createDialect: () => createDialect({ url }),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	});
});
afterEach(async () => {
	await runtime?.stopCron();
	await runtime?.db.destroy();
	if (directory) await rm(directory, { recursive: true, force: true });
});
describe("native stored block integrity", () => {
	it("rejects a corrupt historical restore without changing draft or live data", async () => {
		const created = await draft();
		await corrupt(created.item.draftRevisionId, [
			{ ...block(), headline: 123 },
		]);
		const baseline = await page(created.item.id);
		const result = await runtime.handleRevisionRestore(
			created.item.draftRevisionId,
			"editor",
		);
		expect(result.success).toBe(false);
		expect(result.error.code).toBe("VALIDATION_ERROR");
		expect(await page(created.item.id)).toEqual(baseline);
	});
	it("rejects corrupt publication even without policy plugins", async () => {
		const created = await draft();
		const published = await runtime.handleContentPublish(
			"pages",
			created.item.id,
			{ _rev: created._rev },
		);
		expect(published.success, JSON.stringify(published)).toBe(true);
		const read = await runtime.handleContentGet("pages", created.item.id);
		const update = await runtime.handleContentUpdate("pages", created.item.id, {
			data: { title: "Draft" },
			_rev: read.data._rev,
		});
		expect(update.success).toBe(true);
		await corrupt(update.data.item.draftRevisionId, [
			{ ...block(), headline: 123 },
		]);
		const baseline = await page(created.item.id);
		const current = await runtime.handleContentGet("pages", created.item.id);
		const result = await runtime.handleContentPublish(
			"pages",
			created.item.id,
			{ _rev: current.data._rev },
		);
		expect(result.success).toBe(false);
		expect(result.error.code).toBe("VALIDATION_ERROR");
		expect(await page(created.item.id)).toEqual(baseline);
	});
	it.each([
		{ content: [{ ...block(), _key: "" }] },
		{ content: [block(), block()] },
		{ content: [{ ...block(), _version: 999 }] },
	])(
		"rejects corrupt stored keys or unavailable versions without staging a restore",
		async ({ content }) => {
			const created = await draft();
			await corrupt(created.item.draftRevisionId, content);
			const baseline = await page(created.item.id);
			const result = await runtime.handleRevisionRestore(
				created.item.draftRevisionId,
				"editor",
			);
			expect(result.success).toBe(false);
			expect(await page(created.item.id)).toEqual(baseline);
		},
	);

	it("retains supported historical block versions through restore and publication", async () => {
		const created = await draft();
		await corrupt(created.item.draftRevisionId, [{ ...block(), _version: 1 }]);
		const restored = await runtime.handleRevisionRestore(
			created.item.draftRevisionId,
			"editor",
		);
		expect(restored.success, JSON.stringify(restored)).toBe(true);
		expect(restored.data.item.data.content[0]._version).toBe(1);
		const result = await runtime.handleContentPublish(
			"pages",
			created.item.id,
			{ _rev: restored.data._rev },
		);
		expect(result.success, JSON.stringify(result)).toBe(true);
		expect(result.data.item.data.content[0]._version).toBe(1);
	});
});
describe("native atomic menu REST replacement", () => {
	beforeEach(async () => {
		expect(
			(
				await menus.handleMenuCreate(runtime.db, {
					name: "primary",
					label: "Primary",
					locale: "en",
				})
			).success,
		).toBe(true);
	});
	it("writes ordered nested items and invalidates native cache tags", async () => {
		const { response, invalidations } = await menuRequest([
			{ type: "custom", label: "Parent", customUrl: "/" },
			{ type: "custom", label: "Child", customUrl: "/child", parentIndex: 0 },
		]);
		expect(response.status).toBe(200);
		const result = await menus.handleMenuGet(runtime.db, "primary", {
			locale: "en",
		});
		expect(
			result.data.items.map((item: { label: string }) => item.label),
		).toEqual(["Parent", "Child"]);
		expect(result.data.items[1].parentId).toBe(result.data.items[0].id);
		expect(invalidations).toEqual([{ tags: ["emdash:menu:primary"] }]);
	});
	it("preserves navigation on denied permissions or invalid parent references", async () => {
		await menuRequest([
			{ type: "custom", label: "Original", customUrl: "/old" },
		]);
		const baseline = await menus.handleMenuGet(runtime.db, "primary", {
			locale: "en",
		});
		expect((await menuRequest([], 10)).response.status).toBe(403);
		const invalid = await menuRequest([
			{ type: "custom", label: "Bad", customUrl: "/bad", parentIndex: 0 },
		]);
		expect(invalid.response.status).toBe(400);
		expect(invalid.invalidations).toEqual([]);
		expect(
			await menus.handleMenuGet(runtime.db, "primary", { locale: "en" }),
		).toEqual(baseline);
	});
	it("changes only the explicitly selected locale", async () => {
		await menuRequest([{ type: "custom", label: "English", customUrl: "/en" }]);
		const english = await menus.handleMenuGet(runtime.db, "primary", {
			locale: "en",
		});
		expect(
			(
				await menus.handleMenuCreate(runtime.db, {
					name: "primary",
					label: "Deutsch",
					locale: "de",
				})
			).success,
		).toBe(true);
		const result = await menuRequest(
			[{ type: "custom", label: "Deutsch", customUrl: "/de" }],
			50,
			"de",
		);
		expect(result.response.status).toBe(200);
		expect(
			await menus.handleMenuGet(runtime.db, "primary", { locale: "en" }),
		).toEqual(english);
		expect(
			(await menus.handleMenuGet(runtime.db, "primary", { locale: "de" })).data
				.items[0].label,
		).toBe("Deutsch");
	});

	it("rejects unsafe URLs through native schema parsing", async () => {
		expect(
			(
				await menuRequest([
					{ type: "custom", label: "Unsafe", customUrl: "javascript:alert(1)" },
				])
			).response.status,
		).toBe(400);
	});
});
