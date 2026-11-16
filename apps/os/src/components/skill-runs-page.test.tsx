import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SkillRunSummary } from "@tedix/api-contract/contracts/cognitive";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { skillRunsQueryOptions } from "@/lib/os-query-options";
import {
	SKILL_RUN_PAGE_SIZE,
	type SkillRunsSearch,
} from "@/lib/skill-runs-search";
import { SkillRunsPage } from "./skill-runs-page";

vi.mock("@tanstack/react-router", () => ({
	useParams: () => ({ skillId: "example-skill" }),
}));
vi.mock("@/components/activity-runs", () => ({
	RunStatusChip: ({ status }: { status: string }) => <span>{status}</span>,
}));
const read = vi.hoisted(() => vi.fn());
const cancel = vi.hoisted(() => vi.fn());
const canManage = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/api", () => ({
	osApi: { skills: { runWorkflowHistory: read, runWorkflowCancel: cancel } },
}));
vi.mock("@/lib/tedi-permissions", () => ({
	useCanManageTedis: () => canManage.value,
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
		const retry = [...node.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Retry",
		)!;
		await act(async () => retry.click());
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

async function mountLog(
	search: SkillRunsSearch,
	rows: SkillRunSummary[] | Promise<never> = [],
) {
	if (rows instanceof Promise) read.mockReturnValue(rows);
	else read.mockResolvedValue({ runs: rows });
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	const updateSearch = vi.fn();
	cleanups.push(() => {
		act(() => root.unmount());
		client.clear();
		node.remove();
	});
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<SkillRunsPage search={search} updateSearch={updateSearch} />
			</QueryClientProvider>,
		);
	});
	await act(async () => {
		await new Promise((done) => setTimeout(done, 20));
	});
	// This mount's own buttons first; a dialog renders outside it.
	const button = (name: string) =>
		[
			...node.querySelectorAll("button"),
			...document.querySelectorAll("button"),
		].find((item) => item.textContent?.trim() === name);
	const row = (id: string) => node.querySelector(`[data-run-id="${id}"]`);
	return { node, updateSearch, button, row };
}
const hoursAgo = (hours: number) =>
	new Date(Date.now() - hours * 3_600_000).toISOString();

