import type { SkillRunSummary } from "@tedix/api-contract/schemas/cognitive";
import type { OsWorkspaceSchedule } from "@tedix/api-contract/schemas/os-workspace-schedules";
import { describe, expect, it } from "vite-plus/test";
import {
	agentConversations,
	agentRunsNeedingYou,
	agentCountsLine,
	deriveWorkspaceAgents,
	isAgentSkillRun,
	ownConversations,
} from "./workspace-agents";
import type { ConversationSummary } from "./workspace-chat-protocol";

/** Local noon, so "today" holds in any time zone the suite runs in. */
const NOW = new Date(2026, 10, 18, 12, 0, 0);
const at = (day: number, hour = 9) =>
	new Date(2026, 10, day, hour, 0, 0).toISOString();

function schedule(skillId: string, name: string): OsWorkspaceSchedule {
	return {
		resourceId: `resource-${skillId}`,
		skillId,
		name,
		purpose: null,
		enabled: true,
		cron: "0 8 * * *",
		dailyTimes: [],
		nextRunAt: null,
		lastRun: null,
		personalRead: null,
		tediName: "Research Tedi",
		hasWorkflow: true,
	};
}

function run(
	id: string,
	more: Partial<SkillRunSummary> & Pick<SkillRunSummary, "status">,
): SkillRunSummary {
	return {
		id,
		organizationId: "org",
		skillId: "digest",
		tediId: "tedi-1",
		workflowInstanceId: id,
		runtimeEnvironment: "production",
		lastReconciledAt: null,
		executionEpoch: 0,
		hasResult: false,
		hasError: false,
		trigger: "scheduled",
		startedAt: at(18, 8),
		...more,
	} as SkillRunSummary;
}

function conversation(
	id: string,
	lastTurnAt: string,
	more: Partial<ConversationSummary> = {},
): ConversationSummary {
	return { id, title: `Run ${id}`, updatedAt: lastTurnAt, lastTurnAt, ...more };
}

describe("which conversations are an agent's", () => {
	const list = [
		conversation("mine", at(18)),
		conversation("run", at(18), { startedBy: { kind: "tedi", id: "t1" } }),
		conversation("old", at(10), {
			startedBy: { kind: "agent", id: "app:1" },
			archivedAt: at(11),
		}),
	];

	it("keeps only what a person started in the chat list", () => {
		expect(ownConversations(list).map((row) => row.id)).toEqual(["mine"]);
	});

	it("lists agent-started conversations as runs, without the archived ones", () => {
		expect(agentConversations(list).map((row) => row.id)).toEqual(["run"]);
	});

	it("counts the agent runs that wait for a decision, not a person's own", () => {
		const tedi = { kind: "tedi", id: "t1" } as const;
		const waiting = [
			conversation("mine", at(18), { pendingApprovals: 3 }),
			conversation("asks", at(18), { startedBy: tedi, pendingApprovals: 2 }),
			conversation("quiet", at(18), { startedBy: tedi }),
			conversation("gone", at(10), {
				startedBy: tedi,
				pendingApprovals: 1,
				archivedAt: at(11),
			}),
		];
		expect(agentRunsNeedingYou(waiting)).toBe(1);
		// The open run was just answered here; the list has not heard yet.
		expect(
			agentRunsNeedingYou(waiting, { id: "asks", pendingApprovals: 0 }),
		).toBe(0);
		expect(
			agentRunsNeedingYou(waiting, { id: "quiet", pendingApprovals: 1 }),
		).toBe(2);
	});
});

describe("which skill runs are an agent's", () => {
	it("counts scheduled, agent-started and unrecorded starts, not a person's or a test", () => {
		expect(
			(["scheduled", "agent", null, "manual", "test"] as const).map((trigger) =>
				isAgentSkillRun({ trigger }),
			),
		).toEqual([true, true, true, false, false]);
	});
});

