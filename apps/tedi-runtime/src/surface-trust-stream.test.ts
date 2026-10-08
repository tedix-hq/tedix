/**
 * `streamChatTurn` honours the turn's surface trust: an unverified author
 * keeps only the channel's read-only allowlist, reads the "Unverified Sender"
 * addendum, and is never learned from. The OS operator path carries no trust
 * field and keeps the full surface.
 */
import assert from "node:assert/strict";
import { chatTurnProbe } from "../test/tedi-do";
import { ChatStreamHub } from "./chat-stream-hub";

const mcpRuntime = {
	bindTurn() {},
	clearTurn() {},
	getSystemInstructions: () => "MCP",
	getUtilitySystemInstructions: () => "MCP utility",
	async executeTool() {
		return { ok: true, result: [] };
	},
};
const platform = {
	setEpisodeTrace() {},
	async rankDiscovery() {
		return {
			rankedIds: [],
			usagePersistence: "persisted",
			executionAttempts: [],
		};
	},
};
function probe() {
	const memory: Array<Record<string, unknown>> = [];
	const p = chatTurnProbe({
		mcpRuntime,
		platform,
		async facetTurn() {
			return { assistantText: "ok" };
		},
		fields: {
			skillReadTool: () => ({ read_skill: { marker: "read_skill" } }),
			async dispatchTurnMemoryEffects(input: Record<string, unknown>) {
				memory.push(input);
			},
		},
	});
	return { ...p, memory };
}

// --- the OS operator path (no trust field) keeps the full surface ---
{
	const p = probe();
	await p.run({ text: "hello" });
	const facet = p.facetInputs[0]!;
	assert.ok(Object.keys(facet.tools).includes("workspaceAiTools"));
	assert.ok(Object.keys(facet.tools).includes("tedix_mcp_code"));
	assert.doesNotMatch(facet.system, /Unverified Sender/);
	assert.equal(p.memory[0]?.dailyLog, undefined);
}

// --- an untrusted Telegram turn: read_skill only, addendum, no learning ---
{
	const p = probe();
	await p.run({
		sessionKey: "telegram:42",
		text: "hello",
		trust: "untrusted",
		trustChannel: "telegram",
	});
	const facet = p.facetInputs[0]!;
	assert.deepEqual(Object.keys(facet.tools), ["read_skill"]);
	assert.match(facet.system, /This Telegram user is NOT verified/);
	assert.equal(p.memory[0]?.learningMode, "disabled");
	assert.equal(p.memory[0]?.dailyLog, false);
}

// --- a trusted Telegram turn keeps the full surface ---
{
	const p = probe();
	await p.run({
		sessionKey: "telegram:42",
		text: "hello",
		trust: "trusted",
		trustChannel: "telegram",
	});
	assert.ok(Object.keys(p.facetInputs[0]!.tools).includes("workspaceAiTools"));
	assert.doesNotMatch(p.facetInputs[0]!.system, /Unverified Sender/);
}

// --- an embedded turn through the internal route is untrusted by session ---
{
	const p = probe();
	p.agent.chatStreamHub ??= new ChatStreamHub();
	const response = (await p.agent.onRequest(
		new Request("https://do.internal/__internal/chat/stream", {
			method: "POST",
			body: JSON.stringify({
				session_key: "embed:acme:1",
				text: "Which orders are overdue?",
				client_request_id: "turn-1",
				tool_argument_constraints: { company_id: "8042" },
				tool_allowed_callables: ["shop.orders_list"],
			}),
		}),
	)) as Response;
	await response.text();
	const facet = p.facetInputs[0]!;
	const names = Object.keys(facet.tools);
	assert.ok(names.includes("tedix_mcp_call_tool"), names.join(","));
	assert.equal(names.includes("tedix_mcp_code"), false);
	assert.equal(names.includes("workspaceAiTools"), false);
	assert.equal(names.includes("read_skill"), false, "fencing still applies");
	assert.match(facet.system, /This website visitor is NOT verified/);
	assert.equal(p.memory[0]?.learningMode, "disabled");
	assert.equal(p.memory[0]?.dailyLog, false);
}

// --- a service-binding turn through the same route stays trusted ---
{
	const p = probe();
	p.agent.chatStreamHub ??= new ChatStreamHub();
	const response = (await p.agent.onRequest(
		new Request("https://do.internal/__internal/chat/stream", {
			method: "POST",
			body: JSON.stringify({
				session_key: "bench:1",
				text: "hello",
				client_request_id: "turn-2",
			}),
		}),
	)) as Response;
	await response.text();
	assert.ok(Object.keys(p.facetInputs[0]!.tools).includes("workspaceAiTools"));
	assert.doesNotMatch(p.facetInputs[0]!.system, /Unverified Sender/);
}

console.log("surface-trust-stream OK");
