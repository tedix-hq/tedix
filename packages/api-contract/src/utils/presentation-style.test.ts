import { describe, expect, it } from "vite-plus/test";
import { OsPresentationElementSchema } from "../schemas/os-workspaces";
import {
	parseSlideText,
	slideArrowPath,
	slideBackgroundMarkup,
	slideCss,
	slideDeckLogo,
	slideElementStyle,
	slideElementMarkup,
	escapeSlideHtml,
} from "./presentation-style";

const element = OsPresentationElementSchema.parse({
	id: "text",
	type: "text",
	x: 40,
	y: 80,
	width: 500,
	height: 120,
});

describe("slide styles", () => {
	it("escapes all HTML delimiters and unvalidated arrow attributes", () => {
		const injection = "\"><script>alert(1)</script>&'";
		expect(escapeSlideHtml(injection)).toBe(
			"&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&#39;",
		);
		// Public rendering helpers can receive objects before schema validation.
		const markup = slideElementMarkup({
			...element,
			type: "arrow",
			width: injection as unknown as number,
			height: injection as unknown as number,
			props: { strokeWidth: injection as unknown as number, label: injection },
		});
		expect(markup).not.toContain("<script>");
		expect(markup).not.toContain(injection);
		expect(markup).toContain(`stroke-width="${escapeSlideHtml(injection)}"`);
		expect(markup).toContain(
			`viewBox="0 0 ${escapeSlideHtml(injection)} ${escapeSlideHtml(injection)}"`,
		);
	});
	it("preserves defaults and maps overrides at both canvas and export scale", () => {
		expect(slideElementStyle(element)).toMatchObject({
			fontFamily: "Arial, sans-serif",
			fontWeight: "normal",
			lineHeight: 1.3,
			letterSpacing: "normal",
			borderStyle: undefined,
		});
		const styled = OsPresentationElementSchema.parse({
			...element,
			style: {
				fontWeight: "light",
				lineHeight: 2.5,
				letterSpacing: -1.2,
				padding: 24,
				verticalAlign: "middle",
				borderWidth: 2,
				borderStyle: "dashed",
			},
		});
		expect(slideElementStyle(styled)).toMatchObject({
			fontWeight: 300,
			lineHeight: 2.5,
			letterSpacing: "calc(-1.2 * 100cqw / 1200)",
			padding: "calc(24 * 100cqw / 1200)",
			display: "flex",
			justifyContent: "center",
			borderStyle: "dashed",
		});
		expect(slideElementStyle(styled, "pixels")).toMatchObject({
			fontWeight: 300,
			lineHeight: 2.5,
			letterSpacing: "-1.2px",
			padding: "24px",
			borderWidth: "2px",
			borderStyle: "dashed",
		});
		expect(
			slideElementStyle({
				...element,
				style: { letterSpacing: 0, borderWidth: 1 },
			}),
		).toMatchObject({
			letterSpacing: "calc(0 * 100cqw / 1200)",
			borderStyle: "solid",
		});
		expect(
			slideElementStyle({
				...element,
				style: { borderWidth: 1, borderStyle: "dotted" },
			}).borderStyle,
		).toBe("dotted");
	});

	it("accepts hairline elements and aligns padded text at either edge", () => {
		expect(
			OsPresentationElementSchema.parse({
				...element,
				type: "divider",
				height: 1,
			}),
		).toMatchObject({ height: 1 });
		expect(
			slideElementStyle(
				{
					...element,
					style: { padding: 12, verticalAlign: "bottom" },
				},
				"pixels",
			),
		).toMatchObject({ padding: "12px", justifyContent: "flex-end" });
	});

	it("parses multiple bold spans and preserves line breaks and literal unmatched markers", () => {
		expect(parseSlideText("A **bold** and **second\nline**! **open")).toEqual([
			{ text: "A ", bold: false },
			{ text: "bold", bold: true },
			{ text: " and ", bold: false },
			{ text: "second\nline", bold: true },
			{ text: "! **open", bold: false },
		]);
		expect(parseSlideText("****")).toEqual([{ text: "****", bold: false }]);
		expect(parseSlideText("")).toEqual([]);
	});

	it("draws a horizontal shaft and arrowhead inside the box", () => {
		expect(slideArrowPath({ ...element, width: 200, height: 40 })).toBe(
			"M 2 20 H 198 M 180 2 L 198 20 L 180 38",
		);
	});

	it("keeps canvas-scaled lengths in serialized markup", () => {
		expect(slideCss({ fontSize: "calc(19 * 100cqw / 1200)" })).toBe(
			"font-size:calc(19 * 100cqw / 1200)",
		);
		expect(slideCss({ background: "url(https://x.test/a.png)" })).toBe("");
		const markup = slideBackgroundMarkup({
			id: "s",
			name: "S",
			layout: "blank",
			background: "#ffffff",
			elements: [],
			dotGridOpacity: 0.5,
			insetSurface: { color: "#ffffff", inset: 24, radius: 8 },
		});
		expect(markup).toContain("inset:calc(24 * 100cqw / 1200)");
		expect(markup).toContain("background-size:calc(20 * 100cqw / 1200)");
	});
	it("lets elements bleed past the slide and rejects them further out", () => {
		const bleed = { ...element, x: -100, y: 760 };
		expect(OsPresentationElementSchema.parse(bleed).x).toBe(-100);
		expect(() =>
			OsPresentationElementSchema.parse({ ...element, x: -101 }),
		).toThrow();
		expect(slideElementStyle(bleed, "pixels").left).toBe("-100px");
	});
	it("draws auto-height text at its content's height", () => {
		const auto = { ...element, props: { autoHeight: true } };
		expect(slideElementStyle(auto).height).toBe("auto");
		expect(slideElementStyle(element).height).not.toBe("auto");
	});
	it("styles section labels, tone pills and a card's top stripe", () => {
		const section = slideElementStyle(
			OsPresentationElementSchema.parse({ ...element, type: "sectionLabel" }),
		);
		expect(section.textTransform).toBe("uppercase");
		expect(section.fontWeight).toBe(600);
		const pill = slideElementStyle(
			OsPresentationElementSchema.parse({ ...element, type: "tonePill" }),
		);
		expect(pill.borderRadius).toContain("600");
		const card = slideElementStyle(
			OsPresentationElementSchema.parse({
				...element,
				type: "card",
				props: { topStripe: true },
			}),
		);
		expect(card.boxShadow).toContain("inset");
	});
	it("puts the deck logo on every slide but the first unless asked", () => {
		const logo = {
			src: "https://example.com/logo.png",
			position: "bottom-left" as const,
			showOnCover: false,
		};
		expect(slideDeckLogo({ logo }, 0)).toBeUndefined();
		expect(slideDeckLogo({ logo }, 1)).toBe(logo);
		expect(
			slideDeckLogo({ logo: { ...logo, showOnCover: true } }, 0),
		).toBeDefined();
		const markup = slideBackgroundMarkup(
			{ id: "s", name: "S", layout: "blank", background: "#fff", elements: [] },
			"pixels",
			{},
			logo,
		);
		expect(markup).toContain("data-slide-logo");
		expect(markup).toContain("bottom:28px");
		expect(markup).toContain("left:32px");
	});
});
