/**
 * The signed embedded callable allowlist stays bound end to end: from the DO
 * route into the turn binding, the prepared tool adapter, and Jev tool-fit
 * advice, which may shape the prompt but never the executable tool set. The
 * adapter's own allowlist enforcement is covered in ai-sdk-adapter.test.ts.
 */
import assert from "node:assert/strict";
import { chatTurnProbe, tediDo } from "../test/tedi-do";
import { embeddedUserText } from "./embedded-transcript";

const allowed = ["shop.list_orders", "shop.get_order"];

// --- the DO route carries the signed allowlist into the chat turn ---
{
	const received: Array<Record<string, unknown>> = [];
	const agent = tediDo({
		env: {},
		async ensureIdentity() {},
		async streamChatTurn(input: Record<string, unknown>) {
			received.push(input);
			return new Response("");
		},
	});
	await agent.onRequest(
		new Request("https://do.internal/__internal/chat/stream", {
			method: "POST",
			body: JSON.stringify({
				client_request_id: "req-1",
				session_key: "embed:host:1",
				text: "Which orders are overdue today?",
				tool_argument_constraints: { company_id: "8042" },
				tool_allowed_callables: allowed,
				tool_namespace_prefix: "shop",
			}),
		}),
	);
	assert.deepEqual(received[0]?.toolAllowedCallables, allowed);
	assert.deepEqual(received[0]?.toolArgumentConstraints, {
		company_id: "8042",
	});
}

// --- the turn binding, prepared tools and tool-fit advice share it ---
{
	const bindings: Array<Record<string, unknown>> = [];
	const ranked: Array<{ query: string; candidates: Array<{ id: string }> }> =
		[];
	const mcpRuntime = {
		bindTurn(binding: Record<string, unknown>) {
			bindings.push(binding);
		},
		clearTurn() {},
		getSystemInstructions: () => "MCP",
		getUtilitySystemInstructions: () => "MCP utility",
		async executeTool() {
			return { ok: true, result: [] };
		},
	};
	const platform = {
		setEpisodeTrace() {},
		async rankDiscovery(request: {
			query: string;
			candidates: Array<{ id: string }>;
		}) {
			ranked.push(request);
			return {
				rankedIds: ["shop.get_order", "shop.list_orders"],
				usagePersistence: "persisted",
				executionAttempts: [],
			};
		},
	};
	const probe = chatTurnProbe({
		mcpRuntime,
		platform,
		async facetTurn() {
			return { assistantText: "ok" };
		},
	});
	await probe.run({
		sessionKey: "embed:host:1",
		// Host page context follows the versioned user line and is never ranked.
		text: `${embeddedUserText("Which orders are overdue today?")}\n\nUntrusted host page signal:\n{"apiKey":"do not send"}`,
		toolArgumentConstraints: { company_id: "8042" },
		toolAllowedCallables: allowed,
	});
	assert.deepEqual(bindings[0]?.toolAllowedCallables, allowed);
	assert.equal(ranked[0]?.query, "Which orders are overdue today?");
	assert.equal(JSON.stringify(ranked).includes("apiKey"), false);
	assert.deepEqual(
		ranked[0]?.candidates.map((candidate) => candidate.id),
		allowed,
	);
	const facet = probe.facetInputs[0]!;
	assert.match(
		facet.system,
		/Likely matching admitted read tool: shop\.get_order/,
	);
	// Advice never changes the executable tool set: only the bound MCP adapter
	// tools reach an embedded turn, and no native tool family is added.
	const toolNames = Object.keys(facet.tools);
	assert.ok(toolNames.includes("tedix_mcp_call_tool"));
	assert.equal(toolNames.includes("tedix_mcp_code"), false);
	assert.equal(toolNames.includes("workspaceAiTools"), false);
}

// --- without a signed allowlist no advice is requested ---
{
	let ranked = 0;
	const probe = chatTurnProbe({
		mcpRuntime: {
			bindTurn() {},
			clearTurn() {},
			getSystemInstructions: () => "MCP",
		},
		platform: {
			setEpisodeTrace() {},
			async rankDiscovery() {
				ranked += 1;
				return {};
			},
		},
		async facetTurn() {
			return { assistantText: "ok" };
		},
	});
	await probe.run({
		text: embeddedUserText("Which orders are overdue today?"),
	});
	assert.equal(ranked, 0);
	assert.doesNotMatch(probe.facetInputs[0]!.system, /Likely matching/);
}

console.log("embedded assistant capabilities stay bound end-to-end");
