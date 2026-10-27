import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import type { SkillSchedule } from "@tedix/api-contract/schemas/cognitive";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const mocks = vi.hoisted(() => ({ read: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/api", () => ({
	osApi: {
		skills: {
			listWorkflowSchedules: mocks.read,
			updateSchedule: mocks.update,
		},
	},
}));
vi.mock("@/lib/use-tedi-names", () => ({
	useTediNames: () => ({ worker: "Example worker" }),
}));
import { skillSpecificSchedulesQueryOptions } from "@/lib/os-query-options";
import { setOsFormattingPreferences } from "@/lib/format";
import { SkillSchedulePage } from "./skill-schedule-page";

const now = "2026-10-21T12:00:00Z";
function schedule(overrides: Partial<SkillSchedule> = {}): SkillSchedule {
	return {
		id: "schedule",
		organizationId: "example",
		skillId: "alpha",
		tediId: "worker",
		cron: "0 13 * * *",
		params: {},
		enabled: true,
		nextFireAt: "2026-10-21T13:00:00Z",
		...overrides,
	};
}
const cleanups: (() => void)[] = [];
beforeEach(() => {
	mocks.read.mockReset();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(now));
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	setOsFormattingPreferences({ locale: "en-US", timezone: "UTC" });
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	setOsFormattingPreferences({ locale: null, timezone: null });
	vi.useRealTimers();
});
async function flush() {
	await act(async () => {
		await new Promise((done) => setTimeout(done, 20));
	});
}
async function mount(rows?: SkillSchedule[]) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	if (rows)
		client.setQueryData(skillSpecificSchedulesQueryOptions("alpha").queryKey, {
			schedules: rows,
			total: rows.length,
			offset: 0,
			limit: 200,
			nextOffset: null,
		});
	const rootRoute = createRootRoute({ component: Outlet });
	const session = createRoute({
		getParentRoute: () => rootRoute,
		id: "_session",
		component: Outlet,
	});
	const tenant = createRoute({
		getParentRoute: () => session,
		id: "_tenant",
		component: Outlet,
	});
	const skill = createRoute({
		getParentRoute: () => tenant,
		path: "skills/$skillId",
		component: SkillSchedulePage,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([
			session.addChildren([tenant.addChildren([skill])]),
		]),
		history: createMemoryHistory({ initialEntries: ["/skills/alpha"] }),
	});
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	cleanups.push(() => {
		act(() => root.unmount());
		client.clear();
		node.remove();
	});
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<RouterProvider router={router} />
			</QueryClientProvider>,
		);
		await router.load();
	});
	await flush();
	return { node, client, router };
}

