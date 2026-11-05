import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DbClient } from "@tedix/db/client";

const mocks = vi.hoisted(() => ({ skill: vi.fn(), work: vi.fn() }));
vi.mock("@tedix/db/queries/cognitive/skill-crud", () => ({
	getSkillEntry: mocks.skill,
}));
vi.mock("@tedix/db/queries/work-items/crud", () => ({
	getWorkItemById: mocks.work,
}));

import {
	directSkillRunKernelResult,
	parseSkillRunRequest,
	resolveDirectSkillRun,
} from "./direct-skill-run";

const SKILL = "00000000-0000-4000-8000-000000000011";
const WORK = "00000000-0000-4000-8000-000000000012";
// The cited run's request shape with fictional resources and provider.
const content = `For Work Item ${WORK}, directly run existing skill ${SKILL} once with exactly these params: startDate=2026-10-12, endDate=2026-10-18, cycleKey=2026-W42. Pin the run to that Work Item and use the skill's existing CTO owner. Do not delegate. This bounded run reads Example and appends one idempotent weekly section to existing OS Output 00000000-0000-4000-8000-000000000013. If human approval is required, create the approval request and stop for the owner; do not bypass it or perform any other write.\n\nLocal terminal context:\n- cwd: /example`;
const db = {} as DbClient;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.skill.mockResolvedValue({
		id: SKILL,
		tediId: "existing-owner",
		title: "Weekly visibility",
		revision: 2,
		lifecycleState: "draft",
	});
	mocks.work.mockResolvedValue({ id: WORK, orgId: "org-1" });
});

describe("direct existing-skill request", () => {
	it("preserves the cited request's parameters, Work and existing owner without inventing certification", async () => {
		const run = await resolveDirectSkillRun(db, {
			organizationId: "org-1",
			content,
			runId: "home-1",
		});
		expect(run?.intent).toEqual({
			capability: "skills.run",
			toolName: "skills.run_workflow",
			args: {
				skillId: SKILL,
				workItemId: WORK,
				tediId: "existing-owner",
				expectedSkillRevision: 2,
				idempotencyKey: "home:home-1",
				confirmDestructive: true,
				reason: expect.any(String),
				params: {
					startDate: "2026-10-12",
					endDate: "2026-10-18",
					cycleKey: "2026-W42",
				},
			},
		});
		expect(mocks.skill).toHaveBeenCalledWith(db, SKILL, "org-1");
		expect(mocks.work).toHaveBeenCalledWith(db, WORK, "org-1");
		expect(directSkillRunKernelResult(run!, "org-tools")).toMatchObject({
			route: {
				routeKind: "propose_tool_write",
				targetTediId: null,
				toolIntent: { capability: "skills.run" },
			},
			delegation: null,
		});
		expect(
			(
				await resolveDirectSkillRun(db, {
					organizationId: "org-1",
					content,
					runId: "home-1",
				})
			)?.intent.args.idempotencyKey,
		).toBe(run?.intent.args.idempotencyKey);
	});

	it.each([
		`Do not run existing skill ${SKILL} once with params: cycleKey=2026-W42.`,
		`How do I run existing skill ${SKILL} once with params: cycleKey=2026-W42?`,
		`Run existing skill ${SKILL} once with params: cycleKey=one, cycleKey=two.`,
		`Run existing skill ${SKILL} once with params: cycleKey=one and email everyone.`,
		`Run existing skill ${SKILL} once with params: x={unknown}.`,
	])(
		"leaves an ambiguous or non-action request to the router: %s",
		(request) => {
			expect(parseSkillRunRequest(request)).toBeNull();
		},
	);

	it.each([
		null,
		{ tediId: null },
		{ tediId: "owner", lifecycleState: "archived" },
	])("does not propose an unavailable skill %j", async (skill) => {
		mocks.skill.mockResolvedValue(skill);
		expect(
			await resolveDirectSkillRun(db, {
				organizationId: "org-1",
				content,
				runId: "home-1",
			}),
		).toBeNull();
	});

	it("refuses a Work reference in another organization", async () => {
		mocks.work.mockResolvedValue({ orgId: "other-org" });
		expect(
			await resolveDirectSkillRun(db, {
				organizationId: "org-1",
				content,
				runId: "home-1",
			}),
		).toBeNull();
	});
});
