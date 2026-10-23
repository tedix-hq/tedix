import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkItem } from "@tedix/db/schema/work-items";
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	laneNextStepNeedsPerson,
	routeLaneNextStepToAgent,
} from "./lane-handoff-routing";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@tedix/db/queries/work-items/interactions", () => ({
	createWorkInteraction: mocks.create,
}));

const db = {} as DbQueryClient;
const work = {
	id: "22222222-2222-4222-8222-222222222222",
	orgId: "11111111-1111-4111-8111-111111111111",
	stewardType: null,
	stewardId: null,
} as unknown as WorkItem;
const lane = {
	type: "external_agent" as const,
	id: "fictional-lane",
	sessionId: "fictional-session",
};

beforeEach(() => {
	mocks.create.mockReset();
	mocks.create.mockImplementation(async (_db, p) => ({ id: p.id, ...p }));
});

describe("lane next-step routing", () => {
	it.each([
		"Delete the paused graph copy before it auto-resumes",
		"Send the prepared reply to the customer",
		"Publish the support answer",
		"Complete the sign-in and consent for the retest",
		"Change the member back to the Member role",
		"Bookkeeping: answer the open expense questions or name your tax adviser",
		"Review two prepared contact drafts",
	])("keeps an owner-only step with the person: %s", (step) => {
		expect(laneNextStepNeedsPerson(step)).toBe(true);
	});

	it.each([
		"Extend this lane scope to package.json, bun.lock and patches/",
		"Owner/steward: mark Work complete; implementation is recorded",
		"Restore normal filesystem access, then restart this lane",
		"Choose draft ownership under the requesting member tedi",
	])("treats an engineering step as an agent decision: %s", (step) => {
		expect(laneNextStepNeedsPerson(step)).toBe(false);
	});

	it("files the step with the lane itself when the Work has no agent steward", async () => {
		await routeLaneNextStepToAgent(db, {
			work,
			executor: lane,
			externalSessionKey: "codex:fictional-session",
			nextClick: "Extend this lane scope to bun.lock",
			summary: "Stopped before editing.",
			now: "2026-10-23T12:00:00.000Z",
		});
		expect(mocks.create).toHaveBeenCalledWith(
			db,
			expect.objectContaining({
				workItemId: work.id,
				kind: "question",
				targetType: "external_agent",
				targetId: lane.id,
				creator: {
					type: "external_agent",
					id: lane.id,
					sessionId: lane.sessionId,
					externalSessionKey: "codex:fictional-session",
				},
			}),
		);
	});

	it("prefers the Work's agent steward and never targets a person", async () => {
		await routeLaneNextStepToAgent(db, {
			work: { ...work, stewardType: "tedi", stewardId: "fictional-cto" },
			executor: lane,
			nextClick: "Mark Work complete",
			now: "2026-10-23T12:00:00.000Z",
		});
		const [, params] = mocks.create.mock.calls[0]!;
		expect(params).toMatchObject({
			targetType: "tedi",
			targetId: "fictional-cto",
		});

		mocks.create.mockClear();
		await routeLaneNextStepToAgent(db, {
			work: { ...work, stewardType: "user", stewardId: "fictional-person" },
			executor: lane,
			nextClick: "Mark Work complete",
			now: "2026-10-23T12:00:00.000Z",
		});
		expect(mocks.create.mock.calls[0]![1]).toMatchObject({
			targetType: "external_agent",
			targetId: lane.id,
		});
	});
});
