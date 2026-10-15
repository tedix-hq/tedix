import assert from "node:assert/strict";
import type { ToolSet } from "ai";
import { noFundsTurnTools } from "./no-funds-turn";
import { buildFacetWorkflowTurnInput } from "./chat-turn-input";
import { mcpFacetTurnProbe, MCP_FACET_TURN_INPUT } from "../test/tedi-do";

const tools = Object.fromEntries(
	[
		"read_skill",
		"create_payment",
		"provider__createCharge",
		"wallet-transfer-funds",
		"tedix_mcp_code",
		"run_skill_workflow",
		"browser",
		"exec",
		"new_tool",
		"create_checkout",
		"create_subscription",
		"get_wallet",
		"list_payments",
		"create_payment_method",
	].map((name) => [name, {}]),
) as ToolSet;
assert.equal(noFundsTurnTools(tools), tools);
assert.deepEqual(Object.keys(noFundsTurnTools(tools, true)), [
	"read_skill",
	"tedix_mcp_code",
	"run_skill_workflow",
	"browser",
	"exec",
	"new_tool",
	"create_checkout",
	"create_subscription",
	"get_wallet",
	"list_payments",
	"create_payment_method",
]);
const input = buildFacetWorkflowTurnInput(
	{
		...MCP_FACET_TURN_INPUT,
		userText: "Pay using Stripe",
		userTs: 1,
		clientRequestId: "request-1",
		noFunds: true,
	},
	2,
);
assert.equal(
	input.noFunds,
	true,
	"durable retries and continuations retain the ceiling",
);
const probe = mcpFacetTurnProbe({
	fields: { skillReadTool: () => ({ read_skill: {} }) },
});
const restricted = await probe.prepareMcpFacetTurn({
	...MCP_FACET_TURN_INPUT,
	noFunds: true,
});
assert.ok("read_skill" in restricted.tools);
assert.ok("workspaceAiTools" in restricted.tools);
assert.match(restricted.system, /cannot move funds/);
const normal = await probe.prepareMcpFacetTurn(MCP_FACET_TURN_INPUT);
assert.ok("workspaceAiTools" in normal.tools);
console.log("PASS: no-funds turn ceiling and durable propagation");
