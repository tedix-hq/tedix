import { Buffer } from "node:buffer";
import { describe, expect, it } from "vite-plus/test";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { inlineOsExportImages } from "../lib/os-export-images";
import {
	deleteOutputAssets,
	externalizeOutputAssets,
	outputAssetReader,
	parseOutputContentWithImages,
	readOutputAsset,
	storeOutputAsset,
} from "./os-output-assets";

function bucket() {
	const objects = new Map<string, { bytes: ArrayBuffer; type?: string }>();
	let heads = 0;
	return {
		objects,
		heads: () => heads,
		async put(
			key: string,
			bytes: ArrayBuffer,
			options?: { httpMetadata?: { contentType?: string } },
		) {
			objects.set(key, { bytes, type: options?.httpMetadata?.contentType });
		},
		async get(key: string) {
			const object = objects.get(key);
			return object
				? {
						arrayBuffer: async () => object.bytes,
						httpMetadata: { contentType: object.type },
					}
				: null;
		},
		async head(key: string) {
			heads++;
			return objects.has(key) ? { key } : null;
		},
		async list({ prefix }: { prefix: string }) {
			return {
				objects: [...objects.keys()]
					.filter((key) => key.startsWith(prefix))
					.map((key) => ({ key })),
				truncated: false,
			};
		},
		async delete(keys: string[]) {
			for (const key of keys) objects.delete(key);
		},
	};
}

const picture = (fill: number, type = "image/png") => {
	const bytes = Buffer.alloc(3_000, fill);
	return {
		bytes,
		dataUrl: `data:${type};base64,${bytes.toString("base64")}`,
	};
};
const ICON = "data:image/png;base64,aWNvbg==";
let files = 0;
const scope = () => ({
	organizationId: "org-1",
	outputId: `out-${++files}`,
});

function deck(sources: { image: string; background?: string }) {
	return JSON.stringify({
		kind: "presentation",
		slides: [],
		deck: {
			activeSlideId: "s1",
			slides: [
				{
					id: "s1",
					name: "One",
					backgroundImage: sources.background,
					elements: [
						{ id: "e1", type: "image", src: sources.image },
						{ id: "e2", type: "text", text: "data: stays text" },
					],
				},
			],
		},
	});
}

