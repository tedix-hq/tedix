export interface PagefindResultData {
	url: string;
	meta: { title?: string };
}

export interface PagefindResult {
	data(): Promise<PagefindResultData>;
}

export interface PagefindSearch {
	search(query: string): Promise<{ results: PagefindResult[] }>;
}

export interface SearchScorecardCase {
	task: string;
	query: string;
	expectedRoute: string;
}

export interface SearchScorecardResult extends SearchScorecardCase {
	rank: number | null;
	topRoutes: string[];
	topTitles: string[];
	passed: boolean;
}

export const DOCS_SEARCH_SCORECARD: readonly SearchScorecardCase[] = [
	{
		task: "first connection",
		query: "first connection",
		expectedRoute: "/learning-paths/first-connection/",
	},
	{
		task: "create or run a worker",
		query: "run a digital worker",
		expectedRoute: "/learning-paths/first-worker/",
	},
	{
		task: "locate a worker result",
		query: "find worker result",
		expectedRoute: "/learning-paths/first-worker/",
	},
	{
		task: "failed-run recovery",
		query: "failed run recovery",
		expectedRoute: "/troubleshooting/",
	},
	{
		task: "worker permissions",
		query: "worker permissions",
		expectedRoute: "/workers-and-governance/",
	},
	{
		task: "self-hosting",
		query: "self hosting",
		expectedRoute: "/self-hosted-boundary/",
	},
] as const;

function routeFromUrl(value: string): string {
	const pathname = new URL(value, "https://docs.invalid").pathname;
	if (pathname === "/") return pathname;
	return `${pathname.replace(/\/+$/, "")}/`;
}

export async function runSearchScorecard(
	pagefind: PagefindSearch,
	cases: readonly SearchScorecardCase[] = DOCS_SEARCH_SCORECARD,
	maxRank = 3,
): Promise<SearchScorecardResult[]> {
	return Promise.all(
		cases.map(async (entry) => {
			const response = await pagefind.search(entry.query);
			const data = await Promise.all(
				response.results.slice(0, maxRank).map((result) => result.data()),
			);
			const topRoutes = data.map((result) => routeFromUrl(result.url));
			const position = topRoutes.indexOf(entry.expectedRoute);
			return {
				...entry,
				rank: position < 0 ? null : position + 1,
				topRoutes,
				topTitles: data.map((result) => result.meta.title ?? "Untitled"),
				passed: position >= 0,
			};
		}),
	);
}
