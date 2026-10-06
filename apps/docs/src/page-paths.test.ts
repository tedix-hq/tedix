import { describe, expect, it } from "vite-plus/test";
import { filterEntryAliasStaticPaths } from "../template/page-paths";

describe("Docs HTML entry paths", () => {
	const paths = [
		{ params: {}, props: { id: "root-undefined" } },
		{ params: { slug: "" }, props: { id: "root-empty" } },
		{ params: { slug: [] }, props: { id: "root-empty-array" } },
		{ params: { slug: "index" }, props: { id: "index" } },
		{ params: { slug: "README" }, props: { id: "README" } },
		{ params: { slug: "guide" }, props: { id: "guide" } },
	];

	it.each([
		["/index" as const, ["README", "guide"]],
		["/readme" as const, ["index", "guide"]],
	])(
		"omits the root shapes and selected %s HTML alias",
		(entryPath, expected) => {
			expect(
				filterEntryAliasStaticPaths(paths, entryPath).map(
					(path) => path.params.slug,
				),
			).toEqual(expected);
		},
	);
});
