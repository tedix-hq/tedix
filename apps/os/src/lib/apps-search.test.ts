import { describe, expect, it } from "vite-plus/test";
import { validateAppsSearch } from "./apps-search";

const validate = (search: Parameters<typeof validateAppsSearch>[0]) =>
	validateAppsSearch(search);

describe("validateAppsSearch", () => {
	it("defaults an absent query and preserves a bounded query", () => {
		expect(validate({} as Parameters<typeof validate>[0])).toEqual({ q: "" });
		expect(
			validate({ q: "cloudflare" } as Parameters<typeof validate>[0]),
		).toEqual({
			q: "cloudflare",
		});
	});

	it("rejects oversized route state back to the safe default", () => {
		expect(
			validate({ q: "x".repeat(121) } as Parameters<typeof validate>[0]),
		).toEqual({ q: "" });
	});
});