describe("manifest skill schedule clocks", () => {
	it.each([
		[true, "2026-10-21T13:00:00Z", "Next run in 1h"],
		[false, "2026-10-21T13:00:00Z", "Paused · not scheduled"],
		[false, "2026-10-21T11:00:00Z", "Paused · not scheduled"],
		[true, "2026-10-21T11:00:00Z", "Next run unavailable"],
		[true, now, "Next run unavailable"],
		[true, "invalid", "Next run unavailable"],
	])("enabled=%s next=%s reads %s", async (enabled, nextFireAt, label) => {
		const { node } = await mount([schedule({ enabled, nextFireAt })]);
		expect(node.textContent).toContain(label);
		expect(node.textContent).toContain("Cron timezone: UTC");
		expect(node.textContent).toContain("Timestamps: UTC");
		if (
			!enabled ||
			Date.parse(nextFireAt) <= Date.parse(now) ||
			nextFireAt === "invalid"
		)
			expect(node.textContent).not.toContain("Next run in");
	});
	it("stops promising a next run when mounted metadata expires", async () => {
		const nextFireAt = new Date(Date.parse(now) + 100).toISOString();
		const { node } = await mount([schedule({ nextFireAt })]);
		expect(node.textContent).toContain("Next run just now");
		vi.setSystemTime(new Date(nextFireAt));
		await act(async () => {
			await new Promise((done) => setTimeout(done, 120));
		});
		expect(node.textContent).toContain("Next run unavailable");
	});
	it("preserves history, budget information and run link as formatting preferences hydrate", async () => {
		const { node } = await mount([
			schedule({
				lastFireAt: "2026-10-21T10:00:00Z",
				lastError: "Read failed",
				lastRunId: "run-example",
				lastBudgetBlockedAt: "2026-10-21T11:00:00Z",
				lastBudgetBlockedReason: "Daily limit",
				lastBudgetAdmissionClass: "governed_learning",
			}),
		]);
		const status = [...node.querySelectorAll("span")].find((element) =>
			element.textContent?.includes("Next run in 1h"),
		);
		expect(status?.textContent).toContain("last fired 2h ago");
		expect(status?.textContent).not.toContain("Last error");
		expect(
			[...node.querySelectorAll("span")].some(
				(element) => element.textContent === "Last error: Read failed",
			),
		).toBe(true);
		expect(node.textContent).toContain(
			"Budget blocked 1h ago · governed learning · Daily limit",
		);
		expect(
			node.querySelector('a[href="/work/runs/run-example"]'),
		).not.toBeNull();
		const before = node.querySelector("a")?.title;
		await act(async () =>
			setOsFormattingPreferences({
				locale: "en-US",
				timezone: "America/New_York",
			}),
		);
		expect(node.textContent).toContain("Timestamps: America/New_York");
		expect(node.querySelector("a")?.title).not.toBe(before);
		expect(node.textContent).toContain("Cron timezone: UTC");
	});
	it("recovers a failed discovery with a read and returns to loading while fetching", async () => {
		mocks.read.mockRejectedValueOnce(new Error("Discovery failed"));
		const { node } = await mount();
		expect(node.textContent).toContain("Schedules unavailable");
		expect(node.textContent).not.toContain("declares no schedules");
		const retry = [...node.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Retry",
		)!;
		let resolve!: (data: { schedules: SkillSchedule[] }) => void;
		mocks.read.mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		await act(async () => retry.click());
		await flush();
		expect(node.querySelector("button")).toBeNull();
		expect(node.textContent).not.toContain("declares no schedules");
		await act(async () => resolve({ schedules: [schedule()] }));
		await flush();
		expect(node.textContent).toContain("Next run in 1h");
		expect(node.querySelector('[role="alert"]')).toBeNull();
		expect(mocks.read).toHaveBeenCalledTimes(2);
	});
	it("retains useful cached rows with an explicit refresh warning", async () => {
		const { node, client } = await mount([schedule()]);
		mocks.read.mockRejectedValueOnce(new Error("Refresh failed"));
		await act(async () => {
			await client.refetchQueries(skillSpecificSchedulesQueryOptions("alpha"));
		});
		await flush();
		expect(node.textContent).toContain("Could not refresh schedules");
		expect(node.textContent).toContain("Showing previously loaded schedules");
		expect(node.textContent).toContain("Next run in 1h");
	});
	it("turns a schedule off through skills.updateSchedule and confirms it", async () => {
		mocks.update.mockResolvedValue({
			skillId: "alpha",
			slug: "alpha-skill",
			action: "updated",
			changed: true,
			cron: "0 13 * * *",
			scheduleEnabled: false,
			nextFireAt: null,
		});
		const { node } = await mount([schedule()]);
		const toggle = [...node.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Turn off"),
		)!;
		await act(async () => toggle.click());
		await flush();
		expect(mocks.update).toHaveBeenCalledWith({
			id: "alpha",
			enabled: false,
		});
		expect(node.textContent).toContain(
			"Off — it will not run again until you turn it back on.",
		);
	});
	it("changes the generated query identity when the skill changes", async () => {
		const { node, router } = await mount([schedule()]);
		mocks.read.mockReturnValueOnce(new Promise(() => {}));
		await act(async () => {
			await router.navigate({
				to: "/skills/$skillId",
				params: { skillId: "beta" },
			});
		});
		await flush();
		expect(node.textContent).not.toContain("Next run in 1h");
		expect(mocks.read.mock.calls[0]?.[0]).toMatchObject({ skillId: "beta" });
	});
});
