import { describe, it, expect } from "vite-plus/test";
import {
	OsPresentationElementSchema,
	OsPresentationCanvasSlideSchema,
	OsPresentationSlideOutlineSchema,
	OsOutputContentSchema,
} from "../schemas/os-workspaces";
import { DEFAULT_ORGANIZATION_OS_THEME } from "../schemas/os-theme";
import {
	slideElementMarkup,
	slideBackgroundMarkup,
	slideElementStyle,
	slideArrowPath,
	parseSlideText,
	slideTone,
	slideCss,
	slideElementGeometry,
} from "./presentation-style";

const element = OsPresentationElementSchema.parse({
	id: "e",
	type: "text",
	x: 40,
	y: 60,
	width: 300,
	height: 160,
	style: {},
});
const organization = {
	name: "Example Studio",
	appearance: {
		...DEFAULT_ORGANIZATION_OS_THEME,
		slideTones: { success: "#116633" },
	},
};

describe("presentation parity", () => {
	it("structures card and box parts with scalable padding and escaped rich text", () => {
		for (const type of ["card", "box"] as const) {
			const card = {
				...element,
				type,
				props: {
					eyebrow: "Label",
					title: "**Title**",
					body: "<script>copy</script>",
				},
			};
			expect(slideElementStyle(card, "pixels").padding).toBe(
				type === "card" ? "20px" : "14px",
			);
			const markup = slideElementMarkup(card, "pixels");
			for (const part of ["eyebrow", "title", "body"])
				expect(markup).toContain(`data-slide-part="${part}"`);
			expect(markup).toContain(
				'<strong style="font-weight:700">Title</strong>',
			);
			expect(markup).toContain("&lt;script&gt;copy&lt;/script&gt;");
		}
	});
	it("renders hanging bullets with six-pixel dots and fixed primary or compact gaps", () => {
		for (const compact of [false, true]) {
			const markup = slideElementMarkup(
				{
					...element,
					type: "bullet",
					text: "First wrapped item\n\nSecond",
					props: { compact },
				},
				"pixels",
			);
			expect(markup.match(/role="listitem"/g)).toHaveLength(2);
			expect(markup).toContain("flex:0 0 6px");
			expect(markup).toContain("gap:12px");
			expect(markup).toContain(`gap:${compact ? 8 : 10}px`);
		}
	});
	it("draws arbitrary endpoint arrows with labels, dash patterns, color and width", () => {
		const arrow = {
			...element,
			type: "arrow" as const,
			props: {
				from: { x: 400, y: 300 },
				to: { x: 100, y: 90 },
				label: "<Go>",
				dashed: true,
				strokeWidth: 4,
				color: "#123456",
			},
		};
		expect(slideArrowPath(arrow)).toContain("M 316 238 L 16 28");
		const markup = slideElementMarkup(arrow);
		expect(markup).toContain('stroke-dasharray="6 6"');
		expect(markup).toContain('stroke-width="4"');
		expect(markup).toContain('stroke="#123456"');
		expect(markup).toContain("&lt;Go&gt;");
		expect(slideElementStyle(arrow, "pixels")).toMatchObject({
			left: "84px",
			top: "62px",
			width: "332px",
			height: "266px",
		});
	});
	it("highlights literal words inside bold without interpreting regular expressions or markup", () => {
		expect(parseSlideText("**A C++** and C++", ["C++"])).toEqual([
			{ text: "A ", bold: true },
			{ text: "C++", bold: true, highlight: true },
			{ text: " and ", bold: false },
			{ text: "C++", bold: false, highlight: true },
		]);
		const markup = slideElementMarkup(
			{ ...element, text: "**C++** <tag>", props: { highlight: ["C++"] } },
			"pixels",
			organization,
		);
		expect(markup).toContain(`color:${organization.appearance.light.accent}`);
		expect(markup).toContain('<strong style="font-weight:700">C++</strong>');
		expect(markup).toContain("&lt;tag&gt;");
	});
	it("uses organization tone overrides and deterministic semantic defaults", () => {
		expect(slideTone("success", organization).color).toBe("#116633");
		expect(slideTone("accent", organization).color).toBe(
			organization.appearance.light.accent,
		);
		for (const tone of [
			"neutral",
			"accent",
			"success",
			"warning",
			"danger",
			"info",
		] as const) {
			expect(
				slideElementStyle(
					{ ...element, type: "label", props: { tone } },
					"pixels",
					organization,
				).background,
			).toBe(slideTone(tone, organization).fill);
		}
	});
	it("keeps gradients, cover images, grid opacity and inset surfaces in the slide model", () => {
		const background = "linear-gradient(120deg, #123456 0%, #abcdef 100%)";
		const slide = OsPresentationCanvasSlideSchema.parse({
			id: "s",
			name: "Slide",
			background,
			backgroundImage: "https://example.org/cover.png",
			dotGridOpacity: 0.25,
			insetSurface: {},
		});
		expect(slide.background).toBe(background);
		const markup = slideBackgroundMarkup(slide, "pixels");
		expect(markup).toContain("object-fit:cover");
		expect(markup).toContain("opacity:0.25");
		expect(markup).toContain("inset:24px");
		expect(markup).toContain("border-radius:8px");
		expect(
			slideCss({
				background: "red;position:fixed",
				color: "url(https://example.org)",
			}),
		).toBe("");
	});
	it("positions an image inside its frame from the focal point", () => {
		const cover = slideElementMarkup(
			{
				...element,
				type: "image" as const,
				src: "https://example.org/photo.png",
				style: { fit: "cover" },
				props: { focalPoint: { x: 0.25, y: 0.75 } },
			},
			"pixels",
		);
		expect(cover).toContain("object-fit:cover");
		expect(cover).toContain("object-position:25% 75%");
		expect(
			slideElementMarkup(
				{ ...element, type: "image" as const, src: "https://x.org/a.png" },
				"pixels",
			),
		).not.toContain("object-position");
		// Values outside 0-1 still serialize inside the frame.
		expect(
			slideElementMarkup(
				{
					...element,
					type: "image" as const,
					src: "https://x.org/a.png",
					props: { focalPoint: { x: -0.5, y: 2 } },
				},
				"pixels",
			),
		).toContain("object-position:0% 100%");
	});
	it("renders the organization's logo or wordmark and refuses script image sources", () => {
		const logo = { ...element, type: "logo" as const };
		expect(slideElementMarkup(logo, "pixels", organization)).toBe(
			"Example Studio",
		);
		expect(
			slideElementMarkup(logo, "pixels", {
				...organization,
				logoUrl: "https://example.org/logo.png",
			}),
		).toContain('src="https://example.org/logo.png"');
		expect(
			slideElementMarkup(logo, "pixels", {
				...organization,
				logoUrl: "javascript:alert(1)",
			}),
		).toBe("Example Studio");
	});
	it("defaults shapes to rectangles while accepting ellipses and explicit radii", () => {
		const shape = OsPresentationElementSchema.parse({
			...element,
			type: "shape",
			props: {},
		});
		expect(shape.props?.kind).toBe("rectangle");
		expect(slideElementStyle(shape, "pixels").borderRadius).toBe("0px");
		expect(
			slideElementStyle({ ...shape, props: { kind: "ellipse" } }, "pixels")
				.borderRadius,
		).toBe("50%");
		expect(
			slideElementStyle({ ...shape, props: { radius: 12 } }, "pixels")
				.borderRadius,
		).toBe("12px");
	});
	it("moves and resizes explicit endpoints with the box and preserves inspector endpoint edits", () => {
		const arrow = {
			...element,
			type: "arrow" as const,
			props: { from: { x: 50, y: 70 }, to: { x: 200, y: 150 } },
		};
		const moved = slideElementGeometry(arrow, { ...arrow, x: 60, y: 90 });
		expect(moved.props).toMatchObject({
			from: { x: 70, y: 100 },
			to: { x: 220, y: 180 },
		});
		const resized = slideElementGeometry(arrow, {
			...arrow,
			width: 600,
			height: 320,
		});
		expect(resized.props).toMatchObject({
			from: { x: 60, y: 80 },
			to: { x: 360, y: 240 },
		});
		const edited = {
			...arrow,
			props: { ...arrow.props, from: { x: 100, y: 100 } },
		};
		expect(slideElementGeometry(arrow, edited)).toBe(edited);
	});
	it("retains every visual field through output revisions and optional outline canvas overrides", () => {
		const item = {
			...element,
			type: "card",
			props: {
				eyebrow: "E",
				title: "T",
				body: "B",
				tone: "success",
				highlight: ["T"],
				from: { x: 10, y: 20 },
				to: { x: 30, y: 40 },
				dashed: true,
				strokeWidth: 3,
				color: "#112233",
				label: "L",
				kind: "ellipse",
				radius: 7,
				compact: true,
			},
		};
		const outline = OsPresentationSlideOutlineSchema.parse({
			title: "T",
			canvas: {
				elements: [item],
				backgroundImage: "https://example.org/a.png",
			},
		});
		expect(outline.canvas).not.toHaveProperty("background");
		expect(
			OsPresentationSlideOutlineSchema.parse({
				title: "T",
				canvas: { background: "#333333" },
			}).canvas,
		).not.toHaveProperty("elements");
		const content = OsOutputContentSchema.parse({
			kind: "presentation",
			slides: [],
			deck: {
				activeSlideId: "s",
				slides: [{ id: "s", name: "S", ...outline.canvas }],
			},
		});
		expect(
			content.kind === "presentation" &&
				content.deck?.slides[0]?.elements[0]?.props,
		).toEqual(item.props);
	});
});
