import assert from "node:assert/strict";
import { tool, type Tool, type ToolSet } from "ai";
import * as z from "zod";
import type { DelegationCapabilityPlan } from "@tedix/api-contract/schemas/kernel-runtime";
import {
	capabilityPlanForMetadata,
	capabilityToolSet,
} from "./delegation-capabilities";
import {
	restrictDelegatedToolSet,
	evaluateDelegatedFacetTool,
} from "./delegation-authority";

const page: DelegationCapabilityPlan = {
	version: "delegation-capabilities.v1",
	requiredCapabilities: ["page.read"],
	allowedToolIds: ["browser_markdown", "browser_read_result"],
	urls: ["https://example.com/article"],
	outputIds: [],
	missingCapabilities: [],
};
let calls = 0;
const definition = tool({
	inputSchema: z.record(z.string(), z.unknown()),
	execute: async () => {
		calls++;
		return "Fetched source: example.com/article";
	},
});
const tools: ToolSet = Object.fromEntries(
	[
		"browser_markdown",
		"browser_read_result",
		"browser_execute",
		"exec",
		"tedix_mcp_code",
		"tedix_mcp_search_tools",
		"tedix_mcp_call_tool",
		"mcp_read_result",
	].map((name) => [name, definition]),
);
const evaluations: boolean[] = [];
const narrowed = capabilityToolSet({
	tools,
	plan: page,
	onEvaluation: async (event) => {
		evaluations.push(event.allowed);
	},
}) as Record<string, Tool<Record<string, unknown>, unknown>>;
const options = { toolCallId: "acme-call", messages: [], context: undefined };
assert.deepEqual(Object.keys(narrowed).sort(), [
	"browser_markdown",
	"browser_read_result",
]);
assert.equal(
	await narrowed.browser_markdown!.execute!({ url: page.urls[0] }, options),
	"Fetched source: example.com/article",
);
await assert.rejects(
	async () =>
		narrowed.browser_markdown!.execute!(
			{ url: "https://other.example/tenant-secret" },
			options,
		),
	/outside the delegated request/,
);
assert.equal(calls, 1);
assert.deepEqual(evaluations, [true, false]);
assert.deepEqual(restrictDelegatedToolSet(narrowed, undefined, "enforce"), {});
assert.throws(
	() => capabilityToolSet({ tools: {}, plan: page }),
	/tool unavailable/,
);
assert.throws(
	() =>
		capabilityToolSet({
			tools,
			plan: { ...page, missingCapabilities: ["unknown.read"] },
		}),
	/capability gap/,
);
assert.throws(() =>
	capabilityPlanForMetadata({ delegationWorkOrder: { capabilityPlan: {} } }),
);
assert.deepEqual(
	capabilityPlanForMetadata({ delegationWorkOrder: { capabilityPlan: page } }),
	page,
);

const output: DelegationCapabilityPlan = {
	...page,
	requiredCapabilities: ["output.read"],
	allowedToolIds: ["acme_os.get_os_output"],
	urls: [],
	outputIds: ["11111111-1111-4111-8111-111111111111"],
};
const provider = capabilityToolSet({ tools, plan: output }) as Record<
	string,
	Tool<Record<string, unknown>, unknown>
>;
assert.equal(provider.tedix_mcp_code, undefined);
await assert.rejects(
	async () =>
		provider.tedix_mcp_call_tool!.execute!(
			{
				callable: "acme_os.update_os_output",
				args: { outputId: output.outputIds[0] },
			},
			options,
		),
	/outside the capability plan/,
);
await assert.rejects(
	async () =>
		provider.tedix_mcp_call_tool!.execute!(
			{
				callable: "acme_os.get_os_output",
				args: { outputId: "22222222-2222-4222-8222-222222222222" },
			},
			options,
		),
	/Output is outside/,
);
await provider.tedix_mcp_call_tool!.execute!(
	{
		callable: "acme_os.get_os_output",
		args: { outputId: output.outputIds[0] },
	},
	options,
);
assert.equal(calls, 2);
await assert.rejects(
	async () =>
		provider.tedix_mcp_search_tools!.execute!(
			{ query: "billing mutation" },
			options,
		),
	/Discovery is outside/,
);
await provider.tedix_mcp_search_tools!.execute!(
	{ query: "acme_os.get_os_output" },
	options,
);
const envelope = {
	version: "earned-delegation.v1" as const,
	grantId: "acme-grant",
	grantRevision: 1,
	decisionId: "acme-decision",
	activityId: "acme-read",
	activityVersion: 1,
	taskFamily: "output.read",
	riskLevel: "low" as const,
	environment: "test",
	allowedToolIds: output.allowedToolIds,
	expiresAt: null,
};
assert.equal(
	evaluateDelegatedFacetTool({
		envelope,
		mode: "enforce",
		tool: "tedix_mcp_search_tools",
		args: { query: "acme_os.get_os_output" },
	}).allowed,
	true,
);
assert.equal(
	evaluateDelegatedFacetTool({
		envelope,
		mode: "enforce",
		tool: "tedix_mcp_search_tools",
		args: { query: "billing mutation" },
	}).allowed,
	false,
);
assert.equal(
	evaluateDelegatedFacetTool({
		envelope: { ...envelope, expiresAt: "2020-01-01T00:00:00Z" },
		mode: "enforce",
		tool: "tedix_mcp_search_tools",
		args: { query: "acme_os.get_os_output" },
	}).allowed,
	false,
);
assert.equal(
	restrictDelegatedToolSet(provider, envelope, "enforce").tedix_mcp_code,
	undefined,
);
console.log("delegation capability boundary tests passed");
