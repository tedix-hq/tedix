import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const db = vi.hoisted(() => ({
	list: vi.fn(),
	create: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/work-items/capture-health", () => ({
	CAPTURE_HEALTH_SCHEMA: "tedix.capture-health.v1",
	listCaptureHealth: db.list,
}));
vi.mock("@tedix/db/queries/work-items/interactions", () => ({
	createWorkInteraction: db.create,
}));

import {
	CAPTURE_HEALTH_SUBJECT,
	captureLooksBroken,
	runCaptureHealthHeartbeat,
} from "./capture-health";

/** Thursday 07:00 UTC: the window is Wednesday. */
const THURSDAY = Date.UTC(2026, 9, 8, 7);
/** Monday 07:00 UTC: the window is Sunday. */
const MONDAY = Date.UTC(2026, 9, 12, 7);

const row = (over: Record<string, unknown> = {}) => ({
	orgId: "org",
	userId: "user",
	projectId: "project",
	workItemId: null,
	caseId: null,
	alertOpen: false,
	turns: 0,
	drafts: 0,
	lessons: 0,
	...over,
});

describe("captureLooksBroken", () => {
	it("flags a silent weekday, or a silent day with agent sessions", () => {
		expect(captureLooksBroken({ turns: 0, lessons: 0 }, THURSDAY)).toBe(true);
		expect(captureLooksBroken({ turns: 0, lessons: 0 }, MONDAY)).toBe(false);
		expect(captureLooksBroken({ turns: 0, lessons: 2 }, MONDAY)).toBe(true);
		expect(captureLooksBroken({ turns: 1, lessons: 0 }, THURSDAY)).toBe(false);
	});
});

describe("runCaptureHealthHeartbeat", () => {
	beforeEach(() => {
		db.list.mockReset();
		db.create.mockReset().mockResolvedValue({});
	});

	it("raises one For-you item per silent user, skipping an open one", async () => {
		db.list.mockResolvedValue([
			row({ userId: "silent", lessons: 3, drafts: 1 }),
			row({ userId: "already", alertOpen: true }),
			row({ userId: "fine", turns: 4 }),
		]);
		const result = await runCaptureHealthHeartbeat(
			{ DB: {} as D1Database },
			THURSDAY,
		);
		expect(result).toEqual({ users: 3, alerted: 1 });
		expect(db.list).toHaveBeenCalledWith(expect.anything(), {
			since: "2026-10-07T07:00:00.000Z",
			activeSince: "2026-09-24T07:00:00.000Z",
			now: "2026-10-08T07:00:00.000Z",
		});
		expect(db.create).toHaveBeenCalledTimes(1);
		const [, params] = db.create.mock.calls[0]!;
		expect(params).toMatchObject({
			orgId: "org",
			projectId: "project",
			subject: CAPTURE_HEALTH_SUBJECT,
			targetType: "user",
			targetId: "silent",
			expiresAt: "2026-10-09T19:00:00.000Z",
			metadata: {
				schema: "tedix.capture-health.v1",
				triage: { urgency: "now" },
				counts: { turns: 0, drafts: 1, lessons: 3 },
			},
		});
		expect(params.prompt).toContain("0 turns · 1 drafts · 3 lessons");
	});

	it("fails the run receipt when an item cannot be written", async () => {
		db.list.mockResolvedValue([row()]);
		db.create.mockRejectedValue(new Error("not a member"));
		await expect(
			runCaptureHealthHeartbeat({ DB: {} as D1Database }, THURSDAY),
		).rejects.toThrow("failed for 1 users");
	});
});
