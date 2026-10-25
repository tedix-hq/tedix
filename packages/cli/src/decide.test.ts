import { afterEach, describe, expect, test } from "bun:test";
import { runDecideCommand } from "./decide";
import type { NativeToolContext } from "./work";

const DECISION_ID = "11111111-1111-4111-8111-111111111111";

function fixture(callable: string, result: unknown) {
	const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
	const client = {
		callTool: async (name: string, input: Record<string, unknown>) => {
			if (name !== "code") throw new Error(`Unexpected native call ${name}`);
			const source = String(input.code);
			const tool = callable.split(".")[1]!;
			const decision = {
				[tool]: async (args: Record<string, unknown>) => {
					calls.push({ name: callable, input: args });
					return result;
				},
			};
			return {
				result: await new Function("decision", `return (${source})()`)(
					decision,
				),
			};
		},
	} as NativeToolContext["client"];
	return {
		calls,
		ctx: (positionals: string[]) => ({
			client,
			json: true,
			positionals,
			workspace: "fixture",
			mcpUrl: "https://mcp.tedix.test/mcp",
			organizationId: "fictional-orchard",
		}),
	};
}

const previousSession = process.env.TEDIX_AGENT_SESSION;
afterEach(() => {
	if (previousSession === undefined) delete process.env.TEDIX_AGENT_SESSION;
	else process.env.TEDIX_AGENT_SESSION = previousSession;
});

describe("tedix decide", () => {
	test("records through Code Mode without native provenance under this session by default", async () => {
		process.env.TEDIX_AGENT_SESSION = "codex:fixture-session";
		const { ctx, calls } = fixture("decision.record_agent_decision", {
			decisionId: DECISION_ID,
			duplicate: false,
			classId: "agent:lead:lane.pause",
			needsPerson: false,
			askable: false,
			edgesWritten: 1,
			notice: null,
		});
		const code = await runDecideCommand(
			ctx([
				JSON.stringify({
					agentName: "Lead",
					decisionClass: "lane.pause",
					question: "Pause the idle lane?",
					options: [
						{ id: "pause", label: "Pause" },
						{ id: "keep", label: "Keep" },
					],
					chosen: "pause",
					reason:
						'Quotes " and backticks ` remain data; "); throw new Error("injected") //',
					reversibility: "two_way",
				}),
			]),
		);
		expect(code).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("decision.record_agent_decision");
		expect(calls.at(-1)?.input).toMatchObject({
			agentSession: "codex:fixture-session",
			decisionClass: "lane.pause",
			chosen: "pause",
		});
	});

	test("records a person's undo as an outcome", async () => {
		const { ctx, calls } = fixture("decision.record_agent_decision_outcome", {
			decisionId: DECISION_ID,
			outcomeEventId: "22222222-2222-4222-8222-222222222222",
			duplicate: false,
			correction: true,
			mistakeRecorded: true,
		});
		const code = await runDecideCommand(
			ctx(["outcome", DECISION_ID, "reverted", "Restarted by hand", "person"]),
		);
		expect(code).toBe(0);
		expect(calls.at(-1)?.input).toMatchObject({
			decisionId: DECISION_ID,
			outcome: "reverted",
			by: "person",
		});
	});

	test("lists decisions through Code Mode with the requested limit", async () => {
		const { ctx, calls } = fixture("decision.list_agent_decisions", {
			decisions: [],
			classes: [],
			summary: "No decisions.",
		});
		expect(await runDecideCommand({ ...ctx(["list"]), limit: 3 })).toBe(0);
		expect(calls).toEqual([
			{ name: "decision.list_agent_decisions", input: { limit: 3 } },
		]);
	});

	test("refuses gateway rejection, malformed and truncated results", async () => {
		for (const result of [
			{ ok: false, error: "FORBIDDEN" },
			{},
			{ __tedix_truncated: true, preview: "{}" },
		]) {
			const { ctx, calls } = fixture("decision.list_agent_decisions", result);
			expect(await runDecideCommand(ctx(["list"]))).toBe(2);
			expect(calls).toHaveLength(1);
		}
	});

	test("refuses malformed input before any call", async () => {
		const { ctx, calls } = fixture("decision.record_agent_decision", {});
		expect(
			await runDecideCommand(
				ctx(["outcome", DECISION_ID, "reverted", "why", "someone"]),
			),
		).toBe(2);
		expect(
			await runDecideCommand(
				ctx([JSON.stringify({ decisionClass: "x", chosen: "missing" })]),
			),
		).toBe(2);
		expect(calls).toHaveLength(0);
	});
});
