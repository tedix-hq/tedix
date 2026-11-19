import { describe, expect, it } from "vite-plus/test";
import {
	agentRunFromToolResult,
	agentRunsFromEvents,
} from "./agent-run-result";

const result = {
	kind: "agent_run",
	workItemId: "11111111-1111-4111-8111-111111111111",
	title: "Fix paging",
	executor: "codex",
	url: "/work/items/11111111-1111-4111-8111-111111111111",
};
const run = {
	workItemId: result.workItemId,
	title: "Fix paging",
	executor: "codex",
};

describe("agentRunFromToolResult", () => {
	it("reads the result as an object, as JSON text and inside wrappers", () => {
		for (const value of [
			result,
			JSON.stringify(result),
			{ result },
			{ result: JSON.stringify(result) },
			{ content: [{ type: "text", text: JSON.stringify(result) }] },
			{ structuredContent: result, content: [{ type: "text", text: "ok" }] },
			{ name: "start_agent_run", ok: true, resultPreview: result },
		])
			expect(agentRunFromToolResult(value)).toEqual(run);
	});

	it("is not a run without the kind or a task id", () => {
		for (const value of [
			null,
			"started",
			"{not json",
			{ ...result, kind: "agent_run_steps" },
			{ ...result, workItemId: "  " },
			{ ...result, workItemId: 7 },
			{ truncated: true, preview: JSON.stringify(result).slice(0, 40) },
		])
			expect(agentRunFromToolResult(value)).toBeNull();
	});
});

describe("agentRunsFromEvents", () => {
	it("lists each started run once, from completed tool calls only", () => {
		const other = {
			...result,
			workItemId: "22222222-2222-4222-8222-222222222222",
		};
		expect(
			agentRunsFromEvents([
				{ kind: "tool.started", payload: { arguments: result } },
				{ kind: "tool.completed", payload: { resultPreview: result } },
				{ kind: "tool.completed", payload: { result: { matches: 2 } } },
				{ kind: "tool.completed", payload: { result } },
				{ kind: "tool.completed", payload: { result: JSON.stringify(other) } },
				{ kind: "tool.failed", payload: { result: other } },
			]).map((found) => found.workItemId),
		).toEqual([result.workItemId, other.workItemId]);
	});
});
