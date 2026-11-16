import { describe, expect, it } from "vite-plus/test";
import type { OsPresentationCanvasSlide } from "@tedix/api-contract/schemas/os-workspaces";
import { pptxSlideParts } from "./presentation-parts";

const slide: OsPresentationCanvasSlide = {
	id: "one",
	name: "One",
	layout: "blank",
	background: "#ffffff",
	elements: [
		{
			id: "section",
			type: "sectionLabel",
			x: 36,
			y: 35,
			width: 240,
			height: 24,
			text: "Section",
			style: {},
		},
		{
			id: "card",
			type: "card",
			x: 100,
			y: 240,
			width: 280,
			height: 260,
			text: "Card",
			props: { topStripe: true },
			style: {},
		},
	],
};

describe("PowerPoint slide parts", () => {
	it("writes section labels in capitals, card stripes and the deck logo on top", () => {
		const parts = pptxSlideParts(slide, {}, undefined, {
			src: "https://example.com/logo.png",
			position: "bottom-right",
			showOnCover: false,
		});
		const section = parts.find((part) => part.id === "section")!;
		expect(section.type).toBe("text");
		expect(section.text).toBe("SECTION");
		expect(section.style.fontSize).toBe(10);
		const stripe = parts.find((part) => part.id === "card-stripe")!;
		expect(stripe).toMatchObject({ type: "shape", height: 4, y: 240 });
		const logo = parts.at(-1)!;
		expect(logo).toMatchObject({
			id: "deck-logo",
			type: "image",
			src: "https://example.com/logo.png",
			x: 1200 - 32 - 240,
			y: 675 - 28 - 36,
		});
	});
	it("leaves the logo out when the slide has none", () => {
		expect(
			pptxSlideParts(slide, {}).some((part) => part.id === "deck-logo"),
		).toBe(false);
	});
});
