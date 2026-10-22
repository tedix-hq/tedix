import { afterEach, describe, expect, test } from "bun:test";
import { runDecideCommand } from "./decide";
import type { NativeToolContext } from "./work";

const ENDPOINTS: Record<string, string> = {
	"decision.record_agent_decision": "decisionGraph/recordAgentDecision",
	"decision.record_agent_decision_outcome":
		"decisionGraph/recordAgentDecisionOutcome",
	"decision.list_agent_decisions": "decisionGraph/listAgentDecisions",
};
const DECISION_ID = "11111111-1111-4111-8111-111111111111";

function fixture(callable: string, result: unknown) {
	const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
	const descriptor = (name: string, endpoint: string) => ({
		name,
		endpoint,
		toolRowId: `row-${name}`,
		eligible: true,
		authorized: true,
		schemaFreshness: {
			source: "orpc",
			sourceRef: endpoint,
			sourceHash: "fixture-hash",
			syncedAt: "2026-10-22T07:00:00.000Z",
		},
	});
	const native = descriptor("tedix__journal", ENDPOINTS[callable]!);
	const client = {
		getTimeoutMs: () => 10000,
		callToolWithDestructiveApproval: async () => {
			throw new Error("Unexpected approval");
		},
		callTool: async (name: string, input: Record<string, unknown>) => {
			calls.push({ name, input });
			if (name === "get_info")
				return {
					nativeContext: {
						version: 1,
						surface: "mcp-gateway",
						appId: "app",
						appSlug: "tedix",
						organizationId: "fictional-orchard",
						actor: { authType: "user" },
						nativeTransportAvailable: true,
					},
					nativeCatalog: {
						status: "usable",
						search: descriptor("configured_search", "catalog/search"),
						describe: descriptor("configured_describe", "catalog/describe"),
					},
				};
			if (name === "configured_search")
				return {
					results: [{ callable, authorized: true, native, outputSchema: {} }],
				};
			if (name === "configured_describe")
				return {
					callable,
					authorized: true,
					native,
					schemaFreshness: native.schemaFreshness,
					parameters: { type: "object" },
				};
			if (name === native.name) return result;
			throw new Error(`Unexpected tool ${name}`);
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
	test("records a decision under this session by default", async () => {
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
					reason: "Idle for an hour.",
					reversibility: "two_way",
				}),
			]),
		);
		expect(code).toBe(0);
		expect(calls[1]?.input.namespace).toBe("decision");
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
