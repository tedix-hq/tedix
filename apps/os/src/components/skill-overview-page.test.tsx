import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { skillDetailQueryOptions } from "@/lib/os-query-options";
import {
	SkillOverviewPage,
	SkillOverviewSummary,
	type SkillReliabilityRead,
} from "./skill-overview-page";
import { SkillBundleTree } from "./skill-bundle-tree";

vi.mock("@tanstack/react-router", () => ({
	useParams: () => ({ skillId: "skill-1" }),
	Link: ({ to, children }: { to: string; children?: React.ReactNode }) => (
		<a href={to}>{children}</a>
	),
}));

const read = (
	overrides: Partial<SkillReliabilityRead>,
): SkillReliabilityRead => ({
	isPending: false,
	isError: false,
	isFetching: false,
	error: null,
	refetch: () => Promise.resolve(),
	...overrides,
});

describe("Skill overview summary", () => {
	it("uses semantic evidence facts instead of dashboard cards", () => {
		const html = renderToStaticMarkup(
			<SkillOverviewSummary
				description="Verifies a customer export."
				tags={["verification", "exports"]}
				reliability={read({
					data: {
						runCount: 10,
						completedCount: 9,
						successRate: 0.9,
						averageDurationMs: 1200,
						warnings: ["Sample is partial."],
					},
				})}
				successCount={4}
				failureCount={1}
			/>,
		);

		expect(html).toContain('aria-label="Skill summary"');
		expect(html).toContain("Observed reliability");
		expect(html).toContain("90%");
		expect(html).toContain("Sample is partial.");
		expect(html).toContain("4 helpful · 1 unhelpful");
		expect(html).not.toContain('data-slot="card"');
	});

	it("states unavailable evidence in place instead of a raw error alert", () => {
		const html = renderToStaticMarkup(
			<SkillOverviewSummary
				description={null}
				tags={[]}
				reliability={read({
					isError: true,
					error: new Error("Not Found"),
				})}
				successCount={0}
				failureCount={0}
			/>,
		);
		expect(html).toContain("Unavailable");
		expect(html).toContain("Try again");
		expect(html).not.toContain("Not Found");
		expect(html).not.toContain("No runs yet");
	});

	it("marks a pending evidence read instead of claiming no executions", () => {
		const html = renderToStaticMarkup(
			<SkillOverviewSummary
				description={null}
				tags={[]}
				reliability={read({ isPending: true })}
				successCount={0}
				failureCount={0}
			/>,
		);
		expect(html).toContain("Reading…");
		expect(html).not.toContain("No runs yet");
		expect(html).not.toContain("Appears after observed execution.");
	});

	it("keeps cached evidence visible when a refresh fails", () => {
		const html = renderToStaticMarkup(
			<SkillOverviewSummary
				description={null}
				tags={[]}
				reliability={read({
					isError: true,
					error: new Error("socket hang up"),
					data: {
						runCount: 10,
						completedCount: 9,
						successRate: 0.9,
						averageDurationMs: null,
						warnings: [],
					},
				})}
				successCount={0}
				failureCount={0}
			/>,
		);
		expect(html).toContain("90%");
		expect(html).toContain("out of date");
		expect(html).toContain("Try again");
		expect(html).not.toContain("Unavailable");
	});

	it("says no runs only when a landed read proves it", () => {
		const html = renderToStaticMarkup(
			<SkillOverviewSummary
				description={null}
				tags={[]}
				reliability={read({
					data: {
						runCount: 0,
						completedCount: 0,
						successRate: null,
						averageDurationMs: null,
						warnings: [],
					},
				})}
				successCount={0}
				failureCount={0}
			/>,
		);
		expect(html).toContain("No runs yet");
		expect(html).toContain("Appears after observed execution.");
	});
});

describe("Skill overview bundle", () => {
	it("shows arbitrary supporting paths instead of only workflow source", () => {
		const html = renderToStaticMarkup(
			<SkillBundleTree
				content="# Instructions"
				files={{
					"references/policy.md": "Policy",
					"assets/example.txt": "Example",
				}}
			/>,
		);
		expect(html).toContain("references");
		expect(html).toContain("policy.md");
		expect(html).toContain("assets");
		expect(html).toContain("example.txt");
	});
});

/*
 * A skill id that does not resolve used to render a blank `main` — no heading,
 * no skeleton, no message — because the page did `if (!skill) return null`,
 * which collapsed "still loading" and "no such skill" into the same nothing.
 */
describe("SkillOverviewPage missing record", () => {
	const renderPage = (detail?: unknown) => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, enabled: false } },
		});
		if (detail !== undefined)
			client.setQueryData(
				skillDetailQueryOptions("skill-1").queryKey,
				detail as never,
			);
		return renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<SkillOverviewPage />
			</QueryClientProvider>,
		);
	};

	it("separates loading from not-found instead of rendering nothing", () => {
		const loading = renderPage();
		expect(loading).not.toBe("");
		expect(loading).not.toContain("Skill not found");

		const missing = renderPage({ entry: null });
		expect(missing).toContain("Skill not found");
		expect(missing).toContain("may have been");
	});
});
