import { describe, expect, it, spyOn } from "bun:test";
import type { SkillContext } from "./skill";
import { runSkillCommand, skillUsage } from "./skill";

const SKILL_ID = "5eed0005-0000-4000-8000-000000000005";

function harness(reply: unknown) {
	const calls: string[] = [];
	const approvals: string[] = [];
	const ctx: SkillContext = {
		client: {
			runCode: async (source: string) => {
				calls.push(source);
				return reply;
			},
			runCodeWithDestructiveApproval: async (
				source: string,
				reason: string,
			) => {
				calls.push(source);
				approvals.push(reason);
				return reply;
			},
		} as SkillContext["client"],
		color: { enabled: false },
		json: true,
		workspace: "tedix",
		limit: 3,
		flow: {},
	};
	return { calls, approvals, ctx };
}

describe("skill commands", () => {
	it("lists through the canonical org skill callable", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		const { calls, ctx } = harness({
			entries: [{ id: SKILL_ID, lifecycleState: "proven", slug: "demo" }],
		});
		ctx.json = false;
		expect(await runSkillCommand("list", ctx)).toBe(0);
		expect(calls[0]).toContain("skills.list_skills_by_org");
		expect(calls[0]).toContain('"summary":true');
		expect(stdout.mock.calls[0]?.[0]).toContain(SKILL_ID);
		stdout.mockRestore();
	});

	it("shows one persistent skill by UUID", async () => {
		const { calls, ctx } = harness({ id: SKILL_ID });
		expect(await runSkillCommand(`show ${SKILL_ID}`, ctx)).toBe(0);
		expect(calls[0]).toContain("skills.get_skills");
		expect(calls[0]).toContain(`"id":"${SKILL_ID}"`);
	});

	it("runs through flow.run without creating a draft", async () => {
		const { calls, approvals, ctx } = harness({
			skillId: SKILL_ID,
			runId: "run-1",
		});
		expect(await runSkillCommand(`run ${SKILL_ID}`, ctx)).toBe(0);
		expect(calls[0]).toContain("flow.run");
		expect(calls[0]).toContain(`"skillId":"${SKILL_ID}"`);
		expect(calls[0]).not.toContain('"source"');
		expect(approvals).toHaveLength(1);
	});

	it("shares flow status diagnostics without inspection, retries, delegation, or mutation", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		const { calls, approvals, ctx } = harness({
			executionId: "exec-1",
			result: {
				status: "failed",
				output: { result: "nested" },
				error: { code: "GATEWAY_FAILED", message: "skill status diagnostic" },
			},
		});
		expect(await runSkillCommand("status run-1", ctx)).toBe(2);
		expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
			runId: "run-1",
			status: "failed",
			result: { result: "nested" },
			error: { code: "GATEWAY_FAILED", message: "skill status diagnostic" },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("flow.status");
		expect(calls[0]).not.toMatch(/flow\.(inspect|retry)|delegat|mutat/);
		expect(approvals).toHaveLength(0);
		stdout.mockRestore();
	});

	it("fails clearly on obsolete or ambiguous verbs", async () => {
		const stderr = spyOn(console, "error").mockImplementation(() => {});
		const { calls, ctx } = harness({});
		expect(await runSkillCommand("promote foo", ctx)).toBe(2);
		expect(stderr.mock.calls[0]?.[0]).toContain("unknown skill verb");
		expect(calls).toHaveLength(0);
		stderr.mockRestore();
	});

	it("documents the three distinct surfaces", () => {
		expect(skillUsage()).toContain("persistent, revisioned capabilities");
		expect(skillUsage()).toContain("tedix flow run --file");
		expect(skillUsage()).toContain("tedix workflow");
	});
});
