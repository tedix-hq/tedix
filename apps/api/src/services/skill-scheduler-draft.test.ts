import { expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	listDueSkillSchedules: vi.fn(),
	getSkillEntry: vi.fn(),
	pauseSkillSchedule: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/cognitive/skill-crud", () => ({
	getSkillEntry: mocks.getSkillEntry,
}));
vi.mock("@tedix/db/queries/skill-schedules", async (load) => ({
	...(await load<typeof import("@tedix/db/queries/skill-schedules")>()),
	...mocks,
}));
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
