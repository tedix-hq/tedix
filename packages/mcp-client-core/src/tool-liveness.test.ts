import { describe, expect, it } from "vite-plus/test";
import {
	classifyToolCall,
	hasExecutionEvidence,
	type TurnToolCall,
} from "./tool-liveness";

describe("classifyToolCall", () => {
	it("meta discovery tools are discovery", () => {
		expect(classifyToolCall("tedix_mcp_list_namespaces", "{}")).toBe(
			"discovery",
		);
		expect(
			classifyToolCall("tedix_mcp_search_tools", '{"query":"github"}'),
		).toBe("discovery");
	});

	it("tedix_mcp_call_tool always executes a named tool", () => {
		expect(
			classifyToolCall(
				"tedix_mcp_call_tool",
				'{"namespace":"github_tedix","tool":"list_commits","args":{}}',
			),
		).toBe("execution");
	});

	it("tedix_mcp_code that only runs discover.* is discovery (the observed stall)", () => {
		const args = JSON.stringify({
			code: "async () => { const ns = await discover.list_namespaces(); return ns; }",
		});
		expect(classifyToolCall("tedix_mcp_code", args)).toBe("discovery");
	});

	it("tedix_mcp_code that calls a real namespace.tool is execution", () => {
		const args = JSON.stringify({
			code: "async () => { const c = await github_tedix.list_commits({ per_page: 5 }); return c; }",
		});
		expect(classifyToolCall("tedix_mcp_code", args)).toBe("execution");
	});

	it("tedix_mcp_code mixing discover + a real call is execution", () => {
		const args = JSON.stringify({
			code: "async () => { await discover.search('github'); return await github_tedix.get_commit({ ref: 'main' }); }",
		});
		expect(classifyToolCall("tedix_mcp_code", args)).toBe("execution");
	});

	it("language scaffolding (JSON/console/Math) is not mistaken for execution", () => {
		const args = JSON.stringify({
			code: "async () => { const x = JSON.parse('[]'); console.log(x); return Math.max(1,2); }",
		});
		expect(classifyToolCall("tedix_mcp_code", args)).toBe("discovery");
	});

	it("local collection operations after discovery are not execution", () => {
		const args = JSON.stringify({
			code: "async () => { const ns = await discover.list_namespaces(); return Object.entries(ns).filter(([name]) => name.includes('github')).map(([name]) => name); }",
		});
		expect(classifyToolCall("tedix_mcp_code", args)).toBe("discovery");
	});

	it("local search-result mapping is not execution", () => {
		const args = JSON.stringify({
			code: "async () => { const hits = await discover.search('github'); return hits.map((hit) => hit.callable); }",
		});
		expect(classifyToolCall("tedix_mcp_code", args)).toBe("discovery");
	});

	it("tool names mentioned only in strings and comments are not execution", () => {
		const args = JSON.stringify({
			code: "async () => { // github_tedix.list_commits()\n return 'call github_tedix.get_commit() next'; }",
		});
		expect(classifyToolCall("tedix_mcp_code", args)).toBe("discovery");
	});

	it("a direct namespaced/bespoke tool is execution", () => {
		expect(classifyToolCall("github_tedix__list_commits", "{}")).toBe(
			"execution",
		);
	});
});

describe("hasExecutionEvidence", () => {
	const call = (
		name: string,
		ok: boolean,
		kind: TurnToolCall["kind"],
	): TurnToolCall => ({
		name,
		ok,
		kind,
	});

	it("discovery-only run has NO execution evidence", () => {
		expect(
			hasExecutionEvidence([
				call("tedix_mcp_search_tools", true, "discovery"),
				call("tedix_mcp_code", true, "discovery"),
			]),
		).toBe(false);
	});

	it("a SUCCESSFUL execution call is evidence", () => {
		expect(
			hasExecutionEvidence([
				call("tedix_mcp_search_tools", true, "discovery"),
				call("tedix_mcp_code", true, "execution"),
			]),
		).toBe(true);
	});

	it("a FAILED execution attempt is not evidence", () => {
		expect(
			hasExecutionEvidence([call("tedix_mcp_code", false, "execution")]),
		).toBe(false);
	});
});
