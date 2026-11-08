import { describe, expect, it } from "vite-plus/test";
import type { OsOutputContent } from "../schemas/os-workspaces";
import { applyPresentationPatch } from "./presentation-patch";

type Presentation = Extract<OsOutputContent, { kind: "presentation" }>;

describe("canonical presentation patches", () => {
	it("edits semantic text without replacing canvas artwork, identity or typography", () => {
		const base = applyPresentationPatch({ kind: "presentation", slides: [] }, [
			{
				op: "insert",
				index: 0,
				slide: { title: "Before", bullets: ["One"], notes: "Before notes" },
			},
		]);
		base.deck!.theme = {
			headingFont: "Example Serif",
			bodyFont: "Example Sans",
		};
		const slide = base.deck!.slides[0]!;
		slide.background = "#123456";
		slide.elements[0]!.x = 80;
		slide.elements[0]!.style = { fontSize: 52, color: "#ffffff" };
		const decoration = {
			id: "decoration",
			type: "text" as const,
			x: 20,
			y: 620,
			width: 300,
			height: 30,
			text: "Confidential",
			style: {},
		};
		slide.elements.push(decoration);
		const next = applyPresentationPatch(base, [
			{
				op: "replace",
				index: 0,
				slide: {
					title: "After",
					bullets: ["Two", "Three"],
					notes: "After notes",
				},
			},
		]);
		expect(next.deck?.slides[0]).toMatchObject({
			id: slide.id,
			background: "#123456",
			notes: "After notes",
		});
		expect(next.deck?.slides[0]?.elements[0]).toMatchObject({
			id: slide.elements[0]!.id,
			text: "After",
			x: 80,
			style: { fontSize: 52, color: "#ffffff" },
		});
		expect(next.deck?.slides[0]?.elements).toContainEqual(decoration);
		expect(next.deck?.theme).toEqual(base.deck?.theme);
		expect(next.slides).toEqual([
			{ title: "After", bullets: ["Two", "Three"], notes: "After notes" },
		]);
		expect(base.slides[0]?.title).toBe("Before");
	});

	it("applies ordered insert, move and delete operations and keeps active identity valid", () => {
		const base: Presentation = {
			kind: "presentation",
			slides: [
				{ title: "One", bullets: [] },
				{ title: "Two", bullets: ["Second"] },
			],
		};
		const next = applyPresentationPatch(base, [
			{ op: "move", from: 1, to: 0 },
			{ op: "insert", index: 1, slide: { title: "Inserted", bullets: [] } },
			{ op: "delete", index: 2 },
		]);
		expect(next.slides.map((slide) => slide.title)).toEqual([
			"Two",
			"Inserted",
		]);
		expect(
			next.deck?.slides.some((slide) => slide.id === next.deck?.activeSlideId),
		).toBe(true);
		expect(base.slides.map((slide) => slide.title)).toEqual(["One", "Two"]);
	});

	it("rejects out-of-range and invalid operations before returning a changed body", () => {
		const base: Presentation = {
			kind: "presentation",
			slides: [{ title: "One", bullets: [] }],
		};
		expect(() =>
			applyPresentationPatch(base, [{ op: "delete", index: 2 }]),
		).toThrow("out of range");
		expect(() =>
			applyPresentationPatch(base, [{ op: "move", from: 0, to: 1 }]),
		).toThrow("out of range");
		expect(() =>
			applyPresentationPatch(base, [
				{ op: "replace", index: -1, slide: { title: "No" } },
			]),
		).toThrow();
		expect(base.slides).toEqual([{ title: "One", bullets: [] }]);
	});
});
