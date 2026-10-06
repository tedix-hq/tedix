import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { skillDetailQueryOptions } from "@/lib/os-query-options";
import { SkillOverviewPage, SkillOverviewSummary } from "./skill-overview-page";
import { SkillBundleTree } from "./skill-bundle-tree";

vi.mock("@tanstack/react-router", () => ({
	useParams: () => ({ skillId: "skill-1" }),
	Link: ({ to, children }: { to: string; children?: React.ReactNode }) => (
		<a href={to}>{children}</a>
	),
}));

describe("Skill overview summary", () => {
	it("uses semantic evidence facts instead of dashboard cards", () => {
		const html = renderToStaticMarkup(
			<SkillOverviewSummary
				description="Verifies a customer export."
				tags={["verification", "exports"]}
				runEvidence={{
					runCount: 10,
					completedCount: 9,
					successRate: 0.9,
					averageDurationMs: 1200,
					warnings: [],
				}}
				reliabilityError={null}
				successCount={4}
				failureCount={1}
			/>,
		);

		expect(html).toContain('aria-label="Skill summary"');
		expect(html).toContain("Observed reliability");
		expect(html).toContain("90%");
		expect(html).toContain("4 helpful · 1 unhelpful");
		expect(html).not.toContain('data-slot="card"');
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
		expect(loading).not.toContain("Skill unavailable");

		const missing = renderPage({ entry: null });
		expect(missing).toContain("Skill unavailable");
		expect(missing).toContain("may have been removed");
	});
});