describe("skill run log", () => {
	afterEach(() => {
		canManage.value = true;
		cancel.mockReset();
	});

	it("says on each row what started the run and what came of it", async () => {
		const { row } = await mountLog({}, [
			{
				...run,
				id: "ok",
				trigger: "scheduled",
				resultSummary: "31 threads queued for browser check",
			},
			{
				...run,
				id: "bad",
				status: "failed",
				trigger: "manual",
				hasError: true,
				errorPreview: "Error: Tool mail.send was denied\n    at step 4",
			},
			{ ...run, id: "tested", trigger: "test" },
			{ ...run, id: "tedi", trigger: "agent", outcome: "no_action" },
			{ ...run, id: "legacy" },
		]);
		expect(row("ok")?.textContent).toContain("Scheduled");
		expect(row("ok")?.textContent).toContain(
			"31 threads queued for browser check",
		);
		expect(row("bad")?.textContent).toContain("Manual");
		expect(row("bad")?.textContent).toContain("Tool mail.send was denied");
		expect(row("bad")?.textContent).not.toContain("at step 4");
		expect(row("tested")?.textContent).toContain("Test passed");
		expect(row("tedi")?.textContent).toContain("Agent or app");
		expect(row("tedi")?.textContent).toContain("Nothing to do");
		expect(row("legacy")?.textContent).toContain("Not recorded");
		expect(
			row("bad")?.querySelector('a[href="/work/runs/bad"]'),
		).not.toBeNull();
	});

	it("reads the list with the starter, revision, time and page filters", async () => {
		const before = Date.now();
		await mountLog({
			status: "failed",
			trigger: "scheduled",
			revision: 4,
			range: "week",
			page: 2,
		});
		const input = read.mock.calls.at(-1)?.[0] as {
			startedAfter: string;
		} & Record<string, unknown>;
		expect(input).toMatchObject({
			skillId: "example-skill",
			status: "failed",
			trigger: "scheduled",
			skillRevision: 4,
			offset: SKILL_RUN_PAGE_SIZE,
			limit: SKILL_RUN_PAGE_SIZE,
		});
		const weekMs = 7 * 24 * 3_600_000;
		const cut = Date.parse(input.startedAfter);
		expect(cut).toBeLessThanOrEqual(before - weekMs);
		expect(cut).toBeGreaterThan(before - weekMs - 61_000);
	});

	it("shows the filters in force and clears them all at once", async () => {
		const { node, button, updateSearch } = await mountLog({
			trigger: "test",
			range: "day",
			revision: 9,
			page: 3,
		});
		const label = (name: string) =>
			node.querySelector(`[aria-label="${name}"]`)?.textContent;
		expect(label("Filter by what started the run")).toContain("Test");
		expect(label("Filter by time")).toContain("Last 24 hours");
		expect(label("Filter by revision")).toContain("Revision 9");
		expect(node.textContent).toContain("There are no older runs.");
		await act(async () => button("Clear filters")!.click());
		expect(updateSearch).toHaveBeenCalledWith({
			status: undefined,
			trigger: undefined,
			range: undefined,
			revision: undefined,
			page: undefined,
		});
	});

	it("says no runs match when several filters are set, and offers no Clear without one", async () => {
		const filtered = await mountLog({ status: "failed", range: "day" });
		expect(filtered.node.textContent).toContain("No runs match these filters.");
		const plain = await mountLog({});
		expect(plain.node.textContent).toContain("This skill has not run yet.");
		expect(plain.node.textContent).not.toContain("Clear filters");
		expect(plain.node.querySelector("nav")).toBeNull();
	});

	it("goes back to the newest runs when the status filter changes", async () => {
		const { button, updateSearch } = await mountLog({ page: 4 }, [run]);
		await act(async () => button("Failed")!.click());
		expect(updateSearch).toHaveBeenCalledWith({
			status: "failed",
			page: undefined,
		});
	});

	it("pages through older and newer runs", async () => {
		const full = Array.from({ length: SKILL_RUN_PAGE_SIZE }, (_, index) => ({
			...run,
			id: `run-${index}`,
		}));
		const first = await mountLog({}, full);
		expect(first.button("Newer runs")?.disabled).toBe(true);
		await act(async () => first.button("Older runs")!.click());
		expect(first.updateSearch).toHaveBeenCalledWith({ page: 2 });

		const last = await mountLog({ page: 2 }, [run]);
		expect(last.node.textContent).toContain("Page 2");
		expect(last.button("Older runs")?.disabled).toBe(true);
		await act(async () => last.button("Newer runs")!.click());
		expect(last.updateSearch).toHaveBeenCalledWith({ page: undefined });
	});

	it("flags a run that has been running for hours and lets a manager cancel it", async () => {
		cancel.mockResolvedValue({});
		const { row, button } = await mountLog({}, [
			{
				...run,
				id: "old",
				status: "running",
				startedAt: hoursAgo(30),
				completedAt: null,
			},
			{
				...run,
				id: "fresh",
				status: "running",
				startedAt: hoursAgo(1),
				completedAt: null,
			},
		]);
		expect(row("old")?.textContent).toContain("Stuck");
		expect(row("old")?.textContent).toContain(
			"Started more than 6 hours ago and has not finished.",
		);
		expect(row("fresh")?.textContent).not.toContain("Stuck");
		expect(row("fresh")?.querySelector("button")).toBeNull();
		await act(async () => row("old")!.querySelector("button")!.click());
		expect(document.body.textContent).toContain("Cancel this run?");
		await act(async () => button("Cancel run")!.click());
		await act(async () => {
			await new Promise((done) => setTimeout(done, 20));
		});
		expect(cancel).toHaveBeenCalledWith(
			expect.objectContaining({ runId: "old", confirmDestructive: true }),
		);
	});

	it("flags a stuck run without Cancel for someone who cannot manage it", async () => {
		canManage.value = false;
		const { row } = await mountLog({}, [
			{
				...run,
				id: "old",
				status: "queued",
				startedAt: hoursAgo(30),
				completedAt: null,
			},
		]);
		expect(row("old")?.textContent).toContain("Stuck");
		expect(row("old")?.querySelector("button")).toBeNull();
	});
});
