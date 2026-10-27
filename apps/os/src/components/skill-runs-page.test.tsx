import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SkillRunSummary } from "@tedix/api-contract/contracts/cognitive";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { skillRunsQueryOptions } from "@/lib/os-query-options";
import { SkillRunsPage } from "./skill-runs-page";

vi.mock("@tanstack/react-router", () => ({
	useParams: () => ({ skillId: "example-skill" }),
}));
vi.mock("@/components/activity-runs", () => ({
	RunStatusChip: ({ status }: { status: string }) => <span>{status}</span>,
}));
const read = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
	osApi: { skills: { runWorkflowHistory: read } },
}));
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups.splice(0).forEach((cleanup) => cleanup());
	read.mockReset();
});
async function mount(rows?: SkillRunSummary[], status?: "failed") {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	const options = skillRunsQueryOptions("example-skill", status);
	if (rows) client.setQueryData(options.queryKey, { runs: rows });
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	const updateSearch = vi.fn();
	cleanups.push(() => {
		act(() => root.unmount());
		client.clear();
		node.remove();
	});
	const render = async (next?: "failed") => {
		await act(async () => {
			root.render(
				<QueryClientProvider client={client}>
					<SkillRunsPage
						search={{ status: next }}
						updateSearch={updateSearch}
					/>
				</QueryClientProvider>,
			);
		});
		await act(async () => {
			await new Promise((done) => setTimeout(done, 20));
		});
	};
	await render(status);
	return { node, client, options, updateSearch, render };
}
const run: SkillRunSummary = {
	organizationId: "example-org",
	skillId: "example-skill",
	tediId: "example-worker",
	workflowInstanceId: "example-workflow",
	runtimeEnvironment: "development",
	lastReconciledAt: null,
	executionEpoch: 0,
	hasResult: true,
	hasError: false,
	id: "example-run",
	status: "completed",
	skillRevision: 3,
	startedAt: "2026-10-21T12:00:00Z",
	completedAt: "2026-10-21T12:00:02Z",
};
describe("skill run history", () => {
	it("shows loading without claiming the list is empty", async () => {
		read.mockReturnValueOnce(new Promise(() => {}));
		const { node } = await mount();
		expect(node.querySelector('[data-slot="skeleton"]')).not.toBeNull();
		expect(node.querySelector('[data-slot="empty"]')).toBeNull();
	});
	it("shows loaded runs with status, revision, duration and the canonical destination", async () => {
		const { node } = await mount([run]);
		expect(node.textContent).toContain("completed");
		expect(node.textContent).toMatch(/Revision 3/i);
		expect(node.textContent).toContain("2s");
		expect(node.querySelector("time")?.dateTime).toBe("2026-10-21T12:00:00Z");
		expect(node.querySelector("time")?.title).toContain("2026");
		expect(
			node.querySelector('a[href="/work/runs/example-run"]'),
		).not.toBeNull();
	});
	it.each([undefined, "failed" as const])(
		"distinguishes empty history from a filter with no matches (%s)",
		async (status) => {
			const { node } = await mount([], status);
			expect(node.textContent).toContain("No runs to show");
			expect(node.textContent).toContain(
				status ? "No runs match this status." : "This skill has not run yet.",
			);
		},
	);
	it("shows an error instead of empty history and retries the read", async () => {
		read.mockRejectedValueOnce(new Error("History read failed"));
		const { node } = await mount();
		expect(node.textContent).toContain("Runs unavailable");
		expect(node.textContent).toContain("History read failed");
		expect(node.textContent).not.toContain("No runs to show");
		read.mockResolvedValueOnce({ runs: [run] });
		await act(async () =>
			node
				.querySelector<HTMLButtonElement>("button:not([aria-pressed])")!
				.click(),
		);
		await act(async () => {
			await new Promise((done) => setTimeout(done, 20));
		});
		expect(
			node.querySelector('a[href="/work/runs/example-run"]'),
		).not.toBeNull();
		expect(node.querySelector('[role="alert"]')).toBeNull();
	});
	it("keeps cached runs visible if a refresh fails", async () => {
		const { node, client, options } = await mount([run]);
		read.mockRejectedValueOnce(new Error("Refresh failed"));
		await act(async () => {
			await client.refetchQueries(options);
			await new Promise((done) => setTimeout(done, 20));
		});
		expect(node.textContent).toContain("Runs could not refresh");
		expect(node.textContent).toContain("they may be out of date");
		expect(node.textContent).toContain("Refresh failed");
		expect(
			node.querySelector('a[href="/work/runs/example-run"]'),
		).not.toBeNull();
	});
	it("never shows another status's runs while the new filter loads", async () => {
		const { node, render } = await mount([run]);
		read.mockReturnValueOnce(new Promise(() => {}));
		await render("failed");
		expect(node.querySelector('a[href="/work/runs/example-run"]')).toBeNull();
		expect(node.querySelector('[data-slot="skeleton"]')).not.toBeNull();
		expect(node.querySelector('[data-slot="empty"]')).toBeNull();
	});
	it("preserves the status search callback", async () => {
		const { node, updateSearch } = await mount([]);
		const failed = [...node.querySelectorAll("button")].find(
			(button) => button.textContent === "Failed",
		)!;
		await act(async () => failed.click());
		expect(updateSearch).toHaveBeenCalledWith({ status: "failed" });
	});
});
