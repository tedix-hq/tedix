import { describe, expect, it } from "vite-plus/test";
import {
	DOCS_SEARCH_SCORECARD,
	runSearchScorecard,
	type PagefindResultData,
} from "./search-scorecard";

function pagefind(routes: string[]) {
	return {
		async search() {
			return {
				results: routes.map((route) => ({
					async data(): Promise<PagefindResultData> {
						return {
							url: `http://127.0.0.1:4321${route}`,
							meta: { title: route },
						};
					},
				})),
			};
		},
	};
}

describe("documentation search scorecard", () => {
	it("covers the six supported reader tasks", () => {
		expect(DOCS_SEARCH_SCORECARD.map((entry) => entry.task)).toEqual([
			"first connection",
			"create or run a worker",
			"locate a worker result",
			"failed-run recovery",
			"worker permissions",
			"self-hosting",
		]);
	});

	it("accepts an intended task page in the top three", async () => {
		const [result] = await runSearchScorecard(
			pagefind(["/one/", "/target/", "/three/"]),
			[
				{
					task: "example",
					query: "example query",
					expectedRoute: "/target/",
				},
			],
		);
		expect(result).toMatchObject({ passed: true, rank: 2 });
	});

	it("fails when the intended task page is below the scorecard window", async () => {
		const [result] = await runSearchScorecard(
			pagefind(["/one/", "/two/", "/three/", "/target/"]),
			[
				{
					task: "example",
					query: "example query",
					expectedRoute: "/target/",
				},
			],
		);
		expect(result).toMatchObject({ passed: false, rank: null });
		expect(result?.topRoutes).toEqual(["/one/", "/two/", "/three/"]);
	});
});
