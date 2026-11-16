import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { skillDetailQueryOptions } from "@/lib/os-query-options";
import { SkillOverviewPage } from "./skill-overview-page";
import { SkillBundleTree } from "./skill-bundle-tree";

vi.mock("@tanstack/react-router", () => ({
	useParams: () => ({ skillId: "skill-1" }),
	Link: ({ to, children }: { to: string; children?: React.ReactNode }) => (
		<a href={to}>{children}</a>
	),
}));

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

describe("SkillOverviewPage content", () => {
	it("leads with run metrics and recent runs, not workflow anatomy", () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, enabled: false } },
		});
		client.setQueryData(skillDetailQueryOptions("skill-1").queryKey, {
			entry: {
				id: "skill-1",
				organizationId: "example",
				title: "Weekly digest",
				content: "# Weekly digest",
				files: {
					"scripts/workflow.ts":
						"export default async (env) => { await step.do('read', () => env.MCP.os.get_os_output({})); }",
				},
				successCount: 4,
				failureCount: 1,
				revision: 2,
				visibility: "org",
				paceLayer: "record",
			},
		} as never);
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<SkillOverviewPage />
			</QueryClientProvider>,
		);
		expect(html).toContain("How it is doing");
		expect(html).toContain("Recent runs");
		expect(html).toContain("What it uses and produces");
		expect(html).toContain("Feedback");
		expect(html).toContain("4 found it helpful · 1 found it unhelpful");
		expect(html).not.toContain("Workflow anatomy");
		expect(html).not.toContain("Observed reliability");
	});
});
