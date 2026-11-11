import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it } from "vite-plus/test";
import {
	outputAssetReferences,
	withEmbeddedOutputAssets,
} from "./output-assets";

const A = `tedix-asset:${"a".repeat(64)}`;
const B = `tedix-asset:${"b".repeat(64)}`;

const deck = {
	kind: "presentation",
	slides: [],
	deck: {
		width: 1200,
		height: 675,
		activeSlideId: "s1",
		slides: [
			{
				id: "s1",
				name: "One",
				layout: "blank",
				background: "#fff",
				backgroundImage: B,
				elements: [
					{ id: "e1", type: "image", src: A },
					{ id: "e2", type: "image", src: A },
					{ id: "e3", type: "image", src: "https://example.org/a.png" },
					{ id: "e4", type: "text", text: A },
				],
			},
		],
	},
} as unknown as OsOutputContent;

describe("stored images of a file", () => {
	it("lists each stored image once, from slides and documents", () => {
		expect(outputAssetReferences(deck).sort()).toEqual([A, B]);
		expect(
			outputAssetReferences({
				kind: "document",
				blocks: [],
				richText: {
					type: "doc",
					content: [
						{
							type: "paragraph",
							content: [{ type: "image", attrs: { src: A } }],
						},
						{ type: "image", attrs: { src: "data:image/png;base64,AA==" } },
					],
				},
			}),
		).toEqual([A]);
		expect(
			outputAssetReferences({ kind: "sheet", columns: [A], rows: [] }),
		).toEqual([]);
	});

	it("draws known images from embedded copies and leaves the content alone", () => {
		const shown = withEmbeddedOutputAssets(
			deck,
			new Map([[A, "data:image/png;base64,QQ=="]]),
		) as typeof deck & {
			deck: { slides: Array<Record<string, unknown>> };
		};
		const slide = shown.deck.slides[0] as {
			backgroundImage: string;
			elements: Array<{ src?: string; text?: string }>;
		};
		expect(slide.elements.map((element) => element.src)).toEqual([
			"data:image/png;base64,QQ==",
			"data:image/png;base64,QQ==",
			"https://example.org/a.png",
			undefined,
		]);
		expect(slide.elements[3]!.text).toBe(A);
		expect(slide.backgroundImage).toBe(B);
		expect(outputAssetReferences(deck).sort()).toEqual([A, B]);
		expect(withEmbeddedOutputAssets(deck, new Map())).toBe(deck);
	});
});