describe("deriveWorkspaceAgents", () => {
	it("gives a linked skill one row with its working, waiting and today counts", () => {
		const [agent] = deriveWorkspaceAgents({
			schedules: [schedule("digest", "Morning digest")],
			runsBySkill: new Map([
				[
					"digest",
					[
						run("r-running", { status: "running", startedAt: at(18, 11) }),
						run("r-paused", {
							status: "paused",
							startedAt: at(17, 8),
							pausedAt: at(18, 10),
						}),
						run("r-done", {
							status: "completed",
							startedAt: at(18, 8),
							completedAt: at(18, 9),
						}),
						run("r-yesterday", {
							status: "failed",
							startedAt: at(17, 8),
							completedAt: at(17, 9),
						}),
						// A person started this one, so it is not the agent's.
						run("r-manual", {
							status: "running",
							trigger: "manual",
							startedAt: at(18, 11),
						}),
					],
				],
			]),
			conversations: [],
			tedis: new Map(),
			tediIdsBySkill: new Map(),
			now: NOW,
		});
		expect(agent).toMatchObject({
			key: "skill:digest",
			name: "Morning digest",
			detail: "No tedi assigned",
			working: 1,
			needsYou: 1,
			today: 3,
			lastActiveAt: at(18, 11),
			skills: [
				{ id: "digest", name: "Morning digest", href: "/skills/digest/runs" },
			],
		});
		expect(agent!.runs.map((row) => [row.key, row.state])).toEqual([
			["r-running", "working"],
			["r-paused", "needs_you"],
			["r-done", "done"],
			["r-yesterday", "failed"],
		]);
		expect(agent!.runs[0]!.open).toEqual({
			type: "link",
			href: "/work/runs/r-running",
		});
	});

	it("groups agent-started conversations by who started them and names a linked tedi", () => {
		const agents = deriveWorkspaceAgents({
			schedules: [],
			runsBySkill: new Map(),
			conversations: [
				conversation("mine", at(18, 11)),
				conversation("a", at(18, 10), {
					startedBy: { kind: "tedi", id: "t1" },
					pendingApprovals: 2,
					running: true,
				}),
				conversation("b", at(16), { startedBy: { kind: "tedi", id: "t1" } }),
				conversation("c", at(18, 7), {
					startedBy: { kind: "agent", id: "app:9" },
					running: true,
				}),
			],
			tedis: new Map([
				[
					"t1",
					{
						name: "Ops Tedi",
						avatar: null,
						owner: "Belongs to the organization",
					},
				],
			]),
			tediIdsBySkill: new Map(),
			now: NOW,
		});
		expect(
			agents.map((agent) => [
				agent.name,
				agent.working,
				agent.needsYou,
				agent.today,
			]),
		).toEqual([
			["Ops Tedi", 1, 1, 1],
			["Connected agent", 1, 0, 1],
		]);
		// A decision the run waits for outranks the work still going on.
		expect(agents[0]!.runs.map((row) => [row.key, row.state])).toEqual([
			["a", "needs_you"],
			["b", "done"],
		]);
		expect(agents[0]!.runs[0]!.open).toEqual({
			type: "conversation",
			conversationId: "a",
		});
	});

	it("merges multiple skills and conversations under their tedi id, keeping equal names distinct", () => {
		const agents = deriveWorkspaceAgents({
			schedules: [schedule("digest", "Digest"), schedule("check", "Check")],
			runsBySkill: new Map([
				[
					"digest",
					[run("digest-run", { status: "paused", pausedAt: at(18, 9) })],
				],
				[
					"check",
					[run("check-run", { status: "running", startedAt: at(18, 11) })],
				],
			]),
			conversations: [
				conversation("chat", at(18, 10), {
					startedBy: { kind: "tedi", id: "t1" },
					running: true,
				}),
			],
			tedis: new Map([
				["t1", { name: "Ops", avatar: "🦉", owner: "Owned by Alex" }],
				[
					"t2",
					{ name: "Ops", avatar: null, owner: "Belongs to the organization" },
				],
			]),
			tediIdsBySkill: new Map([
				["digest", "t1"],
				["check", "t1"],
			]),
			now: NOW,
		});
		expect(agents).toHaveLength(2);
		expect(agents[0]).toMatchObject({
			key: "tedi:t1",
			tediId: "t1",
			name: "Ops",
			avatar: "🦉",
			detail: "Owned by Alex",
			profileHref: "/team/t1",
			working: 2,
			needsYou: 1,
			today: 3,
			lastActiveAt: at(18, 11),
		});
		expect(agents[0]!.skills.map((skill) => skill.id)).toEqual([
			"digest",
			"check",
		]);
		expect(agents[0]!.runs.map((row) => row.key)).toEqual([
			"check-run",
			"chat",
			"digest-run",
		]);
		expect(agents[1]).toMatchObject({
			key: "tedi:t2",
			detail: "Belongs to the organization",
			runs: [],
			today: 0,
		});
	});

	it("orders agents by newest activity and puts one that never ran last", () => {
		const agents = deriveWorkspaceAgents({
			schedules: [schedule("idle", "Idle skill"), schedule("digest", "Digest")],
			runsBySkill: new Map([
				["digest", [run("r1", { status: "completed", completedAt: at(17) })]],
				["idle", []],
			]),
			conversations: [
				conversation("a", at(18), { startedBy: { kind: "tedi", id: "t9" } }),
			],
			tedis: new Map(),
			tediIdsBySkill: new Map(),
			now: NOW,
		});
		expect(agents.map((agent) => agent.name)).toEqual([
			"Tedi profile unavailable",
			"Digest",
			"Idle skill",
		]);
		expect(agents[2]).toMatchObject({ runs: [], lastActiveAt: null, today: 0 });
	});
});

describe("agentCountsLine", () => {
	it("leaves out what is zero but always says how many ran today", () => {
		expect(agentCountsLine({ working: 1, needsYou: 2, today: 3 })).toBe(
			"1 working · 2 need you · 3 today",
		);
		expect(agentCountsLine({ working: 0, needsYou: 1, today: 0 })).toBe(
			"1 needs you · 0 today",
		);
		expect(agentCountsLine({ working: 0, needsYou: 0, today: 0 })).toBe(
			"0 today",
		);
	});
});
