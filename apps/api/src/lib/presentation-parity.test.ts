import { describe, it, expect } from "vite-plus/test";
import { unzipSync, strFromU8 } from "fflate";
import { XMLValidator } from "fast-xml-parser";
import { OsOutputContentSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { DEFAULT_ORGANIZATION_OS_THEME } from "@tedix/api-contract/schemas/os-theme";
import { slideElementMarkup } from "@tedix/api-contract/utils/presentation-style";
import { renderOsOutputHtml } from "./os-output-html";
import { buildOsOutputOfficeExport } from "./os-output-office";
import { pptxImageFrame } from "./ooxml/presentation-image";

const image =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY7sAAAAASUVORK5CYII=";
// A distinct 1x1 PNG so the focal photo exports its own media part.
const photo =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const organization = {
	name: "Example Studio",
	logoUrl: image,
	appearance: {
		...DEFAULT_ORGANIZATION_OS_THEME,
		slideTones: { success: "#116633" },
	},
};
const base = { x: 80, y: 120, width: 300, height: 240, style: {} };
const content = OsOutputContentSchema.parse({
	kind: "presentation",
	slides: [],
	deck: {
		activeSlideId: "slide",
		slides: [
			{
				id: "slide",
				name: "Parity",
				background: "linear-gradient(120deg, #123456 0%, #abcdef 100%)",
				backgroundImage: image,
				dotGridOpacity: 0.3,
				insetSurface: {},
				elements: [
					{
						...base,
						id: "card",
						type: "card",
						props: {
							eyebrow: "SECTION",
							title: "**Card** title",
							body: "Safe <copy>",
							tone: "success",
							highlight: ["Card"],
						},
					},
					{
						...base,
						id: "box",
						type: "box",
						x: 420,
						props: {
							title: "Box",
							body: "Body",
							tone: "warning",
							dashed: true,
						},
					},
					{
						...base,
						id: "bullets",
						type: "bullet",
						y: 390,
						text: "First item\nSecond item",
					},
					{
						...base,
						id: "arrow",
						type: "arrow",
						props: {
							from: { x: 700, y: 500 },
							to: { x: 400, y: 300 },
							label: "Flow",
							dashed: true,
							strokeWidth: 3,
							color: "#234567",
						},
					},
					{
						...base,
						id: "pill",
						type: "label",
						props: { tone: "info" },
						text: "LABEL",
					},
					{
						...base,
						id: "ellipse",
						type: "shape",
						props: { kind: "ellipse" },
						style: { background: "#cccccc" },
					},
					{
						...base,
						id: "rectangle",
						type: "shape",
						props: { radius: 12 },
						style: { background: "#dddddd" },
					},
					{ ...base, id: "logo", type: "logo", width: 180, height: 60 },
					{
						...base,
						id: "photo",
						type: "image",
						src: photo,
						style: { fit: "cover" },
						props: { focalPoint: { x: 0.2, y: 0.8 } },
					},
				],
			},
		],
	},
});

describe("slide parity exports", () => {
	it("uses exact shared screen markup for PDF/PNG elements and slide backgrounds", () => {
		if (content.kind !== "presentation") throw new Error("fixture");
		const html = renderOsOutputHtml(
			{ kind: "presentation", title: "Parity" },
			{ content, revision: 1, createdAt: "2026-01-01T00:00:00Z" },
			organization,
		);
		for (const element of content.deck!.slides[0]!.elements)
			expect(html).toContain(
				slideElementMarkup(element, "pixels", organization),
			);
		for (const value of [
			"linear-gradient(120deg, #123456 0%, #abcdef 100%)",
			"opacity:0.3",
			"object-fit:cover",
			"object-position:20% 80%",
			"inset:24px",
			"Safe &lt;copy&gt;",
		])
			expect(html).toContain(value);
	});
	it("writes native card parts, hanging bullets, highlights, arrows, tones, shapes and embedded backgrounds/logo", async () => {
		const file = unzipSync(
			await buildOsOutputOfficeExport("pptx", content, "Parity", organization),
		);
		for (const [name, bytes] of Object.entries(file))
			if (name.endsWith(".xml") || name.endsWith(".rels"))
				expect(XMLValidator.validate(strFromU8(bytes)), name).toBe(true);
		const slide = strFromU8(file["ppt/slides/slide1.xml"]!);
		for (const value of [
			"SECTION",
			"Card",
			"title",
			"Safe &lt;copy&gt;",
			"Box",
			"Body",
			"First item",
			"Second item",
			"Flow",
			"LABEL",
			'marL="182880" indent="-182880"',
			'<a:buSzPts val="480"/>',
			'<a:spcPts val="800"/>',
			'<a:prstDash val="dash"/>',
			'<a:tailEnd type="triangle"',
			'flipH="1" flipV="1"',
			'val="234567"',
			'val="116633"',
			'prst="ellipse"',
			'prst="roundRect"',
			"<a:gradFill",
			'<a:latin typeface="Arial"/>',
			'r:embed="image1"',
		])
			expect(slide).toContain(value);
		expect(slide).not.toContain("**Card**");
		// The focal cover image exports a crop window shifted toward its focus.
		expect(slide).toContain('<a:srcRect l="0" r="0" t="16000" b="4000"/>');
		expect(
			Object.keys(file).filter((name) => name.startsWith("ppt/media/")),
		).toHaveLength(3);
		const relations = strFromU8(file["ppt/slides/_rels/slide1.xml.rels"]!);
		expect(relations).toContain('/image"');
		for (const match of relations.matchAll(/Target="\.\.\/media\/([^"]+)"/g))
			expect(file[`ppt/media/${match[1]}`]).toBeDefined();
	});
	it("fits logos inside their box and crops cover images without changing aspect ratio", () => {
		const element = {
			...base,
			id: "logo",
			type: "image" as const,
			width: 180,
			height: 60,
			src: image,
		};
		expect(pptxImageFrame(element).element).toMatchObject({
			x: 140,
			y: 120,
			width: 60,
			height: 60,
		});
		expect(pptxImageFrame({ ...element, id: "cover" }).crop).toBe("");
		expect(pptxImageFrame({ ...element, style: { fit: "cover" } }).crop).toBe(
			'<a:srcRect l="0" r="0" t="33333" b="33333"/>',
		);
	});
});
