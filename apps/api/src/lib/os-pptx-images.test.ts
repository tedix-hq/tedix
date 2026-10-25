import { describe, it, expect, vi } from "vite-plus/test";
import { OsOutputContentSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { unzipSync, strFromU8 } from "fflate";
import { prepareOsPptxImages } from "./os-pptx-images";
import { buildOsOutputOfficeExport } from "./os-output-office";
const webp = "data:image/webp;base64,UklGRgAAAABXRUJQ";
const png = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY7sAAAAASUVORK5CYII=",
	),
	(c) => c.charCodeAt(0),
);
const content = OsOutputContentSchema.parse({
	kind: "presentation",
	slides: [],
	deck: {
		activeSlideId: "s",
		slides: [
			{
				id: "s",
				name: "Slide",
				backgroundImage: webp,
				elements: [
					{
						id: "logo",
						type: "image",
						src: webp,
						x: 100,
						y: 100,
						width: 240,
						height: 60,
						style: {},
					},
					{
						id: "copy",
						type: "image",
						src: webp,
						x: 400,
						y: 100,
						width: 240,
						height: 60,
						style: {},
					},
				],
			},
		],
	},
});

describe("PPTX WebP conversion", () => {
	it("rasterizes inlined covers and contained logos, deduplicates equal frames and writes valid native media", async () => {
		const quickAction = vi
			.fn()
			.mockImplementation(
				async () =>
					new Response(png, { headers: { "content-type": "image/png" } }),
			);
		const converted = await prepareOsPptxImages(content, { quickAction });
		expect(quickAction).toHaveBeenCalledTimes(2);
		expect(quickAction.mock.calls[0]?.[1]).toMatchObject({
			viewport: { width: 1200, height: 675 },
			screenshotOptions: { type: "png", omitBackground: true },
		});
		expect(quickAction.mock.calls[1]?.[1]).toMatchObject({
			viewport: { width: 240, height: 60 },
		});
		expect(quickAction.mock.calls[1]?.[1].html).toContain("object-fit:contain");
		expect(quickAction.mock.calls[0]?.[1].html).toContain("object-fit:cover");
		expect(quickAction.mock.calls[0]?.[1].allowRequestPattern).toBeDefined();
		expect(
			content.kind === "presentation" &&
				content.deck?.slides[0]?.backgroundImage,
		).toBe(webp);
		const file = unzipSync(
			await buildOsOutputOfficeExport("pptx", converted, "Logo proof"),
		);
		expect(
			Object.keys(file).filter((p) => p.startsWith("ppt/media/")),
		).toHaveLength(1);
		expect(strFromU8(file["ppt/slides/slide1.xml"]!)).toContain("<p:pic>");
	});
	it("converts WebP data URLs whatever the MIME type's case", async () => {
		const upper = structuredClone(content);
		if (upper.kind === "presentation") {
			const slide = upper.deck!.slides[0]!;
			slide.backgroundImage = webp.replace("image/webp", "IMAGE/WebP");
			for (const e of slide.elements) e.src = webp.replace("webp", "WEBP");
		}
		const quickAction = vi
			.fn()
			.mockImplementation(
				async () =>
					new Response(png, { headers: { "content-type": "image/png" } }),
			);
		const converted = await prepareOsPptxImages(upper, { quickAction });
		expect(quickAction).toHaveBeenCalledTimes(2);
		const slide =
			converted.kind === "presentation" ? converted.deck?.slides[0] : undefined;
		expect(slide?.backgroundImage).toMatch(/^data:image\/png;base64,/);
		for (const e of slide?.elements ?? [])
			expect(e.type === "image" && e.src).toMatch(/^data:image\/png;base64,/);
	});
	it("does not require Browser Rendering for already compatible images", async () => {
		const ready = structuredClone(content);
		if (ready.kind === "presentation") {
			delete ready.deck!.slides[0]!.backgroundImage;
			for (const e of ready.deck!.slides[0]!.elements)
				e.src = `data:image/png;base64,${btoa(String.fromCharCode(...png))}`;
		}
		await expect(prepareOsPptxImages(ready, undefined)).resolves.toEqual(ready);
	});
	it("rejects failed rasterization instead of dropping the logo", async () => {
		const quickAction = vi.fn().mockResolvedValue(
			new Response("not an image", {
				headers: { "content-type": "text/html" },
			}),
		);
		await expect(prepareOsPptxImages(content, { quickAction })).rejects.toThrow(
			"invalid PNG",
		);
	});
});
