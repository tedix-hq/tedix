import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	hasActiveSkillRun,
	skillRunsSearchSchema,
} from "@/lib/skill-runs-search";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => [] as Array<{ path: string; input: unknown }>);
const authority = vi.hoisted(() => ({ role: "member" }));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({ data: { authority } }),
}));
vi.mock("@/lib/api", () => {
	const client = (path: string[]): unknown =>
		new Proxy(
			(input: unknown) => {
				const key = path.join(".");
				calls.push({ path: key, input });
				// Refetches after an action must still see well-formed reads.
				return Promise.resolve(
					key === "skills.listWorkflowRetryCandidates"
						? { candidates: [] }
						: { runId: "run-new" },
				);
			},
			{
				get: (_target, name) =>
					typeof name === "string" ? client([...path, name]) : undefined,
			},
		);
	return { osApi: client([]) };
});
const canManage = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/tedi-permissions", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/tedi-permissions")>()),
	useCanManageTedis: () => canManage.value,
}));
vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		params: _params,
		children,
		...rest
	}: {
		to: string;
		params?: unknown;
		children?: ReactNode;
	}) => (
		<a href={to} {...rest}>
			{children}
		</a>
	),
	Outlet: () => null,
	useNavigate: () => () => {},
	useParams: () => ({ skillId: "skill-1", runId: "run-1" }),
	useRouterState: ({
		select,
	}: {
		select: (state: { location: { pathname: string } }) => unknown;
	}) => select({ location: { pathname: "/skills/skill-1/runs" } }),
}));

const { SkillDetailLayout } = await import("./skill-detail-layout");
const { SkillRunsPage } = await import("./skill-runs-page");
const { SkillSchedulePage } = await import("./skill-schedule-page");
const { SkillVersionsPage } = await import("./skill-versions-page");
const { RunDetailPage } = await import("./run-detail");
const { TEDIS_MANAGE_DENIED_REASON } = await import("@/lib/tedi-permissions");
const q = await import("@/lib/os-query-options");

const cleanups: Array<() => void> = [];
afterEach(() => {
	cleanups.splice(0).forEach((cleanup) => cleanup());
	calls.length = 0;
	canManage.value = true;
	authority.role = "member";
	document.body.replaceChildren();
});

async function mount(element: ReactNode, seed: (client: QueryClient) => void) {
	const client = new QueryClient({
		defaultOptions: {
			// Seeded data is the whole truth for these renders: never refetch it.
			queries: {
				enabled: false,
				retry: false,
				staleTime: Number.POSITIVE_INFINITY,
			},
			mutations: { retry: false },
		},
	});
	seed(client);
	const invalidated: unknown[] = [];
	const invalidate = client.invalidateQueries.bind(client);
	client.invalidateQueries = (async (
		filters?: Parameters<typeof invalidate>[0],
	) => {
		invalidated.push(filters?.queryKey);
		return invalidate(filters);
	}) as typeof client.invalidateQueries;
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>{element}</QueryClientProvider>,
		),
	);
	cleanups.push(() => act(() => root.unmount()));
	const click = async (text: string) => {
		const target = [
			...document.body.querySelectorAll<HTMLElement>("button"),
		].find((button) => button.textContent?.trim() === text)!;
		await act(async () => {
			target.click();
			for (let tick = 0; tick < 3; tick += 1)
				await new Promise((resolve) => setTimeout(resolve, 0));
		});
	};
	return { host, invalidated, click };
}

const skill = {
	entry: {
		id: "skill-1",
		organizationId: "org-1",
		content: "# Customer export",
		successCount: 1,
		failureCount: 4,
		lastUsedAt: null,
		visibility: "org" as const,
		paceLayer: "innovation" as const,
		title: "Customer export",
		folderPath: "operations",
		revision: 3,
		lifecycleState: "active" as const,
		files: { "scripts/workflow.ts": "export default {}" },
	},
};