describe("images stored with a file", () => {
	it("stores embedded slide images apart and leaves references in the body", async () => {
		const store = bucket();
		const file = scope();
		const one = picture(1);
		const two = picture(2, "image/jpeg");
		const stored = JSON.parse(
			await externalizeOutputAssets(
				file,
				deck({ image: one.dataUrl, background: two.dataUrl }),
				store,
			),
		);
		const slide = stored.deck.slides[0];
		expect(slide.elements[0].src).toBe(
			`tedix-asset:${await sha256Hex(one.bytes)}`,
		);
		expect(slide.backgroundImage).toBe(
			`tedix-asset:${await sha256Hex(two.bytes)}`,
		);
		expect(slide.elements[1].text).toBe("data: stays text");
		expect([...store.objects.keys()].sort()).toEqual(
			[slide.elements[0].src, slide.backgroundImage]
				.map(
					(reference: string) =>
						`os-output-assets/v1/org-1/${file.outputId}/${reference.slice(12)}`,
				)
				.sort(),
		);
		const key = `os-output-assets/v1/org-1/${file.outputId}/${await sha256Hex(one.bytes)}`;
		expect(store.objects.get(key)?.type).toBe("image/png");
		expect(Buffer.from(store.objects.get(key)!.bytes).equals(one.bytes)).toBe(
			true,
		);
		expect(JSON.stringify(stored)).not.toContain("base64");
	});

	it("stores a document image and keeps a tiny inline icon and a link", async () => {
		const store = bucket();
		const file = scope();
		const image = picture(3, "image/webp");
		const stored = JSON.parse(
			await externalizeOutputAssets(
				file,
				JSON.stringify({
					kind: "document",
					blocks: [],
					richText: {
						type: "doc",
						content: [
							{ type: "image", attrs: { src: image.dataUrl, alt: "a" } },
							{
								type: "paragraph",
								content: [{ type: "image", attrs: { src: ICON } }],
							},
							{ type: "image", attrs: { src: "https://example.org/a.png" } },
						],
					},
				}),
				store,
			),
		);
		expect(stored.richText.content[0].attrs).toEqual({
			src: `tedix-asset:${await sha256Hex(image.bytes)}`,
			alt: "a",
		});
		expect(stored.richText.content[1].content[0].attrs.src).toBe(ICON);
		expect(stored.richText.content[2].attrs.src).toBe(
			"https://example.org/a.png",
		);
		expect(store.objects.size).toBe(1);
	});

	it("stores the same image once and leaves a body without images untouched", async () => {
		const store = bucket();
		const file = scope();
		const image = picture(4);
		const body = deck({ image: image.dataUrl, background: image.dataUrl });
		const first = await externalizeOutputAssets(file, body, store);
		expect(await externalizeOutputAssets(file, first, store)).toBe(first);
		expect(store.objects.size).toBe(1);
		const sheet = '{"kind":"sheet","columns":["data:"],"rows":[]}';
		expect(await externalizeOutputAssets(file, sheet, store)).toBe(sheet);
	});

	it("accepts a reference the file holds and refuses one it does not", async () => {
		const store = bucket();
		const file = scope();
		const other = scope();
		const reference = await storeOutputAsset(file, picture(5).dataUrl, store);
		const body = deck({ image: reference });
		// A second isolate has not seen the write: it asks the store.
		expect(
			await externalizeOutputAssets(file, body, {
				put: store.put,
				head: store.head,
			}),
		).toBe(body);
		await expect(
			externalizeOutputAssets(other, body, store),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			externalizeOutputAssets(
				file,
				deck({ image: `tedix-asset:${"0".repeat(64)}` }),
				store,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("refuses an embedded image the export checks refuse", async () => {
		const store = bucket();
		const pad = "<!-- ".concat("x".repeat(2_100), " -->");
		for (const source of [
			`data:text/html;base64,${Buffer.alloc(3_000, 1).toString("base64")}`,
			`data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg"><script>1</script>${pad}</svg>`)}`,
		])
			await expect(
				externalizeOutputAssets(scope(), deck({ image: source }), store),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(store.objects.size).toBe(0);
	});

	it("reads an image back only from the file that holds it", async () => {
		const store = bucket();
		const file = scope();
		const image = picture(6);
		const reference = await storeOutputAsset(file, image.dataUrl, store);
		expect(await readOutputAsset(file, reference, store)).toBe(image.dataUrl);
		expect(await readOutputAsset(scope(), reference, store)).toBeNull();
		expect(
			await readOutputAsset(
				{ ...file, organizationId: "org-2" },
				reference,
				store,
			),
		).toBeNull();
		expect(
			await readOutputAsset(file, "https://example.org/a", store),
		).toBeNull();
		await expect(
			readOutputAsset({ ...file, outputId: "../out-1" }, reference, store),
		).rejects.toThrow("Invalid output asset scope");
	});

	it("embeds stored images for a share page and for exports", async () => {
		const store = bucket();
		const file = scope();
		const image = picture(7);
		const content = await externalizeOutputAssets(
			file,
			deck({ image: image.dataUrl }),
			store,
		);
		const shared = (await parseOutputContentWithImages(
			{ ...file, content },
			store,
		)) as { deck: { slides: Array<{ elements: Array<{ src: string }> }> } };
		expect(shared.deck.slides[0]!.elements[0]!.src).toBe(image.dataUrl);
		const exported = await inlineOsExportImages(
			JSON.parse(content),
			outputAssetReader(file, store),
		);
		expect(exported.deck.slides[0].elements[0].src).toBe(image.dataUrl);
		await expect(inlineOsExportImages(JSON.parse(content))).rejects.toThrow(
			"stored images",
		);
		await expect(
			inlineOsExportImages(
				JSON.parse(content),
				outputAssetReader(scope(), store),
			),
		).rejects.toThrow("missing");
	});

	it("removes a deleted file's images and no other file's", async () => {
		const store = bucket();
		const file = scope();
		const kept = scope();
		await storeOutputAsset(file, picture(8).dataUrl, store);
		await storeOutputAsset(file, picture(9).dataUrl, store);
		const reference = await storeOutputAsset(kept, picture(8).dataUrl, store);
		expect(await deleteOutputAssets(file, store)).toBe(2);
		expect([...store.objects.keys()]).toEqual([
			`os-output-assets/v1/org-1/${kept.outputId}/${reference.slice(12)}`,
		]);
	});
});
