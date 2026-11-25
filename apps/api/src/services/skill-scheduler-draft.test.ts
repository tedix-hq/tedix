import { expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	listDueSkillSchedules: vi.fn(),
	getSkillEntry: vi.fn(),
	pauseSkillSchedule: vi.fn(),
	listSchedulesWithFailedLastRun: vi.fn(async () => [] as unknown[]),
	recordSkillScheduleRetry: vi.fn(),
	recordSkillScheduleError: vi.fn(async () => undefined),
	advanceSkillScheduleToSlot: vi.fn(),
	migrateFactorySlotGuard: vi.fn(async () => true),
	recordSkillScheduleDispatch: vi.fn(),
}));
const raiseSkillStoppedNotice = vi.hoisted(() =>
	vi.fn(async () => ({ raised: true })),
);
vi.mock("@tedix/db/queries/skill-stop-notice", () => ({
	raiseSkillStoppedNotice,
}));
vi.mock("@tedix/db/queries/personal-resource-delegations", () => ({
	listActiveSkillPersonalResourceDelegations: vi.fn(async () => []),
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
		raiseSkillStoppedNotice.mockClear();
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
		// The owner is told when a skill they rely on stopped, not for an
		// improvement proposal or a skill archived on purpose.
		if (tags || lifecycleState === "archived")
			expect(raiseSkillStoppedNotice).not.toHaveBeenCalled();
		else
			expect(raiseSkillStoppedNotice).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					organizationId: "org",
					skillId: "skill",
					cause: { kind: "inactive" },
				}),
			);
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

it("migrates an existing factory timer before admission and dispatches only its local slot", async () => {
	const guard =
		'\t\t\tif (age >= 30) return { status: "skipped", reason: "off_slot", summary: "Outside the local slot window; no reads or writes." };\n';
	const skill = {
		id: "skill",
		organizationId: "org",
		tediId: "tedi",
		slug: "daily-review",
		lifecycleState: "active",
		tags: null,
		revision: 1,
		content:
			'---\nrunsAt: {timeZone: Europe/Berlin, times: ["09:00"]}\ncapabilities:\n  schedule:\n    cron: "*/5 * * * *"\n---\n',
		files: {
			"scripts/workflow.ts":
				"// Generated by create_factory (report lane using factory-lane template v1). Binding ids arrive at run time.\n" +
				guard +
				"export default {}",
		},
	};
	const schedule = {
		id: "timer",
		skillId: "skill",
		tediId: "tedi",
		organizationId: "org",
		cron: "*/5 * * * *",
		enabled: true,
		params: {},
		nextFireAt: "2026-11-25T07:00:00.000Z",
	};
	mocks.listSchedulesWithFailedLastRun.mockResolvedValue([]);
	mocks.getSkillEntry.mockResolvedValue(skill);
	mocks.listDueSkillSchedules.mockResolvedValue([schedule]);
	const fetch = vi.fn(async () =>
		Response.json({ runId: "slot-run", workflowInstanceId: "wf" }),
	);
	const env = { DB: {}, SKILL_RUNTIME: { fetch } } as unknown as CloudflareEnv;
	const outside = await dispatchDueSkillSchedules(
		env,
		Date.parse("2026-11-25T07:02:00Z"),
	);
	expect(outside).toMatchObject({ dispatched: 0, rescheduled: 1, failed: 0 });
	expect(fetch).not.toHaveBeenCalled();
	expect(mocks.advanceSkillScheduleToSlot).toHaveBeenLastCalledWith(
		expect.anything(),
		schedule,
		"2026-11-25T08:00:00.000Z",
	);
	expect(mocks.migrateFactorySlotGuard).toHaveBeenCalledWith(
		expect.anything(),
		skill,
		{ "scripts/workflow.ts": expect.not.stringContaining(guard) },
	);
	schedule.nextFireAt = "2026-11-25T08:00:00.000Z";
	const inside = await dispatchDueSkillSchedules(
		env,
		Date.parse("2026-11-25T08:02:00Z"),
	);
	expect(inside).toMatchObject({ dispatched: 1, rescheduled: 0, failed: 0 });
	const body = JSON.parse(
		(fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
	);
	expect(body.workflowSource).not.toContain(guard);
	expect(body.skillRevision).toBe(2);
	expect(mocks.recordSkillScheduleDispatch).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.objectContaining({
			nextFireAt: "2026-11-26T08:00:00.000Z",
			runId: "slot-run",
		}),
	);
	fetch.mockClear();
	const expired = await dispatchDueSkillSchedules(
		env,
		Date.parse("2026-11-25T08:30:00Z"),
	);
	expect(expired).toMatchObject({ dispatched: 0, rescheduled: 1 });
	expect(fetch).not.toHaveBeenCalled();
});
