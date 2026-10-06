/// <reference types="node" />
import { describe, expect, it, vi } from "vite-plus/test";
import {
	articleModifiedTime,
	createLastUpdatedSitemapSerializer,
	hasNoindexRobotsMeta,
} from "../template/src/lib/sitemap-last-updated";

describe("Docs sitemap last-modified metadata", () => {
	it("reads Nimbus article metadata regardless of attribute order", () => {
		expect(
			articleModifiedTime(
				'<html><head><meta content="2026-09-28T11:14:15.000Z" property="article:modified_time"></head></html>',
			),
		).toBe("2026-09-28T11:14:15.000Z");
	});

	it("recognizes Nimbus noindex metadata regardless of case or separators", () => {
		expect(
			hasNoindexRobotsMeta('<meta content="NOINDEX, nofollow" name="ROBOTS">'),
		).toBe(true);
		expect(
			hasNoindexRobotsMeta('<meta name="robots" content="index, follow">'),
		).toBe(false);
	});

	it("drops a rendered noindex page from the sitemap", async () => {
		const serialize = createLastUpdatedSitemapSerializer({
			outputDir: "/tmp/docs-output",
			read: async () =>
				'<meta name="robots" content="noindex"><meta property="article:modified_time" content="2026-09-28T11:14:15.000Z">',
		});

		await expect(
			serialize({ url: "https://docs.example/private/" }),
		).resolves.toBeUndefined();
	});

	it("copies rendered page time while preserving other sitemap fields", async () => {
		const read = vi.fn(async () =>
			Promise.resolve(
				'<meta property="article:modified_time" content="2026-09-28T11:14:15.000Z">',
			),
		);
		const serialize = createLastUpdatedSitemapSerializer({
			outputDir: "/tmp/docs-output",
			read,
		});

		await expect(
			serialize({
				url: "https://docs.example/guides/setup/",
				priority: 0.8,
			}),
		).resolves.toEqual({
			url: "https://docs.example/guides/setup/",
			priority: 0.8,
			lastmod: "2026-09-28T11:14:15.000Z",
		});
		expect(read).toHaveBeenCalledWith(
			"/tmp/docs-output/guides/setup/index.html",
		);
	});

	it("uses trusted provenance for a homepage that Nimbus marks as WebSite", async () => {
		const serialize = createLastUpdatedSitemapSerializer({
			outputDir: "/tmp/docs-output",
			read: async () => "<html><head></head></html>",
			lookup: async () => "2026-09-20T10:11:12.000Z",
		});
		await expect(serialize({ url: "https://docs.example/" })).resolves.toEqual({
			url: "https://docs.example/",
			lastmod: "2026-09-20T10:11:12.000Z",
		});
	});

	it.each([
		'<meta property="description" content="No date">',
		'<meta property="article:modified_time" content="not-a-date">',
	])("leaves unknown page history absent", async (html) => {
		const item = {
			url: "https://docs.example/",
			changefreq: "weekly" as const,
		};
		const serialize = createLastUpdatedSitemapSerializer({
			outputDir: "/tmp/docs-output",
			read: async () => html,
		});
		expect(await serialize(item)).toBe(item);
	});

	it("omits dates on unreadable or unsafe routes", async () => {
		const item = { url: "https://docs.example/%2e%2e/private" };
		const read = vi.fn(async () => {
			throw new Error("missing");
		});
		const serialize = createLastUpdatedSitemapSerializer({
			outputDir: "/tmp/docs-output",
			read,
			lookup: async () => undefined,
		});
		expect(await serialize(item)).toBe(item);
		expect(read).not.toHaveBeenCalled();

		const safeItem = { url: "https://docs.example/missing/" };
		expect(await serialize(safeItem)).toBe(safeItem);
	});
});
