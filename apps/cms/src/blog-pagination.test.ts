import { describe, expect, it } from "vite-plus/test";
import {
	blogPageHref,
	blogPagination,
} from "../templates/tedix/src/lib/blog-pagination";

describe("native postsPerPage boundaries", () => {
	it("produces complete non-overlapping first, middle and last slices", () => {
		const entries = Array.from({ length: 7 }, (_, id) => id);
		const slices = [1, 2, 3].map((page) => {
			const bounds = blogPagination(page, 3);
			return entries.slice(bounds.offset, bounds.offset + bounds.pageSize);
		});
		expect(slices).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
	});
	it("fetches the search sentinel beyond the visible page", () => {
		const page = blogPagination(2, 2);
		expect(page).toEqual({ page: 2, pageSize: 2, offset: 2, searchLimit: 5 });
	});
	it("rejects unsafe pages and invalid settings without corrupting offsets", () => {
		for (const requested of [
			-1,
			0,
			1.5,
			NaN,
			Infinity,
			Number.MAX_SAFE_INTEGER,
		])
			expect(blogPagination(requested, 12).page).toBe(1);
		for (const setting of [0, 101, 1.5, "3", undefined])
			expect(blogPagination(1, setting).pageSize).toBe(12);
		expect(blogPagination(1, 100).pageSize).toBe(100);
	});
	it("preserves locale paths and search queries when navigating and returning from an empty page", () => {
		const index = "https://personal.example/de/blog/?view=grid";
		const next = blogPageHref(index, 2, "German & zu");
		expect(new URL(next).pathname).toBe("/de/blog/");
		expect(new URL(next).searchParams.get("q")).toBe("German & zu");
		expect(new URL(next).searchParams.get("page")).toBe("2");
		const first = new URL(blogPageHref(next, 1, "German & zu"));
		expect(first.searchParams.has("page")).toBe(false);
		expect(first.searchParams.get("q")).toBe("German & zu");
		expect(first.searchParams.get("view")).toBe("grid");
		expect(new URL(blogPageHref(next, 1)).searchParams.has("q")).toBe(false);
	});
});
