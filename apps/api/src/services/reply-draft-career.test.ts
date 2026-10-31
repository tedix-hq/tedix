import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { DbClient } from "@tedix/db/client";

const mocks = vi.hoisted(() => ({
	organizations: vi.fn(),
	outcomes: vi.fn(),
	activity: vi.fn(),
	record: vi.fn(),
}));
vi.mock("@tedix/db/queries/work-items/reply-drafts", () => ({
	listReplyDraftOutcomeOrganizations: mocks.organizations,
	listUnrecordedReplyDraftOutcomes: mocks.outcomes,
}));
vi.mock("@tedix/db/queries/earned-delegation/reply-draft-career", () => ({
	getReplyDraftingActivity: mocks.activity,
	readReplyDraftingConfig: (activity: { rubric: unknown }) => activity.rubric,
	recordReplyDraftObservations: mocks.record,
	ensureReplyDraftRole: vi.fn(async () => undefined),
	loadReplyDraftCareers: async () => new Map(),
	evaluateCareerLadder: vi.fn(),
	applyReplyDraftCareerChange: vi.fn(),
	stoodStreakDays: vi.fn(),
}));
import { settleReplyDraftCareers } from "./reply-draft-career";
const db = {} as DbClient;
const now = new Date("2026-01-02T12:00:00Z");
beforeEach(() => {
	vi.clearAllMocks();
	mocks.organizations.mockResolvedValue(["cedar", "pine"]);
	mocks.activity.mockImplementation(async (_db, org) => ({
		id: `activity-${org}`,
		version: 3,
		rubric: {
			initialRole: { key: "example", name: "Example" },
			ladder: {
				autoSettleMinutes: org === "cedar" ? 15 : 180,
				demotion: { windowDays: 9 },
			},
		},
	}));
	mocks.outcomes.mockResolvedValue([]);
	mocks.record.mockResolvedValue(0);
});
it("uses each organization's stored settlement delay without creating or replacing activities", async () => {
	await settleReplyDraftCareers(db, now);
	expect(mocks.outcomes.mock.calls.map(([, p]) => p)).toEqual([
		{
			orgId: "cedar",
			since: "2025-12-03T12:00:00.000Z",
			settledBefore: "2026-01-02T11:45:00.000Z",
			limit: 500,
		},
		{
			orgId: "pine",
			since: "2025-12-03T12:00:00.000Z",
			settledBefore: "2026-01-02T09:00:00.000Z",
			limit: 500,
		},
	]);
});
it("leaves outcomes untouched when an activity has not been provisioned", async () => {
	mocks.activity.mockResolvedValue(null);
	expect(await settleReplyDraftCareers(db, now)).toMatchObject({
		recorded: 0,
		promoted: 0,
		demoted: 0,
	});
	expect(mocks.outcomes).not.toHaveBeenCalled();
	expect(mocks.record).not.toHaveBeenCalled();
});
it("preserves the shared per-tick outcome budget across organizations", async () => {
	mocks.outcomes.mockResolvedValue(
		Array.from({ length: 500 }, (_, i) => ({ drafterId: `example-${i}` })),
	);
	await settleReplyDraftCareers(db, now);
	expect(mocks.outcomes).toHaveBeenCalledTimes(1);
});