describe("native skill ownership", () => {
	it.each(["owner", "admin"])(
		"lets an %s turn a draft back on with one click",
		async (role) => {
			authority.role = role;
			const { host, invalidated, click } = await mount(
				<SkillDetailLayout />,
				(client) =>
					client.setQueryData(q.skillDetailQueryOptions("skill-1").queryKey, {
						entry: { ...skill.entry, lifecycleState: "draft" },
					}),
			);
			expect(host.textContent).toContain("Turn back on");
			await click("Turn back on");
			expect(calls.filter((call) => call.path === "skills.improve")).toEqual([
				{
					path: "skills.improve",
					input: {
						id: "skill-1",
						lifecycleState: "active",
						force: true,
						revisionReasoning:
							"Owner or admin turned the skill back on from its Tedix OS page.",
					},
				},
			]);
			expect(invalidated).toContainEqual(q.osQueryKeys.skills());
			expect(invalidated).toContainEqual(q.osQueryKeys.skillSchedules());
		},
	);

	it.each(["member", "unknown"])(
		"hides draft reactivation from %s",
		async (role) => {
			authority.role = role;
			const { host } = await mount(<SkillDetailLayout />, (client) =>
				client.setQueryData(q.skillDetailQueryOptions("skill-1").queryKey, {
					entry: { ...skill.entry, lifecycleState: "draft" },
				}),
			);
			expect(host.textContent).not.toContain("Turn back on");
		},
	);

	it("hides reactivation for an active skill", async () => {
		authority.role = "owner";
		const { host } = await mount(<SkillDetailLayout />, (client) =>
			client.setQueryData(q.skillDetailQueryOptions("skill-1").queryKey, skill),
		);
		expect(host.textContent).not.toContain("Turn back on");
	});

	const draftRun = (id: string, status: "completed" | "failed") => ({
		id,
		organizationId: "org-1",
		skillId: "skill-1",
		tediId: "tedi-1",
		workflowInstanceId: id,
		runtimeEnvironment: "production" as const,
		lastReconciledAt: null,
		executionEpoch: 0,
		status,
		skillRevision: 3,
		startedAt: "2026-11-07T06:00:00.000Z",
		completedAt: "2026-11-07T06:00:14.000Z",
		hasResult: false,
		hasError: status === "failed",
	});
	const seedDraft =
		(runs: Array<ReturnType<typeof draftRun>>, schedulePaused = false) =>
		(client: QueryClient) => {
			client.setQueryData(q.skillDetailQueryOptions("skill-1").queryKey, {
				entry: { ...skill.entry, lifecycleState: "draft" },
			});
			client.setQueryData(q.skillRunsQueryOptions("skill-1").queryKey, {
				runs,
			} as never);
			client.setQueryData(
				q.skillSpecificSchedulesQueryOptions("skill-1").queryKey,
				{
					schedules: schedulePaused ? [{ id: "s-1", enabled: false }] : [],
					total: schedulePaused ? 1 : 0,
					offset: 0,
					limit: 100,
					nextOffset: null,
				} as never,
			);
			if (runs[0]?.status === "failed")
				client.setQueryData(q.skillRunStatusQueryOptions(runs[0].id).queryKey, {
					...runs[0],
					error: "Error: Mailbox token expired\n    at step (workflow.ts:4)",
				} as never);
		};
	const draftNotice = (host: HTMLElement) =>
		host.querySelector('[aria-label="Why this skill is a draft"]');
	const headerButtons = (host: HTMLElement) =>
		[...host.querySelectorAll<HTMLElement>("button")]
			.map((button) => button.textContent?.trim())
			.filter((text) => text === "Run a test" || text === "Turn back on");

	it("tells an owner a skill went to draft after failed runs, with the date, the error and the test first", async () => {
		authority.role = "owner";
		const { host } = await mount(
			<SkillDetailLayout />,
			seedDraft(
				[
					draftRun("run-9", "failed"),
					draftRun("run-8", "failed"),
					draftRun("run-7", "failed"),
					draftRun("run-6", "completed"),
				],
				true,
			),
		);
		const notice = draftNotice(host)!;
		expect(notice.textContent).toContain("Draft after 3 failed runs in a row");
		expect(notice.textContent).toContain(
			"Its last 3 runs failed, most recently on Nov 7",
		);
		expect(notice.textContent).toContain("Last error: Mailbox token expired");
		expect(notice.textContent).not.toContain("workflow.ts:4");
		expect(notice.textContent).toContain(
			"Its schedule is paused, so no scheduled runs start.",
		);
		expect(
			notice.querySelector('a[href="/work/runs/$runId"]')?.textContent,
		).toBe("Open the failed run");
		expect(
			[...notice.querySelectorAll("ol li")].map((step) => step.textContent),
		).toEqual([
			"Open the failed run, see what went wrong and fix it.",
			"Run a test. Tedix normally turns a skill on only after a test run of this version has passed.",
			"Turn it back on.",
			"Open the Settings tab and turn the schedule back on if it is still paused.",
		]);
		// The test comes before turning the skill back on.
		expect(headerButtons(host)).toEqual(["Run a test", "Turn back on"]);
	});

	it("starts a test run of the draft from the page and says it is a test", async () => {
		authority.role = "owner";
		const { click } = await mount(<SkillDetailLayout />, seedDraft([]));
		await click("Run a test");
		const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
		expect(dialog.textContent).toContain("Test run of Customer export");
		expect(dialog.textContent).toContain("Runs revision 3 once as a test");
		expect(
			[...dialog.querySelectorAll("button")].map((button) =>
				button.textContent?.trim(),
			),
		).toContain("Run test");
	});

	it("says a draft that never ran is not turned on yet", async () => {
		authority.role = "admin";
		const { host } = await mount(<SkillDetailLayout />, seedDraft([]));
		const notice = draftNotice(host)!;
		expect(notice.textContent).toContain("Draft: not turned on yet");
		expect(notice.textContent).toContain(
			"A new skill starts as a draft. It has not run yet.",
		);
		expect(notice.textContent).not.toContain("Open the failed run");
	});

	it("tells a member why it is a draft and whom to ask, without owner buttons", async () => {
		authority.role = "member";
		const { host } = await mount(
			<SkillDetailLayout />,
			seedDraft([draftRun("run-2", "completed")]),
		);
		const notice = draftNotice(host)!;
		expect(notice.textContent).toContain(
			"Draft: this version is not turned on",
		);
		expect(notice.textContent).toContain(
			"Ask an owner or admin to turn this skill back on.",
		);
		expect(headerButtons(host)).toEqual([]);
	});

	it("claims no cause for a draft whose runs are not loaded, and none for an active skill", async () => {
		authority.role = "owner";
		const unloaded = await mount(<SkillDetailLayout />, (client) =>
			client.setQueryData(q.skillDetailQueryOptions("skill-1").queryKey, {
				entry: { ...skill.entry, lifecycleState: "draft" },
			}),
		);
		expect(draftNotice(unloaded.host)!.textContent).toContain(
			"This skill is a draft",
		);
		expect(draftNotice(unloaded.host)!.textContent).not.toContain("failed");
		const active = await mount(<SkillDetailLayout />, (client) =>
			client.setQueryData(q.skillDetailQueryOptions("skill-1").queryKey, skill),
		);
		expect(draftNotice(active.host)).toBeNull();
	});

	it("keeps the detail frame visible while loading and when a skill is missing", async () => {
		const loading = await mount(<SkillDetailLayout />, () => {});
		expect(loading.host.querySelector('[data-slot="skeleton"]')).not.toBeNull();
		expect(loading.host.textContent).toContain("All skills");
		const missing = await mount(<SkillDetailLayout />, (client) =>
			client.setQueryData(q.skillDetailQueryOptions("skill-1").queryKey, {
				entry: null,
			}),
		);
		expect(missing.host.textContent).toContain("Skill not found");
		expect(missing.host.textContent).toContain("All skills");
	});
	it("validates shareable run status without accepting arbitrary query values", () => {
		expect(skillRunsSearchSchema.parse({ status: "queued" })).toEqual({
			status: "queued",
		});
		expect(skillRunsSearchSchema.parse({ status: "not-real" })).toEqual({});
	});

	it("polls only while a skill has active workflow runs", () => {
		expect(hasActiveSkillRun([{ status: "queued" }])).toBe(true);
		expect(hasActiveSkillRun([{ status: "running" }])).toBe(true);
		expect(hasActiveSkillRun([{ status: "paused" }])).toBe(true);
		expect(hasActiveSkillRun([{ status: "completed" }])).toBe(false);
	});

	it("routes skill sections as anchors and gates Run now on manage authority", async () => {
		canManage.value = false;
		const { host } = await mount(<SkillDetailLayout />, (client) =>
			client.setQueryData(
				q.skillDetailQueryOptions("skill-1").queryKey,
				skill as never,
			),
		);
		const list = host.querySelector('[aria-label="Skill detail sections"]');
		const tabs = [...(list?.querySelectorAll('[role="tab"]') ?? [])];
		expect(tabs.length).toBeGreaterThan(0);
		for (const tab of tabs) expect(tab.tagName).toBe("A");
		expect(
			tabs.map((tab) => [tab.textContent?.trim(), tab.getAttribute("href")]),
		).toEqual([
			["Overview", "/skills/$skillId"],
			["Runs", "/skills/$skillId/runs"],
			["Versions", "/skills/$skillId/versions"],
			["Settings", "/skills/$skillId/settings"],
			["Source", "/skills/$skillId/source"],
		]);
		const run = [...host.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Run now"),
		);
		expect(run?.disabled).toBe(true);
		expect(run?.getAttribute("aria-label")).toBe(TEDIS_MANAGE_DENIED_REASON);
	});

	it("runs the skill as a chosen tedi and refreshes the skill reads", async () => {
		const { host, invalidated } = await mount(
			<SkillDetailLayout />,
			(client) => {
				client.setQueryData(
					q.skillDetailQueryOptions("skill-1").queryKey,
					skill as never,
				);
				client.setQueryData(q.tediRosterQueryOptions(100).queryKey, {
					data: [{ id: "tedi-1", name: "CTO" }],
				} as never);
			},
		);
		const open = [...host.querySelectorAll<HTMLElement>("button")].find(
			(button) => button.textContent?.includes("Run now"),
		)!;
		await act(async () => open.click());
		const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
		const trigger = dialog.querySelector<HTMLElement>('[role="combobox"]')!;
		await act(async () => {
			trigger.click();
			await Promise.resolve();
		});
		const option = [
			...document.querySelectorAll<HTMLElement>('[role="option"]'),
		].find((candidate) => candidate.textContent?.includes("CTO"))!;
		await act(async () => {
			option.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
			option.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
			option.click();
			await Promise.resolve();
		});
		await act(async () => {
			dialog.querySelector("form")!.requestSubmit();
			for (let tick = 0; tick < 5; tick += 1)
				await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(
			calls.find((call) => call.path === "skills.runWorkflow")?.input,
		).toMatchObject({
			skillId: "skill-1",
			tediId: "tedi-1",
			confirmDestructive: true,
		});
		expect(invalidated).toContainEqual(q.osQueryKeys.skills());
	});

	it("moves a skill without editing its runtime identity", async () => {
		const { host, invalidated } = await mount(<SkillDetailLayout />, (client) =>
			client.setQueryData(
				q.skillDetailQueryOptions("skill-1").queryKey,
				skill as never,
			),
		);
		const open = [...host.querySelectorAll<HTMLElement>("button")].find(
			(button) => button.textContent?.trim() === "Move",
		)!;
		await act(async () => open.click());
		const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
		const input = dialog.querySelector<HTMLInputElement>("input")!;
		await act(async () => {
			const setValue = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!;
			setValue.call(input, "customer-success/exports");
			input.dispatchEvent(new Event("input", { bubbles: true }));
			dialog.querySelector("form")!.requestSubmit();
			for (let tick = 0; tick < 5; tick += 1)
				await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(calls.find((call) => call.path === "skills.move")?.input).toEqual({
			id: "skill-1",
			folderPath: "customer-success/exports",
		});
		expect(invalidated).toContainEqual(q.osQueryKeys.skills());
	});

	it("offers every run status filter and an inline empty state", async () => {
		const { host } = await mount(
			<SkillRunsPage search={{}} updateSearch={() => {}} />,
			(client) =>
				client.setQueryData(
					q.skillRunsQueryOptions("skill-1", undefined).queryKey,
					{ runs: [] } as never,
				),
		);
		for (const label of [
			"All",
			"Queued",
			"Running",
			"Paused",
			"Failed",
			"Completed",
			"Canceled",
		])
			expect(host.textContent).toContain(label);
		const empty = host.querySelector('[data-slot="empty"]');
		expect(empty?.textContent).toContain("No runs to show");
		expect(empty?.className).not.toContain("py-12");
	});

	it("shows why a schedule was budget-blocked", async () => {
		const { host } = await mount(<SkillSchedulePage />, (client) =>
			client.setQueryData(
				q.skillSpecificSchedulesQueryOptions("skill-1").queryKey,
				{
					schedules: [
						{
							id: "schedule-1",
							cron: "0 9 * * *",
							enabled: true,
							tediId: "tedi-1",
							nextFireAt: new Date().toISOString(),
							lastBudgetBlockedAt: new Date().toISOString(),
							lastBudgetAdmissionClass: "governed_learning",
							lastBudgetBlockedReason: "daily token budget exhausted",
						},
					],
				} as never,
			),
		);
		expect(host.textContent).toContain("governed learning");
		expect(host.textContent).toContain("daily token budget exhausted");
	});

	it("shows canonical revision evidence and admits a truncated sample", async () => {
		const { host, click } = await mount(<SkillVersionsPage />, (client) =>
			client.setQueryData(q.skillRevisionsQueryOptions("skill-1").queryKey, {
				sampledRunCount: 50,
				mayBeTruncated: true,
				revisions: [
					{
						revision: 3,
						runId: "run-1",
						observedRunCount: 4,
						completedCount: 3,
						failedCount: 1,
						canceledCount: 0,
						workflowSourceSha256: "sha-workflow",
						skillDocSha256: "sha-doc",
						runtimeVariants: [
							{
								runId: "run-1",
								executionEpoch: 0,
								manifestPath: "manifest.json",
								observation: "matched",
							},
						],
					},
				],
			} as never),
		);
		expect(host.textContent).toContain("older runs are not counted");
		await click("Technical details");
		expect(host.textContent).toContain("sha-workflow");
		expect(host.textContent).toContain("sha-doc");
		expect(host.textContent).toContain("Runtime variants: 1");
	});

	it("retries a failed run only through the engine-verified token", async () => {
		const { click, invalidated } = await mount(<RunDetailPage />, (client) => {
			client.setQueryData(q.workflowRunInspectQueryOptions("run-1").queryKey, {
				run: {
					id: "run-1",
					status: "failed",
					tediId: "tedi-1",
					skillId: "skill-1",
				},
				revision: { skillSlug: "customer-export" },
				steps: [],
				toolCalls: [],
				warnings: [],
			} as never);
			client.setQueryData(q.workflowRetryCandidatesQueryOptions().queryKey, {
				candidates: [{ runId: "run-1", restartId: "restart-7" }],
			} as never);
		});
		await click("Retry");
		expect(document.body.textContent).toContain("engine-verified retry token");
		await click("Retry run");
		expect(
			calls.find((call) => call.path === "skills.restartWorkflow")?.input,
		).toMatchObject({
			runId: "run-1",
			restartId: "restart-7",
			confirmDestructive: true,
		});
		expect(invalidated).toContainEqual(q.osQueryKeys.skills());
	});

	it("confirms a non-idempotent workflow event before sending it", async () => {
		const { click } = await mount(<RunDetailPage />, (client) =>
			client.setQueryData(q.workflowRunInspectQueryOptions("run-1").queryKey, {
				run: {
					id: "run-1",
					status: "paused",
					tediId: "tedi-1",
					skillId: "skill-1",
				},
				revision: { skillSlug: "customer-export" },
				steps: [
					{
						path: "epochs/0/steps/wait/1/attempts/1.json",
						name: "wait",
						count: 1,
						executionEpoch: 0,
						kind: "wait_for_event",
						status: "waiting",
						data: { eventType: "customer.confirmed" },
					},
				],
				toolCalls: [],
				warnings: [],
			} as never),
		);
		await click("Review event");
		expect(document.body.textContent).toContain("The event is non-idempotent");
		expect(
			calls.some((call) => call.path === "skills.runWorkflowSendEvent"),
		).toBe(false);
		await click("Send event");
		expect(
			calls.find((call) => call.path === "skills.runWorkflowSendEvent")?.input,
		).toMatchObject({
			runId: "run-1",
			type: "customer.confirmed",
			payload: {},
		});
	});
});
