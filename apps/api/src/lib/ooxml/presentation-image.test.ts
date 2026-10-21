import type { OsPresentationElement } from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it } from "vite-plus/test";
import { collectPptxImages } from "./pptx-images";
import {
	pptxImageFrame,
	presentationImageDimensions,
} from "./presentation-image";

const svg = (attributes: string) =>
	`data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" ${attributes}/>`)}`;
const element = (
	src: string,
	fit: "contain" | "cover" = "contain",
): OsPresentationElement => ({
	id: "image",
	type: "image",
	x: 10,
	y: 20,
	width: 100,
	height: 100,
	src,
	style: { fit },
});

describe("SVG presentation dimensions", () => {
	for (const quote of ["'", '"']) {
		it.each([
			[`viewBox=${quote}0 0 320 160${quote}`],
			[`width=${quote}320${quote} height=${quote}160${quote}`],
			[`width \t= ${quote} 320 ${quote} height = ${quote}160 ${quote}`],
			[`viewBox = ${quote} \t-10, -20, 320,\n160 ${quote}`],
		])("reads %s", (attributes) => {
			expect(presentationImageDimensions(svg(attributes))).toEqual({
				width: 320,
				height: 160,
			});
		});

		it("prefers explicit dimensions over viewBox with " + quote, () => {
			expect(
				presentationImageDimensions(
					svg(
						`width=${quote}80.5${quote} height=${quote}40.25${quote} viewBox=${quote}0 0 320 160${quote}`,
					),
				),
			).toEqual({ width: 80.5, height: 40.25 });
		});

		it.each(["0", "-1", "NaN", "Infinity", "1.2.3", "", "9".repeat(400)])(
			"falls back from invalid explicit width %s with " + quote,
			(width) => {
				expect(
					presentationImageDimensions(
						svg(
							`width=${quote}${width}${quote} height=${quote}100${quote} viewBox=${quote}0 0 320 160${quote}`,
						),
					),
				).toEqual({ width: 320, height: 160 });
			},
		);

		it.each(["0", "-1", "NaN", "Infinity", "1.2.3", "", "9".repeat(400)])(
			"rejects unusable dimensions %s with " + quote,
			async (value) => {
				for (const attributes of [
					`width=${quote}${value}${quote} height=${quote}160${quote}`,
					`width=${quote}320${quote} height=${quote}${value}${quote}`,
					`viewBox=${quote}0 0 ${value} 160${quote}`,
					`viewBox=${quote}0 0 320 ${value}${quote}`,
				]) {
					const src = svg(attributes);
					expect(presentationImageDimensions(src)).toBeUndefined();
					await expect(
						collectPptxImages([
							{
								id: "slide",
								name: "Slide",
								layout: "blank",
								background: "#ffffff",
								elements: [element(src)],
							},
						]),
					).rejects.toThrow("Invalid PPTX image dimensions");
				}
			},
		);
	}

	it("falls back when either explicit dimension is missing", () => {
		for (const attributes of ["width='100'", "height='100'"])
			expect(
				presentationImageDimensions(svg(`${attributes} viewBox='0 0 320 160'`)),
			).toEqual({ width: 320, height: 160 });
	});

	it("reads only the root svg element's attributes", () => {
		const document = (root: string, children: string) =>
			`data:image/svg+xml;base64,${btoa(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" ${root}>${children}</svg>`)}`;
		for (const [root, children] of [
			["viewBox='0 0 320 160'", "<rect width='10' height='20'/>"],
			[
				"width='100%' height='100%' viewBox='0 0 320 160'",
				"<image width='10' height='20'/>",
			],
			[
				"stroke-width='2' viewBox='0 0 320 160'",
				"<rect line-height='3' x='0'/>",
			],
		])
			expect(presentationImageDimensions(document(root, children))).toEqual({
				width: 320,
				height: 160,
			});
	});

	it("requires matching XML quotes", () => {
		expect(
			presentationImageDimensions(
				svg(`width='320" height='160" viewBox='0 0 320 160"`),
			),
		).toBeUndefined();
	});

	it.each(["contain", "cover"] as const)(
		"preserves %s geometry across quote forms and dimension sources",
		async (fit) => {
			for (const attributes of [
				"viewBox='0 0 320 160'",
				"width='320' height='160'",
			]) {
				const single = element(svg(attributes), fit);
				const double = element(svg(attributes.replaceAll("'", '"')), fit);
				const frame = pptxImageFrame(single);
				expect(frame).toEqual({
					...pptxImageFrame(double),
					element: { ...pptxImageFrame(double).element, src: single.src },
				});
				expect(frame.element).toMatchObject(
					fit === "contain"
						? { x: 10, y: 45, width: 100, height: 50 }
						: { x: 10, y: 20, width: 100, height: 100 },
				);
				expect(frame.crop).toBe(
					fit === "cover" ? '<a:srcRect l="25000" r="25000" t="0" b="0"/>' : "",
				);
				const images = await collectPptxImages([
					{
						id: "slide",
						name: "Slide",
						layout: "blank",
						background: "#ffffff",
						elements: [single, double],
					},
				]);
				for (const image of images.values())
					expect(image).toMatchObject({ width: 320, height: 160 });
				expect(images.size).toBe(2);
			}
		},
	);
});

describe("raster presentation dimensions", () => {
	it.each(["png", "gif", "jpeg"])("retains the %s reader", (format) => {
		const bytes = new Uint8Array(24);
		const view = new DataView(bytes.buffer);
		if (format === "png") {
			view.setUint32(16, 320);
			view.setUint32(20, 160);
		}
		if (format === "gif") {
			view.setUint16(6, 320, true);
			view.setUint16(8, 160, true);
		}
		if (format === "jpeg") {
			bytes.set([255, 216, 255, 192, 0, 17, 8]);
			view.setUint16(7, 160);
			view.setUint16(9, 320);
		}
		expect(
			presentationImageDimensions(
				`data:image/${format};base64,${btoa(String.fromCharCode(...bytes))}`,
			),
		).toEqual({ width: 320, height: 160 });
	});
});
