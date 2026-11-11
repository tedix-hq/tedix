import { expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	listDueSkillSchedules: vi.fn(),
	getSkillEntry: vi.fn(),
	pauseSkillSchedule: vi.fn(),
	listSchedulesWithFailedLastRun: vi.fn(async () => [] as unknown[]),
	recordSkillScheduleRetry: vi.fn(),
	recordSkillScheduleError: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/cognitive/skill-crud", () => ({
	getSkillEntry: mocks.getSkillEntry,
}));
vi.mock("@tedix/db/queries/skill-schedules", async (load) => ({
	...(await load<typeof import("@tedix/db/queries/skill-schedules")>()),
	...mocks,
}));
vi.mock("../kernel/runtime-submission-bridge", () => ({
	recordTediSubmissionStarted: vi.fn(),
}));
vi.mock("@tedix/db/queries/tedis", () => ({ getTediById: vi.fn() }));
import { dispatchDueSkillSchedules } from "./skill-scheduler";
it.each([
	{ lifecycleState: "draft", tags: null },
	{ lifecycleState: "stale", tags: null },
	{ lifecycleState: "archived", tags: null },
	{ lifecycleState: "active", tags: ["workflow-improvement"] },
])(
	"pauses a stored $lifecycleState timer ($tags) without dispatching a run",
	async ({ lifecycleState, tags }) => {
		mocks.listDueSkillSchedules.mockResolvedValue([
			{ id: "timer", skillId: "skill", tediId: "tedi", organizationId: "org" },
		]);
		mocks.getSkillEntry.mockResolvedValue({
			id: "skill",
			tediId: "tedi",
			lifecycleState,
			tags,
		});
		const fetch = vi.fn();
		const result = await dispatchDueSkillSchedules(
			{ DB: {}, SKILL_RUNTIME: { fetch } } as unknown as CloudflareEnv,
			Date.now(),
		);
		expect(result).toMatchObject({ dispatched: 0, failed: 0, suppressed: 1 });
		expect(mocks.pauseSkillSchedule).toHaveBeenCalledWith(
			expect.anything(),
			"skill",
			"org",
		);
		expect(fetch).not.toHaveBeenCalled();
	},
);

it("dispatches a scheduled run again after it failed on a database outage", async () => {
	const now = Date.parse("2026-11-11T08:12:00.000Z");
	mocks.listDueSkillSchedules.mockResolvedValue([]);
	const schedule = {
		id: "timer",
		skillId: "skill",
		tediId: "tedi",
		organizationId: "org",
		cron: "0 8 * * *",
		enabled: true,
		params: {},
		nextFireAt: "2026-11-12T08:00:00.000Z",
		lastFireAt: "2026-11-11T08:00:00.000Z",
		lastRunId: "failed-run",
	};
	mocks.listSchedulesWithFailedLastRun.mockResolvedValue([
		{
			schedule,
			runError:
				"SERVICE_UNAVAILABLE: Database temporarily unavailable; retry shortly",
			runStartedAt: "2026-11-11 08:00:19",
		},
	]);
	mocks.getSkillEntry.mockResolvedValue({
		id: "skill",
		tediId: "tedi",
		slug: "daily-search",
		lifecycleState: "proven",
		tags: null,
		revision: null,
		content: '---\ncapabilities:\n  schedule:\n    cron: "0 8 * * *"\n---\n',
		files: { "scripts/workflow.ts": "export default {}" },
	});
	const fetch = vi.fn(async () =>
		Response.json({ runId: "retry-run", workflowInstanceId: "wf" }),
	);
	const result = await dispatchDueSkillSchedules(
		{ DB: {}, SKILL_RUNTIME: { fetch } } as unknown as CloudflareEnv,
		now,
	);
	expect(result).toMatchObject({ due: 1, dispatched: 1, failed: 0 });
	const body = JSON.parse(
		(fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
	);
	expect(body.idempotencyKey).toBe(
		"skill-schedule:skill:2026-11-11T08:00:00.000Z:outage-retry-10",
	);
	expect(mocks.recordSkillScheduleRetry).toHaveBeenCalledWith(
		expect.anything(),
		{
			scheduleId: "timer",
			failedRunId: "failed-run",
			runId: "retry-run",
		},
	);
});
