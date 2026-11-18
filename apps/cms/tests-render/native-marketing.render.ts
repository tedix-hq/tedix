import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { experimental_AstroContainer as AstroContainer } from "../templates/marketing/node_modules/astro/dist/container/index.js";
import { createScaffoldDatabase } from "../scripts/template-scaffold-fixture";
import MarketingBlocks from "../templates/native-marketing/src/components/MarketingBlocks.astro";
import PageView from "../templates/native-marketing/src/components/PageView.astro";

const seed = JSON.parse(
	readFileSync(
		new URL("../templates/native-marketing/seed/seed.json", import.meta.url),
		"utf8",
	),
);
type Field = {
	slug: string;
	type: string;
	options?: string[];
	validation?: { subFields?: Field[] };
};

function fieldValues(fields: Field[], marker: string): Record<string, unknown> {
	return Object.fromEntries(
		fields.flatMap((field) => {
			if (field.type === "image") return [];
			let value: unknown = marker;
			if (field.type === "boolean") value = true;
			else if (field.type === "select") value = field.options![0];
			else if (field.type === "repeater")
				value = [fieldValues(field.validation!.subFields!, marker)];
			else if (field.type === "portableText")
				value = [
					{
						_type: "block",
						_key: marker,
						style: "normal",
						markDefs: [],
						children: [
							{
								_type: "span",
								_key: `${marker}-text`,
								text: marker,
								marks: [],
							},
						],
					},
				];
			else if (field.type === "url" || field.slug.endsWith("_url"))
				value = "/example";
			return [[field.slug, value]];
		}),
	);
}

const blocks = seed.blockTypes.flatMap(
	(block: { slug: string; versions: { version: number; fields: Field[] }[] }) =>
		block.versions.map((version) => {
			const marker = `${block.slug}-v${version.version}`;
			return {
				...fieldValues(version.fields, marker),
				_type: block.slug,
				_version: version.version,
				_key: marker,
			};
		}),
);

async function render(
	component: unknown,
	props: Record<string, unknown>,
	locals = {},
) {
	const container = await AstroContainer.create();
	return container.renderToString(
		component as Parameters<typeof container.renderToString>[0],
		{ props, locals, request: new Request("https://example.test/about") },
	);
}

describe("fresh native marketing rendering", () => {
	let fixture: Awaited<ReturnType<typeof createScaffoldDatabase>>;
	let storedBlocks: typeof blocks;
	beforeAll(async () => {
		fixture = await createScaffoldDatabase("native-marketing");
		const versionSeed = join(fixture.directory, "versions.json");
		await writeFile(
			versionSeed,
			JSON.stringify({
				...seed,
				content: {
					pages: [
						{
							id: "block-versions",
							slug: "block-versions",
							status: "draft",
							data: { title: "Block versions", content: blocks },
						},
					],
				},
			}),
		);
		await fixture.apply(versionSeed);
		const db = new DatabaseSync(fixture.database);
		try {
			const row = db
				.prepare("SELECT content FROM ec_pages WHERE slug = ?")
				.get("block-versions")!;
			storedBlocks = JSON.parse(row.content as string);
			expect(storedBlocks).toEqual(blocks);
		} finally {
			db.close();
		}
	}, 60_000);
	afterAll(async () => {
		await fixture?.cleanup();
	});

	it("covers all eleven upstream types and every seed version", () => {
		expect(seed.blockTypes).toHaveLength(11);
		expect(storedBlocks).toHaveLength(
			seed.blockTypes.reduce(
				(count: number, block: { versions: unknown[] }) =>
					count + block.versions.length,
				0,
			),
		);
	});

	it.each(blocks)(
		"renders stored $_type v$_version through the native Blocks component",
		async (block) => {
			const value = storedBlocks.find(
				(stored: { _key: string }) => stored._key === block._key,
			)!;
			const html = await render(MarketingBlocks, { value: [value] });
			expect(html).toContain(`id="${block._key}"`);
			expect(html).toContain(block._key);
			expect(html).not.toContain("Unknown block");
		},
	);

	it("renders the page title only when there is no hero and preserves edit metadata", async () => {
		const page = {
			id: "about",
			data: {
				id: "page-id",
				title: "About our example",
				content: storedBlocks.filter(
					(block: { _type: string }) => block._type === "marketing_text",
				),
			},
			edit: {
				title: { "data-edit-title": "title" },
				content: { "data-edit-content": "content" },
			},
		};
		const html = await render(PageView, { page });
		expect(html).toMatch(
			/<h1[^>]*data-edit-title="title"[^>]*>About our example<\/h1>/,
		);
		expect(html).toContain('data-edit-content="content"');
		const heroHtml = await render(PageView, {
			page: { ...page, data: { ...page.data, content: storedBlocks } },
		});
		expect(heroHtml.match(/<h1\b/g)).toHaveLength(1);
		expect(heroHtml).not.toContain("About our example");
	});

	it("shows empty-page editor guidance only to an authenticated user", async () => {
		const page = {
			id: "empty",
			data: { id: "empty-id", title: "Empty example", content: [] },
			edit: {},
		};
		const publicHtml = await render(PageView, { page });
		expect(publicHtml).toContain("Empty example");
		expect(publicHtml).not.toContain("/_emdash/admin");
		const editorHtml = await render(
			PageView,
			{ page },
			{ user: { id: "editor" } },
		);
		expect(editorHtml).toContain(
			'href="/_emdash/admin/content/pages/empty-id"',
		);
	});
});
