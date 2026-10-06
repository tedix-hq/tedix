/// <reference types="node" />
import { describe, expect, it } from "vite-plus/test";
import { validateDocsProvenance } from "../template/src/lib/docs-provenance";

const SHA = "a".repeat(40);
const PAGE_SHA = "b".repeat(40);
const UPDATED_AT = "2026-09-28T13:14:15+02:00";

function manifest(pages: Record<string, unknown>) {
	return { version: 1, sourceRevision: SHA, pages };
}

function page(overrides: Record<string, unknown> = {}) {
	return { commit: PAGE_SHA, updatedAt: UPDATED_AT, ...overrides };
}

describe("Docs provenance validation", () => {
	it("accepts complete Markdown coverage and preserves declared timestamps", () => {
		const result = validateDocsProvenance(
			manifest({
				"index.md": page(),
				"guides/setup.mdx": page({
					updatedAt: "2026-09-29T11:12:13.456Z",
				}),
				// Export manifests may retain capability manifests that the Docs
				// staging boundary deliberately excludes from visible pages.
				"skills/SKILL.md": page(),
			}),
			["guides/setup.mdx", "index.md"],
		);

		expect(result?.sourceRevision).toBe(SHA);
		expect(result?.pages.get("index.md")?.updatedAt).toBe(UPDATED_AT);
		expect(result?.pages.get("guides/setup.mdx")?.updatedAt).toBe(
			"2026-09-29T11:12:13.456Z",
		);
	});

	it("omits the entire fallback when current page coverage is incomplete", () => {
		expect(
			validateDocsProvenance(manifest({ "index.md": page() }), [
				"index.md",
				"new-page.md",
			]),
		).toBeUndefined();
	});

	it.each([
		{ version: 2, sourceRevision: SHA, pages: {} },
		{ version: 1, sourceRevision: "not-a-commit", pages: {} },
		manifest({ "../outside.md": page() }),
		manifest({ "index.md": page({ commit: "short" }) }),
		manifest({ "index.md": page({ updatedAt: "yesterday" }) }),
		manifest({
			"index.md": page({ updatedAt: "2026-02-30T10:00:00Z" }),
		}),
	])("omits malformed or unsafe provenance", (value) => {
		expect(validateDocsProvenance(value, [])).toBeUndefined();
	});
});
