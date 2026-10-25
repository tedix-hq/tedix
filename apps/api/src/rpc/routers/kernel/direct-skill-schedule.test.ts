import type { DbClient } from "@tedix/db/client";
import {
	decideKernelWriteApproval,
	parseKernelGovernancePolicy,
	platformAutonomousOperation,
} from "@tedix/api-contract/utils/approval-policy";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ findSkillsByReference: vi.fn() }));
vi.mock("@tedix/db/queries/skill-ownership", () => ({
	findSkillsByReference: mocks.findSkillsByReference,
}));

import {
	directSkillScheduleKernelResult,
	parseSkillScheduleRequest,
	resolveDirectSkillSchedule,
} from "./direct-skill-schedule";
import { canonicalWriteToolName, correctWriteRoute } from "./write-tool-intent";
import { classifyWriteRisk } from "./write-tool-policy";

const db = {} as DbClient;
const SKILL = "89f003f7-1324-4096-b629-bb17cb7bc275";

describe("parseSkillScheduleRequest", () => {
	it.each([
		[`Pause the schedule of skill ${SKILL}`, { action: "pause", skill: SKILL }],
		[
			`[[tedix-context:workspace:w1:Ops]]\n\nplease disable the schedule for the mail watcher copy skill.`,
			{ action: "pause", skill: "mail watcher copy" },
		],
		[
			'Resume the schedule of "example-mail-feedback-watcher"',
			{ action: "resume", skill: "example-mail-feedback-watcher" },
		],
		[
			"stop the scheduled runs of skill account-watcher now",
			{ action: "pause", skill: "account-watcher" },
		],
	])("reads %j", (content, expected) => {
		expect(parseSkillScheduleRequest(content)).toEqual(expected);
	});

	it.each([
		"How do I pause the schedule of a skill?",
		"Pause that factory",
		"Pause the skill run 1234",
		"Pause the schedules of the reddit skills",
		`Do not pause the schedule of skill ${SKILL}`,
		`Pause the schedule of skill ${SKILL} and skill other`,
	])("ignores %j", (content) => {
		expect(parseSkillScheduleRequest(content)).toBeNull();
	});
});

describe("resolveDirectSkillSchedule", () => {
	beforeEach(() => mocks.findSkillsByReference.mockReset());

	it("routes a pause to the exact platform call, never a delegation", async () => {
		mocks.findSkillsByReference.mockResolvedValue([
			{
				id: SKILL,
				slug: "mail-watcher-copy",
				title: "Mail watcher copy",
				tediId: "t1",
			},
		]);
		const resolved = await resolveDirectSkillSchedule(db, {
			organizationId: "org-1",
			content: `Pause the schedule of skill ${SKILL}`,
		});
		expect(resolved).toMatchObject({
			action: "pause",
			skillTitle: "Mail watcher copy",
			intent: {
				capability: "skills.pause_schedule",
				toolName: "skills.pause_skill_schedule",
				args: { id: SKILL },
			},
		});
		expect(mocks.findSkillsByReference).toHaveBeenCalledWith(db, {
			organizationId: "org-1",
			reference: SKILL,
			limit: 2,
		});
		const result = directSkillScheduleKernelResult(
			resolved!,
			"example-unified",
		);
		expect(result.route).toMatchObject({
			routeKind: "propose_tool_write",
			targetTediId: null,
			effortClass: "single_read",
			toolIntent: {
				appSlug: "example-unified",
				capability: "skills.pause_schedule",
			},
		});
		expect(result.delegation).toBeNull();
		expect(canonicalWriteToolName("skills.pause_schedule")).toBe(
			"skills.pause_skill_schedule",
		);
		expect(canonicalWriteToolName("skills.resume_schedule")).toBe(
			"skills.resume_skill_schedule",
		);
		expect(
			correctWriteRoute(
				{
					...result.route,
					toolIntent: {
						...result.route.toolIntent!,
						capability: "skills.update",
					},
				},
				`Pause the schedule of skill ${SKILL}`,
				null,
				resolved!.intent,
			).toolIntent?.capability,
		).toBe("skills.pause_schedule");
	});

	it("resolves a resume by title", async () => {
		mocks.findSkillsByReference.mockResolvedValue([
			{ id: SKILL, slug: "mail-watcher", title: "Mail watcher", tediId: "t1" },
		]);
		const resolved = await resolveDirectSkillSchedule(db, {
			organizationId: "org-1",
			content: "Resume the schedule of the Mail watcher skill",
		});
		expect(resolved?.intent).toEqual({
			capability: "skills.resume_schedule",
			toolName: "skills.resume_skill_schedule",
			args: { id: SKILL },
		});
	});

	it.each([
		["an unknown skill", []],
		[
			"an ambiguous reference",
			[
				{ id: "a", slug: "a", title: "A", tediId: null },
				{ id: "b", slug: "b", title: "B", tediId: null },
			],
		],
	])("returns null for %s", async (_label, rows) => {
		mocks.findSkillsByReference.mockResolvedValue(rows);
		expect(
			await resolveDirectSkillSchedule(db, {
				organizationId: "org-1",
				content: "Pause the schedule of skill watcher",
			}),
		).toBeNull();
	});
});

describe("skill schedule approval", () => {
	it.each(["skills.pause_skill_schedule", "skills.resume_skill_schedule"])(
		"%s is a platform skills-and-schedules operation",
		(tool) => {
			expect(platformAutonomousOperation(tool)?.id).toBe(
				"skills_and_schedules",
			);
			expect(
				platformAutonomousOperation(
					tool.split(".")[1]!,
					tool.endsWith("pause_skill_schedule")
						? "skills/pauseSchedule"
						: "skills/resumeSchedule",
				)?.id,
			).toBe("skills_and_schedules");
		},
	);

	it("runs without a card under the platform default and keeps one when the organization opted out", () => {
		const riskTier = classifyWriteRisk({
			name: "skills.pause_skill_schedule",
			annotations: { destructiveHint: false },
			_meta: {
				"com.tedix/policy": {
					riskTier: "bounded_write",
					blastRadius: "single_resource",
				},
			},
		});
		expect(riskTier).not.toBe("high");
		expect(
			decideKernelWriteApproval({
				policy: null,
				proposal: {
					appSlug: "example-unified",
					toolName: "skills.pause_skill_schedule",
					riskTier,
				},
			}),
		).toMatchObject({ autoResolve: true, source: "policy" });
		expect(
			decideKernelWriteApproval({
				policy: parseKernelGovernancePolicy({ autonomy: false }),
				proposal: {
					appSlug: "example-unified",
					toolName: "skills.pause_skill_schedule",
					riskTier,
				},
			}).autoResolve,
		).toBe(false);
	});
});
