import { describe, expect, it } from "vite-plus/test";
import { firstLink, sourceParts } from "./card-review";

describe("firstLink", () => {
	it("returns the first link without trailing punctuation", () => {
		expect(firstLink("Ada Example · Hello · https://example.com/a.")).toBe(
			"https://example.com/a",
		);
		expect(firstLink("see http://a.test/x, then https://b.test/y")).toBe(
			"http://a.test/x",
		);
		expect(firstLink("no link")).toBeNull();
		expect(firstLink("http://")).toBeNull();
	});
});

describe("sourceParts", () => {
	it("splits a source cell into readable text and its links", () => {
		expect(
			sourceParts(
				"Ada Example · 'Hello' + 'Again' · https://example.com/a; https://example.com/b.",
			),
		).toEqual({
			label: "Ada Example · 'Hello' + 'Again'",
			links: ["https://example.com/a", "https://example.com/b"],
		});
		expect(sourceParts("plain")).toEqual({ label: "plain", links: [] });
	});

	it("keeps at most three de-duplicated links", () => {
		expect(
			sourceParts(
				"https://a.test/1 https://a.test/1 https://b.test/2 https://c.test/3 https://d.test/4",
			).links,
		).toEqual(["https://a.test/1", "https://b.test/2", "https://c.test/3"]);
	});

	it("removes links from the label text", () => {
		expect(sourceParts("Title (https://x.test/p)")).toEqual({
			label: "Title",
			links: ["https://x.test/p"],
		});
	});

	it("handles a 50k-character link cell in linear time", () => {
		const cell = `http://${"a".repeat(50_000)}.`;
		const started = performance.now();
		const link = firstLink(cell);
		const parts = sourceParts(cell);
		expect(performance.now() - started).toBeLessThan(50);
		expect(link?.length).toBeLessThanOrEqual(2_048);
		expect(parts.links).toEqual([link]);
		expect(parts.label).toBe("");
	});
});
